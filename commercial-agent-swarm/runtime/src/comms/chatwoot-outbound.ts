import { createHash, createHmac, randomBytes } from 'node:crypto'
import { request, type Dispatcher } from 'undici'

const DECIMAL = /^[1-9][0-9]{0,18}$/
const SHA256 = /^[0-9a-f]{64}$/
const SESSION_GAP_SECONDS = 24 * 60 * 60
export const CHATWOOT_OWNED_OPERATIONAL_LABELS = Object.freeze([
  'proptimiza-human-handoff',
  'proptimiza-supervised-review',
] as const)
export type ChatwootOwnedOperationalLabel = typeof CHATWOOT_OWNED_OPERATIONAL_LABELS[number]

export interface ChatwootTranscriptMessage {
  message_id: string
  sequence: number
  kind: 'incoming' | 'assistant'
  content: string
}

export interface ChatwootConversationSnapshot {
  target: Readonly<ChatwootTranscriptMessage>
  transcript: ReadonlyArray<Readonly<ChatwootTranscriptMessage>>
  latest_message_id: string
  current: boolean
  human_replied: boolean
}

interface ChatwootReadClientOptions {
    baseUrl: string
    accountId: string
    inboxId: string
    readToken: () => Promise<string>
    machineSecret: () => Promise<string>
    nowSeconds?: () => number
    nonce?: () => string
    requestTimeoutMs?: number
    dispatcher?: Dispatcher
    automationRole?: 'responder' | 'reviewer'
}

export class ChatwootReadClient {
  constructor(protected readonly options: ChatwootReadClientOptions) {
    const url = new URL(options.baseUrl)
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !/^proptimiza-chatwoot-web-1(?::3000)?$/.test(url.host)
      || !DECIMAL.test(options.accountId) || !DECIMAL.test(options.inboxId)
      || !['responder', 'reviewer'].includes(options.automationRole ?? 'responder'))
      throw new Error('CHATWOOT_OUTBOUND_CONFIG_INVALID')
  }

  async snapshot(conversationId: string, messageId: string, expectedContentSha256: string): Promise<ChatwootConversationSnapshot> {
    decimal(conversationId); decimal(messageId)
    if (!/^[0-9a-f]{64}$/.test(expectedContentSha256)) throw new Error('CHATWOOT_OUTBOUND_INPUT_INVALID')
    const token = await this.options.readToken()
    const body = await this.call('GET', `/api/v1/accounts/${this.options.accountId}/conversations/${conversationId}/messages`, token)
    const object = record(body)
    const rawMessages = Array.isArray(object.payload) ? object.payload : Array.isArray(body) ? body : null
    if (!rawMessages || rawMessages.length > 200) throw new Error('CHATWOOT_MESSAGES_INVALID')
    const observed = rawMessages.map(parseObservedMessage).filter((entry): entry is ObservedMessage => entry !== null)
      .sort((a, b) => compareDecimal(a.message_id, b.message_id))
    const target = observed.find((entry) => entry.message_id === messageId && entry.kind === 'incoming')?.transcript
    if (!target || digest(target.content) !== expectedContentSha256) throw new Error('CHATWOOT_TARGET_MESSAGE_INVALID')
    const later = observed.filter((entry) => compareDecimal(entry.message_id, messageId) > 0)
    const latest = observed.at(-1)
    const transcriptEntries = latestConversationSegment(observed.filter((entry) => entry.transcript !== null))
    const transcript = transcriptEntries.map((entry) => entry.transcript!)
    return Object.freeze({
      target: Object.freeze({ ...target }),
      transcript: Object.freeze(transcript.slice(-20).map((entry) => Object.freeze({ ...entry }))),
      latest_message_id: latest?.message_id ?? messageId,
      current: later.length === 0,
      // A new customer turn reopens automation. A human response after the
      // target message still wins, including one that arrives during inference.
      human_replied: later.some((entry) => entry.kind === 'assistant' && entry.sender_type === 'User'),
    })
  }

  protected async call(method: 'GET' | 'POST', path: string, token: string, json?: Record<string, unknown>): Promise<unknown> {
    if (!token || token.length > 8192 || token.includes('\0')) throw new Error('CHATWOOT_TOKEN_INVALID')
    const secret = await this.options.machineSecret()
    if (secret.length < 32 || secret.length > 4096 || secret.includes('\0'))
      throw new Error('CHATWOOT_MACHINE_SECRET_INVALID')
    const timestamp = Math.floor((this.options.nowSeconds ?? (() => Date.now() / 1000))())
    const nonce = (this.options.nonce ?? (() => randomBytes(16).toString('hex')))()
    if (!Number.isSafeInteger(timestamp) || timestamp < 1 || !/^[0-9a-f]{32}$/.test(nonce))
      throw new Error('CHATWOOT_MACHINE_ENVELOPE_INVALID')
    const body = json ? JSON.stringify(json) : ''
    const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex')
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
    const signature = 'sha256=' + createHmac('sha256', secret)
      .update(`${timestamp}.${nonce}.${method}.${path}.${bodyHash}.${tokenHash}`, 'utf8').digest('hex')
    const response = await request(new URL(path, this.options.baseUrl), {
      method,
      headers: {
        api_access_token: token,
        accept: 'application/json',
        'x-forwarded-proto': 'https',
        'x-proptimiza-automation-timestamp': String(timestamp),
        'x-proptimiza-automation-nonce': nonce,
        'x-proptimiza-automation-signature': signature,
        ...(this.options.automationRole === 'reviewer' ? { 'x-proptimiza-automation-role': 'reviewer' } : {}),
        ...(json ? { 'content-type': 'application/json' } : {}),
      },
      body: body || undefined,
      dispatcher: this.options.dispatcher,
      headersTimeout: this.options.requestTimeoutMs ?? 10_000,
      bodyTimeout: this.options.requestTimeoutMs ?? 10_000,
    })
    const text = await response.body.text()
    if (Buffer.byteLength(text, 'utf8') > 1_048_576) throw new Error('CHATWOOT_RESPONSE_TOO_LARGE')
    if (response.statusCode < 200 || response.statusCode >= 300)
      throw new ChatwootHttpError(response.statusCode)
    try { return JSON.parse(text) } catch { throw new Error('CHATWOOT_RESPONSE_INVALID') }
  }
}

