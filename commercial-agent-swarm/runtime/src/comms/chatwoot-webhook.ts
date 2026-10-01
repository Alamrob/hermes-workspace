import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalJson } from '../canonical.js'
import type { AuthenticatedSource, DeepReadonly, PlatformAdmission, PlatformContext } from '../platform/types.js'
import { freezeDeep, snapshotJson } from '../platform/validation.js'

export class ChatwootWebhookError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ChatwootWebhookError' }
}
function fail(code: string): never { throw new ChatwootWebhookError(code) }

export interface ChatwootIncomingEvent {
  schema_version: 'platform-chatwoot-incoming.v1'
  event_id: string
  tenant_id: string
  deployment_id: string
  connector_id: string
  account_id: string
  inbox_id: string
  conversation_id: string
  message_id: string
  correlation_id: string
  causation_id: string
  trace_id: string
  occurred_at: string
  received_at: string
  data_classification: 'restricted_external'
  instruction_eligible: false
  content: { trust: 'untrusted_data'; text: string }
  semantic_sha256: string
  raw_sha256: string
}
export interface ChatwootWebhookOptions {
  admission: PlatformAdmission
  /** Trusted boot configuration for one authenticated webhook route. Never take this from the body. */
  source: AuthenticatedSource
  /** Inject from the host's secret store; never serialize with tenant configuration. */
  webhookSecret: Uint8Array
  now?: () => Date
  maxBodyBytes?: number
  maxAgeSeconds?: number
  futureSkewSeconds?: number
}

