import type { IncomingMessage, ServerResponse } from 'node:http'
import { ChatwootWebhookError, type ChatwootIncomingEvent, type createChatwootWebhookAdapter } from './chatwoot-webhook.js'
import type { DeepReadonly, PlatformContext } from '../platform/types.js'

export interface ChatwootIngressRoute {
  path: string
  adapter: ReturnType<typeof createChatwootWebhookAdapter>
  /** Resolve only after the durable transaction commits. A timeout must be retried idempotently. */
  commit(context: DeepReadonly<PlatformContext>, event: DeepReadonly<ChatwootIncomingEvent>): Promise<{
    event_id: string; outcome: 'inserted' | 'duplicate'
  }>
}
class RequestError extends Error {
  constructor(readonly status: number) { super('CHATWOOT_REQUEST_REJECTED') }
}

/** No listener or outbound client: the host chooses its isolated bind address and lifecycle. */
export function createChatwootIngressHandler(routes: readonly ChatwootIngressRoute[], options: {
  maxBodyBytes?: number; bodyTimeoutMs?: number; acknowledgeUnsupportedEvents?: boolean
} = {}) {
  const maximum = options.maxBodyBytes ?? 131072
  const timeout = options.bodyTimeoutMs ?? 5000
  if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > 1048576
    || !Number.isSafeInteger(timeout) || timeout < 10 || timeout > 30000 || !Array.isArray(routes) || routes.length === 0) throw new Error('INVALID_INGRESS_CONFIG')
  const configured = new Map<string, ChatwootIngressRoute>()
  for (const route of routes) {
    if (!/^\/webhooks\/chatwoot\/[a-z0-9_-]{1,128}$/.test(route.path) || configured.has(route.path)
      || typeof route.commit !== 'function' || typeof route.adapter?.verify !== 'function') throw new Error('INVALID_INGRESS_CONFIG')
    configured.set(route.path, Object.freeze({ ...route }))
  }
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // An aborted IncomingMessage may emit error after the bounded reader removes its listeners.
    // Keep a request-local guard; the reader still reports its own failure and no commit is issued.
    request.on('error', () => {})
    try {
      if (request.method !== 'POST') throw new RequestError(405)
      const route = configured.get(request.url ?? '')
      if (!route) throw new RequestError(404)
      const contentType = oneHeader(request, 'content-type')
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType ?? '')) throw new RequestError(415)
      const encoding = oneHeader(request, 'content-encoding')
      if (encoding !== undefined && encoding.toLowerCase() !== 'identity') throw new RequestError(415)
      const signature = oneHeader(request, 'x-chatwoot-signature')
      const timestamp = oneHeader(request, 'x-chatwoot-timestamp')
      const length = oneHeader(request, 'content-length')
      if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > maximum)) throw new RequestError(413)
      const rawBody = await readBoundedBody(request, maximum, timeout)
      const verified = route.adapter.verify({ rawBody, signature, timestamp })
      const receipt = await route.commit(verified.context, verified.event)
      if (!receipt || receipt.event_id !== verified.event.event_id || !['inserted', 'duplicate'].includes(receipt.outcome)) throw new Error('DURABLE_RECEIPT_MISMATCH')
      reply(response, receipt.outcome === 'inserted' ? 202 : 200, {
        event_id: receipt.event_id, outcome: receipt.outcome, trace_id: verified.event.trace_id,
      })
    } catch (error) {
      request.resume()
      const ignored = options.acknowledgeUnsupportedEvents === true
        && error instanceof ChatwootWebhookError && error.code === 'WEBHOOK_EVENT_UNSUPPORTED'
      if (ignored) {
        reply(response, 200, { outcome: 'ignored' })
        return
      }
      const status = error instanceof RequestError ? error.status
        : error instanceof ChatwootWebhookError ? webhookStatus(error.code) : 503
      // No payload, DB errors, secrets, stack or provider-supplied identifiers in an error response.
      reply(response, status, { error: status === 503 ? 'temporarily_unavailable' : 'request_rejected' })
    }
  }
}

function oneHeader(request: IncomingMessage, wanted: string): string | undefined {
  const values: string[] = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === wanted) values.push(request.rawHeaders[index + 1] ?? '')
  }
  if (values.length > 1) throw new RequestError(400)
  return values[0]
}
function webhookStatus(code: string): number {
  if (code === 'WEBHOOK_AUTH_INVALID' || code === 'WEBHOOK_TIMESTAMP_INVALID') return 401
  if (code === 'WEBHOOK_BINDING_MISMATCH') return 403
  if (code === 'WEBHOOK_BODY_SIZE') return 413
  if (code === 'WEBHOOK_EVENT_UNSUPPORTED') return 422
  if (code === 'WEBHOOK_CLOCK_INVALID' || code === 'INVALID_WEBHOOK_CONFIG') return 503
  return 400
}
function reply(response: ServerResponse, status: number, body: Record<string, string>) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}
function readBoundedBody(request: IncomingMessage, maximum: number, timeout: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    const cleanup = () => {
      clearTimeout(timer)
      request.off('data', data)
      request.off('end', end)
      request.off('error', error)
      request.off('aborted', aborted)
    }
    const fail = (status: number) => { cleanup(); chunks.length = 0; reject(new RequestError(status)) }
    const data = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) { fail(400); return }
      length += chunk.length
      if (length > maximum) { fail(413); return }
      chunks.push(chunk)
    }
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, length)) }
    const error = () => fail(400)
    const aborted = () => fail(400)
    const timer = setTimeout(() => fail(408), timeout)
    request.on('data', data)
    request.once('end', end)
    request.once('error', error)
    request.once('aborted', aborted)
  })
}