export class ChatwootOutboundClient extends ChatwootReadClient {
  private readonly sendToken: () => Promise<string>

  constructor(options: ChatwootReadClientOptions & { sendToken: () => Promise<string> }) {
    super(options)
    this.sendToken = options.sendToken
  }

  async send(conversationId: string, content: string): Promise<{ message_id: string }> {
    decimal(conversationId)
    if (typeof content !== 'string' || !content.trim() || content.includes('\0')
      || Buffer.byteLength(content, 'utf8') > 2000) throw new Error('CHATWOOT_REPLY_INVALID')
    const token = await this.sendToken()
    const response = record(await this.call('POST',
      `/api/v1/accounts/${this.options.accountId}/conversations/${conversationId}/messages`, token, {
        content,
        message_type: 'outgoing',
        private: false,
        content_type: 'text',
      }))
    const id = normalizeId(response.id)
    return Object.freeze({ message_id: id })
  }

  async assignTeam(conversationId: string, teamId: string): Promise<{ team_id: string }> {
    decimal(conversationId); decimal(teamId)
    const token = await this.options.readToken()
    const path = `/api/v1/accounts/${this.options.accountId}/conversations/${conversationId}/assignments`
    const response = record(await this.call('POST', path, token, { team_id: Number(teamId) }))
    const id = normalizeId(response.id)
    if (id !== teamId) throw new Error('CHATWOOT_TEAM_ASSIGNMENT_INVALID')
    return Object.freeze({ team_id: id })
  }

}

export class ChatwootReviewClient extends ChatwootReadClient {
  constructor(options: Omit<ChatwootReadClientOptions, 'automationRole'>) {
    super({ ...options, automationRole: 'reviewer' })
  }

  async createPrivateNote(conversationId: string, content: string): Promise<{ message_id: string }> {
    decimal(conversationId)
    if (typeof content !== 'string' || !content.trim() || content.includes('\0')
      || Buffer.byteLength(content, 'utf8') > 2000) throw new Error('CHATWOOT_REVIEW_NOTE_INVALID')
    const response = record(await this.call('POST',
      `/api/v1/accounts/${this.options.accountId}/conversations/${conversationId}/messages`,
      await this.options.readToken(), {
        content,
        message_type: 'outgoing',
        private: true,
        content_type: 'text',
      }))
    return Object.freeze({ message_id: normalizeId(response.id) })
  }

  async assignTeam(conversationId: string, teamId: string): Promise<{ team_id: string }> {
    decimal(conversationId); decimal(teamId)
    const response = record(await this.call('POST',
      `/api/v1/accounts/${this.options.accountId}/conversations/${conversationId}/assignments`,
      await this.options.readToken(), { team_id: Number(teamId) }))
    const id = normalizeId(response.id)
    if (id !== teamId) throw new Error('CHATWOOT_TEAM_ASSIGNMENT_INVALID')
    return Object.freeze({ team_id: id })
  }

  async ownedLabelState(conversationId: string): Promise<{ owned_labels_sha256: string }> {
    decimal(conversationId)
    const path = `/api/v1/accounts/${this.options.accountId}/conversations/${conversationId}/labels`
    return ownedLabelReceipt(await this.call('GET', path, await this.options.readToken()))
  }

