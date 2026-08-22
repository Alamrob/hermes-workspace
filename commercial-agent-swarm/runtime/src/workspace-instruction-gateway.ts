import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { constantTimeSecretEqual } from './security.js'

const MODEL_ID = 'commercial-instruction-inbox'
const MAX_REQUEST_BYTES = 65_536
const MAX_BROKER_BYTES = 8_192

export interface WorkspaceInstructionGatewayOptions {
  host: string
  port: number
  workspaceBearer: string
  brokerBearer: string
  brokerBase: 'http://broker:8080'
  requestedBy: string
  now?: () => Date
  fetch?: typeof globalThis.fetch
}

export function createWorkspaceInstructionGateway(
  options: WorkspaceInstructionGatewayOptions,
) {
  validateOptions(options)
  const now = options.now ?? (() => new Date())
  const requestFetch = options.fetch ?? globalThis.fetch
  const server = createServer((request, response) => {
    void handle(request, response, options, now, requestFetch).catch(() =>
      json(response, 500, { error: 'internal_error' }),
    )
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 5_000
  server.keepAliveTimeout = 2_000
  server.maxHeadersCount = 32
  return server
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceInstructionGatewayOptions,
  now: () => Date,
  requestFetch: typeof globalThis.fetch,
): Promise<void> {
  secureHeaders(response)
  const path = new URL(request.url ?? '/', 'http://workspace-gateway.local').pathname
  if (request.method === 'GET' && path === '/health')
    return json(response, 200, { status: 'ok', platform: 'proptimiza-instruction-inbox' })
  if (!authorized(request.headers.authorization, options.workspaceBearer))
    return json(response, 401, { error: 'unauthorized' })
  if (request.method === 'GET' && path === '/v1/models')
    return json(response, 200, {
      object: 'list',
      data: [{ id: MODEL_ID, object: 'model', owned_by: 'proptimiza-control-plane' }],
    })
  if (path === '/v1/chat/completions' && request.method === 'GET') {
    response.setHeader('allow', 'POST')
    return json(response, 405, { error: 'method_not_allowed' })
  }
  if (path !== '/v1/chat/completions' || request.method !== 'POST')
    return json(response, 404, { error: 'not_found' })
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
    return json(response, 415, { error: 'unsupported_media_type' })

  let raw: Buffer
  try {
    raw = await boundedBody(request, MAX_REQUEST_BYTES)
  } catch (error) {
    return json(response, error instanceof PayloadTooLargeError ? 413 : 400, {
      error: error instanceof PayloadTooLargeError ? 'payload_too_large' : 'invalid_body',
    })
  }
  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return json(response, 400, { error: 'invalid_json' })
  }
  const parsed = parseChatRequest(body)
  if (!parsed) return json(response, 400, { error: 'invalid_chat_request' })

  const sessionId = header(request.headers['x-claude-session-id']) ?? 'no-session'
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(sessionId))
    return json(response, 400, { error: 'invalid_session' })
  const digest = createHash('sha256')
    .update(`${options.requestedBy}\u0000${sessionId}\u0000${parsed.instruction}`, 'utf8')
    .digest('hex')
  const created = now()
  const requestId = uuidFromDigest(digest)
  const brokerResponse = await requestFetch(`${options.brokerBase}/v1/instruction-requests`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.brokerBearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      request_id: requestId,
      idempotency_key: `workspace:${digest}`,
      project_id: 'proptimiza',
      title: titleFromInstruction(parsed.instruction),
      instruction: parsed.instruction,
      requested_by: options.requestedBy,
      source: 'workspace',
      autonomy_ceiling: 'A0',
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + 7 * 86_400_000).toISOString(),
      requires_codex_review: true,
      external_actions_allowed: false,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const brokerBody = await boundedResponse(brokerResponse, MAX_BROKER_BYTES)
  if (!brokerResponse.ok) {
    const status = brokerResponse.status >= 400 && brokerResponse.status < 500 ? 400 : 503
    return json(response, status, { error: status === 400 ? 'instruction_rejected' : 'control_plane_unavailable' })
  }
  const brokerResult = parseBrokerResult(brokerBody, requestId)
  if (!brokerResult) return json(response, 503, { error: 'control_plane_invalid_response' })
  const acknowledgement =
    `Instrucción registrada para revisión de Codex. Solicitud ${brokerResult.requestId}. ` +
    'No se ejecutó ninguna acción externa ni se creó una misión comercial.'
  return parsed.stream
    ? streamCompletion(response, acknowledgement, brokerResult.requestId, created)
    : json(response, 200, completion(acknowledgement, brokerResult.requestId, created))
}

