import { createHash, timingSafeEqual } from 'node:crypto'
import type { RuntimeRepository } from './repository.js'

export class WebhookError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'WebhookError'
  }
}

export class WebhookService {
  constructor(private readonly options: {
    repository: RuntimeRepository
    mailboxSecrets: Record<string, string>
    maxPayloadBytes: number
    now?: () => Date
  }) {
    if (!Number.isInteger(options.maxPayloadBytes) || options.maxPayloadBytes < 1) {
      throw new Error('maxPayloadBytes must be a positive integer')
    }
  }

  async ingest(input: { mailboxKey: string; authorization?: string; rawBody: string | Buffer }) {
    const secret = this.options.mailboxSecrets[input.mailboxKey]
    if (!secret) throw new WebhookError('UNKNOWN_MAILBOX')
    const provided = input.authorization?.startsWith('Bearer ')
      ? input.authorization.slice('Bearer '.length)
      : ''
    if (!constantTimeSecretEqual(provided, secret)) throw new WebhookError('UNAUTHORIZED')
    const rawBody = Buffer.isBuffer(input.rawBody) ? input.rawBody : Buffer.from(input.rawBody)
    if (rawBody.byteLength > this.options.maxPayloadBytes) {
      throw new WebhookError('PAYLOAD_TOO_LARGE')
    }
    let payload: unknown
    try {
      payload = JSON.parse(rawBody.toString('utf8'))
    } catch {
      throw new WebhookError('INVALID_JSON')
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new WebhookError('INVALID_PAYLOAD')
    }
    const event = payload as Record<string, unknown>
    if (
      typeof event.provider_event_id !== 'string' ||
      event.provider_event_id.length < 1 ||
      event.provider_event_id.length > 256
    ) {
      throw new WebhookError('INVALID_EVENT_ID')
    }
    const inserted = await this.options.repository.storeWebhookEvent({
      mailbox_key: input.mailboxKey,
      provider_event_id: event.provider_event_id,
      received_at: (this.options.now ?? (() => new Date()))().toISOString(),
      trust_classification: 'untrusted_external',
      instruction_eligible: false,
      untrusted_payload: structuredClone(event),
    })
    return { accepted: true, duplicate: !inserted }
  }
}

function constantTimeSecretEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest()
  const rightDigest = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}