  async mergeOwnedLabels(
    conversationId: string,
    add: readonly ChatwootOwnedOperationalLabel[],
    remove: readonly ChatwootOwnedOperationalLabel[],
    expectedOwnedLabelsSha256: string,
  ): Promise<{ owned_labels_sha256: string }> {
    decimal(conversationId)
    const added = ownedLabelList(add)
    const removed = ownedLabelList(remove)
    if (added.length + removed.length < 1 || added.some(label => removed.includes(label))
      || !SHA256.test(expectedOwnedLabelsSha256)) throw new Error('CHATWOOT_REVIEW_LABEL_DELTA_INVALID')
    const path = `/api/v1/accounts/${this.options.accountId}/conversations/${conversationId}/labels`
    return ownedLabelReceipt(await this.call('POST', path, await this.options.readToken(), {
      add: added,
      remove: removed,
      expected_owned_labels_sha256: expectedOwnedLabelsSha256,
    }))
  }
}

export class ChatwootHttpError extends Error {
  constructor(readonly status: number) { super('CHATWOOT_HTTP_ERROR'); this.name = 'ChatwootHttpError' }
}

interface ObservedMessage {
  message_id: string
  kind: 'incoming' | 'assistant'
  sender_type: string | null
  occurred_at: number | null
  transcript: ChatwootTranscriptMessage | null
}

function parseObservedMessage(value: unknown): ObservedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.private === true) return null
  const id = normalizeId(input.id)
  const rawType = input.message_type
  const kind: 'incoming' | 'assistant' | null = rawType === 0 || rawType === 'incoming' ? 'incoming'
    : rawType === 1 || rawType === 'outgoing' ? 'assistant' : null
  if (!kind) return null
  const numeric = Number(id)
  if (!Number.isSafeInteger(numeric)) throw new Error('CHATWOOT_MESSAGE_ID_UNSAFE')
  const senderType = typeof input.sender_type === 'string' ? input.sender_type : null
  const trustedTranscriptSender = kind === 'incoming' ? senderType === 'Contact'
    : senderType === 'AgentBot' || senderType === 'User'
  const transcript = trustedTranscriptSender && typeof input.content === 'string' && input.content.trim()
    && !input.content.includes('\0') && Buffer.byteLength(input.content, 'utf8') <= 4096
    ? { message_id: id, sequence: numeric, kind, content: input.content }
    : null
  return {
    message_id: id, kind, sender_type: senderType, occurred_at: observedTimestamp(input.created_at), transcript,
  }
}

function latestConversationSegment(entries: ObservedMessage[]): ObservedMessage[] {
  let start = 0
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!.occurred_at
    const current = entries[index]!.occurred_at
    if (previous !== null && current !== null && current - previous > SESSION_GAP_SECONDS) start = index
  }
  return entries.slice(start)
}

function observedTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value !== 'string') return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CHATWOOT_RESPONSE_INVALID')
  return value as Record<string, unknown>
}
function ownedLabelList(value: readonly ChatwootOwnedOperationalLabel[]): ChatwootOwnedOperationalLabel[] {
  if (!Array.isArray(value) || value.length > CHATWOOT_OWNED_OPERATIONAL_LABELS.length
    || value.some(label => !CHATWOOT_OWNED_OPERATIONAL_LABELS.includes(label)))
    throw new Error('CHATWOOT_REVIEW_LABEL_DELTA_INVALID')
  const labels = [...new Set(value)].sort()
  if (labels.length !== value.length) throw new Error('CHATWOOT_REVIEW_LABEL_DELTA_INVALID')
  return labels
}
function ownedLabelReceipt(value: unknown): Readonly<{ owned_labels_sha256: string }> {
  const input = record(value)
  if (Object.keys(input).length !== 1 || typeof input.owned_labels_sha256 !== 'string'
    || !SHA256.test(input.owned_labels_sha256))
    throw new Error('CHATWOOT_REVIEW_LABEL_RECEIPT_INVALID')
  return Object.freeze({ owned_labels_sha256: input.owned_labels_sha256 })
}
export function chatwootOwnedLabelsSha256(labels: readonly ChatwootOwnedOperationalLabel[]): string {
  return createHash('sha256').update(JSON.stringify(ownedLabelList(labels)), 'utf8').digest('hex')
}
export function chatwootOwnedLabelsForSha256(sha256: string): readonly ChatwootOwnedOperationalLabel[] | null {
  if (!SHA256.test(sha256)) return null
  const values: readonly (readonly ChatwootOwnedOperationalLabel[])[] = [
    [],
    ['proptimiza-human-handoff'],
    ['proptimiza-supervised-review'],
    CHATWOOT_OWNED_OPERATIONAL_LABELS,
  ]
  const match = values.find(labels => chatwootOwnedLabelsSha256(labels) === sha256)
  return match ? Object.freeze([...match]) : null
}
function normalizeId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof id !== 'string' || !DECIMAL.test(id)) throw new Error('CHATWOOT_ID_INVALID')
  return id
}
function decimal(value: string): void { if (!DECIMAL.test(value)) throw new Error('CHATWOOT_ID_INVALID') }
function compareDecimal(a: string, b: string): number {
  const left = BigInt(a), right = BigInt(b)
  return left < right ? -1 : left > right ? 1 : 0
}
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