function parseChatRequest(value: unknown): { instruction: string; stream: boolean } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const allowed = new Set(['model', 'messages', 'stream', 'temperature'])
  if (Object.keys(record).some((key) => !allowed.has(key))) return null
  if (record.model !== MODEL_ID || typeof record.stream !== 'boolean') return null
  if (record.temperature !== undefined &&
      (typeof record.temperature !== 'number' || !Number.isFinite(record.temperature) || record.temperature < 0 || record.temperature > 2))
    return null
  if (!Array.isArray(record.messages) || record.messages.length < 1 || record.messages.length > 64)
    return null
  let instruction = ''
  for (const item of record.messages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const message = item as Record<string, unknown>
    if (!['system', 'user', 'assistant'].includes(String(message.role))) return null
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') instruction = message.content.trim()
    else if (Array.isArray(message.content)) {
      const text: string[] = []
      for (const part of message.content) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return null
        const content = part as Record<string, unknown>
        if (content.type === 'text' && typeof content.text === 'string') text.push(content.text)
        else if (content.type !== 'image_url') return null
      }
      instruction = text.join('\n').trim()
    } else return null
  }
  if (instruction.length < 1 || instruction.length > 8_000 || instruction.includes('\u0000'))
    return null
  return { instruction, stream: record.stream }
}

function completion(content: string, requestId: string, created: Date) {
  return {
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion',
    created: Math.floor(created.getTime() / 1_000),
    model: MODEL_ID,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }
}

function streamCompletion(response: ServerResponse, content: string, requestId: string, created: Date) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  })
  const common = {
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion.chunk',
    created: Math.floor(created.getTime() / 1_000),
    model: MODEL_ID,
  }
  response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function validateOptions(options: WorkspaceInstructionGatewayOptions) {
  if (options.host !== '0.0.0.0' || options.port !== 8642)
    throw new Error('WORKSPACE_GATEWAY_LISTENER_INVALID')
  for (const secret of [options.workspaceBearer, options.brokerBearer])
    if (secret.length < 32 || secret.length > 4_096 || /\s/.test(secret))
      throw new Error('WORKSPACE_GATEWAY_SECRET_INVALID')
  if (constantTimeSecretEqual(options.workspaceBearer, options.brokerBearer))
    throw new Error('WORKSPACE_GATEWAY_SECRET_REUSE')
  if (options.brokerBase !== 'http://broker:8080') throw new Error('WORKSPACE_GATEWAY_BROKER_INVALID')
  if (!/^[A-Za-z0-9._:@+-]{3,254}$/.test(options.requestedBy))
    throw new Error('WORKSPACE_GATEWAY_REQUESTER_INVALID')
}

async function boundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (!Number.isFinite(declared) || declared < 0 || declared > maximum) throw new PayloadTooLargeError()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maximum) throw new PayloadTooLargeError()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function boundedResponse(response: Response, maximum: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('BROKER_RESPONSE_INVALID')
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximum) {
      await reader.cancel()
      throw new Error('BROKER_RESPONSE_OVERSIZED')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function parseBrokerResult(raw: Buffer, expectedRequestId: string): { requestId: string } | null {
  try {
    const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    if (value.request_id !== expectedRequestId || value.status !== 'pending_codex_review' ||
        value.requires_codex_review !== true || value.external_actions_allowed !== false)
      return null
    return { requestId: expectedRequestId }
  } catch {
    return null
  }
}

function titleFromInstruction(instruction: string): string {
  const title = instruction.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return title.slice(0, 160) || 'Nueva instrucción comercial'
}

function uuidFromDigest(digest: string): string {
  const hex = digest.slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function authorized(value: string | undefined, expected: string): boolean {
  const token = value?.match(/^Bearer ([^\s]+)$/)?.[1]
  return token !== undefined && constantTimeSecretEqual(token, expected)
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function secureHeaders(response: ServerResponse) {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
}

function json(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent) return
  const encoded = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': encoded.length,
  })
  response.end(encoded)
}

class PayloadTooLargeError extends Error {}