/** Verifies and normalizes only. The HTTP host must await durable storage before acknowledging. */
export function createChatwootWebhookAdapter(options: ChatwootWebhookOptions) {
  const maxBody = boundedOption(options.maxBodyBytes ?? 131072, 1024, 1048576)
  const maxAge = boundedOption(options.maxAgeSeconds ?? 300, 1, 900)
  const futureSkew = boundedOption(options.futureSkewSeconds ?? 30, 0, 60)
  if (!(options.webhookSecret instanceof Uint8Array) || options.webhookSecret.length < 32 || options.webhookSecret.length > 4096) fail('INVALID_WEBHOOK_CONFIG')
  const secret = Buffer.from(options.webhookSecret)
  const now = options.now ?? (() => new Date())
  if (typeof now !== 'function') fail('INVALID_WEBHOOK_CONFIG')
  const admission = options.admission
  const context = admission.resolveAuthenticatedContext(options.source)
  // This adapter accepts numeric Chatwoot IDs; nonnumeric synthetic bindings belong to other adapters.
  numericId(context.account_id)
  numericId(context.inbox_id)

  return Object.freeze({
    verify(request: { rawBody: Uint8Array; signature: unknown; timestamp: unknown }): {
      context: DeepReadonly<PlatformContext>; event: DeepReadonly<ChatwootIncomingEvent>
    } {
      if (!(request.rawBody instanceof Uint8Array) || request.rawBody.length < 2 || request.rawBody.length > maxBody) fail('WEBHOOK_BODY_SIZE')
      const raw = Buffer.from(request.rawBody)
      const timestamp = request.timestamp
      const signature = request.signature
      // Arrays, comma-joined duplicate headers, whitespace and noncanonical timestamps are rejected.
      if (typeof timestamp !== 'string' || !/^[1-9][0-9]{0,11}$/.test(timestamp)
        || typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) fail('WEBHOOK_AUTH_INVALID')
      let receivedAt: Date
      try { receivedAt = now() } catch { fail('WEBHOOK_CLOCK_INVALID') }
      if (!(receivedAt instanceof Date) || !Number.isFinite(receivedAt.getTime())) fail('WEBHOOK_CLOCK_INVALID')
      const age = receivedAt.getTime() / 1000 - Number(timestamp)
      if (age > maxAge || age < -futureSkew) fail('WEBHOOK_TIMESTAMP_INVALID')
      const expected = createHmac('sha256', secret).update(timestamp).update('.').update(raw).digest()
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) fail('WEBHOOK_AUTH_INVALID')
      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
        parsed = snapshotJson(parsed, 'WEBHOOK_PAYLOAD_INVALID')
      } catch { fail('WEBHOOK_PAYLOAD_INVALID') }
      const body = object(parsed)
      const account = object(body.account)
      const inbox = object(body.inbox)
      const conversation = object(body.conversation)
      const accountId = numericId(account.id)
      const inboxId = numericId(inbox.id)
      if (accountId !== context.account_id || inboxId !== context.inbox_id) fail('WEBHOOK_BINDING_MISMATCH')
      if (conversation.account_id !== undefined && numericId(conversation.account_id) !== accountId) fail('WEBHOOK_BINDING_MISMATCH')
      if (conversation.account !== undefined && numericId(object(conversation.account).id) !== accountId) fail('WEBHOOK_BINDING_MISMATCH')
      if (numericId(conversation.inbox_id) !== inboxId) fail('WEBHOOK_BINDING_MISMATCH')
      if (body.event !== 'message_created' || (body.message_type !== 'incoming' && body.message_type !== 0)
        || body.private !== false || body.content_type !== 'text') fail('WEBHOOK_EVENT_UNSUPPORTED')
      if (body.sender_type !== undefined && body.sender_type !== 'Contact') fail('WEBHOOK_EVENT_UNSUPPORTED')
      // Attachments and special payloads require their own grounded business adapters, never URL fetching here.
      if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length !== 0)) fail('WEBHOOK_EVENT_UNSUPPORTED')
      const attributes = body.content_attributes === undefined ? {} : object(body.content_attributes)
      if (attributes.deleted === true || attributes.is_unsupported === true) fail('WEBHOOK_EVENT_UNSUPPORTED')
      if (typeof body.content !== 'string' || body.content.trim().length === 0 || Buffer.byteLength(body.content, 'utf8') > 16384
        || body.content.includes('\u0000') || Buffer.from(body.content, 'utf8').toString('utf8') !== body.content) fail('WEBHOOK_CONTENT_INVALID')
      const conversationId = numericId(conversation.id)
      // Chatwoot's account-scoped display_id is not the database conversation id.
      // Both are provider data, so validate its shape without treating equality as
      // an authentication condition. Account/inbox binding is verified above.
      if (conversation.display_id !== undefined) numericId(conversation.display_id)
      const messageId = numericId(body.id)
      const occurredAt = eventTime(body.created_at)
      const semantic = { event: 'message_created', conversation_id: conversationId, message_id: messageId,
        content: body.content, occurred_at: occurredAt, message_type: 'incoming', private: false, content_type: 'text' }
      const semanticHash = digest(canonicalJson(semantic))
      // Delivery headers are not covered by Chatwoot's HMAC. Identity uses authenticated source + message ID.
      const key = admission.namespaceExternalId(context, 'event', `message_created:${messageId}`)
      const eventHash = digest(key)
      const traceHash = createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')).update(key).digest('hex')
      const traceHex = traceHash.slice(0, 12) + '5' + traceHash.slice(13, 16) + ((parseInt(traceHash[16]!, 16) & 3) | 8).toString(16) + traceHash.slice(17, 32)
      const event: ChatwootIncomingEvent = {
        schema_version: 'platform-chatwoot-incoming.v1', event_id: `cw1_${eventHash}`,
        tenant_id: context.tenant_id, deployment_id: context.deployment_id, connector_id: context.connector_id,
        account_id: accountId, inbox_id: inboxId, conversation_id: conversationId, message_id: messageId,
        correlation_id: admission.namespaceExternalId(context, 'conversation', conversationId),
        causation_id: admission.namespaceExternalId(context, 'message', messageId),
        trace_id: `${traceHex.slice(0, 8)}-${traceHex.slice(8, 12)}-${traceHex.slice(12, 16)}-${traceHex.slice(16, 20)}-${traceHex.slice(20)}`,
        occurred_at: occurredAt, received_at: receivedAt.toISOString(), data_classification: 'restricted_external',
        instruction_eligible: false, content: { trust: 'untrusted_data', text: body.content },
        semantic_sha256: semanticHash, raw_sha256: digest(raw),
      }
      return freezeDeep({ context, event })
    },
  })
}

function boundedOption(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('INVALID_WEBHOOK_CONFIG')
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('WEBHOOK_PAYLOAD_INVALID')
  return value as Record<string, unknown>
}
function numericId(value: unknown): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,18}$/.test(text)) fail('WEBHOOK_ID_INVALID')
  return text
}
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function eventTime(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799) return new Date(value * 1000).toISOString()
  if (typeof value !== 'string') fail('WEBHOOK_EVENT_TIME_INVALID')
  const input = value.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/, '$1T$2Z')
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/.exec(input)
  if (!parts) fail('WEBHOOK_EVENT_TIME_INVALID')
  const [, y, m, d, h, min, s, zone] = parts
  const calendar = new Date(0)
  calendar.setUTCFullYear(Number(y), Number(m) - 1, Number(d))
  if (calendar.getUTCFullYear() !== Number(y) || calendar.getUTCMonth() !== Number(m) - 1 || calendar.getUTCDate() !== Number(d)
    || Number(h) > 23 || Number(min) > 59 || Number(s) > 59
    || (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59))) fail('WEBHOOK_EVENT_TIME_INVALID')
  const time = new Date(input)
  if (!Number.isFinite(time.getTime())) fail('WEBHOOK_EVENT_TIME_INVALID')
  return time.toISOString()
}
