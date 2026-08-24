import { constantTimeSecretEqual } from './security.js'
import type { HostingerMailApiClient } from './hostinger-mail-api.js'
import type { TelegramBotApiClient } from './telegram-bot-api.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/

export interface ExternalActionSafetyPort {
  isActive(input: { missionId: string; channel: string }): Promise<boolean>
}

export class ExternalActionBrokerApplication {
  constructor(private readonly options: {
    bearer: string
    hostingerEnabled: boolean
    telegramEnabled: boolean
    safety: ExternalActionSafetyPort
    hostinger?: Pick<HostingerMailApiClient, 'isBlocked' | 'sendInternal'>
    telegram?: Pick<TelegramBotApiClient, 'postApprovalRequest'>
  }) {
    if (options.bearer.length < 32 || options.bearer.length > 4_096 || /\s/.test(options.bearer))
      throw new Error('EXTERNAL_ACTION_BROKER_BEARER_INVALID')
    if (options.hostingerEnabled !== Boolean(options.hostinger))
      throw new Error('EXTERNAL_ACTION_HOSTINGER_CONFIGURATION_INVALID')
    if (options.telegramEnabled !== Boolean(options.telegram))
      throw new Error('EXTERNAL_ACTION_TELEGRAM_CONFIGURATION_INVALID')
  }

  async handle(request: {
    method: string
    path: string
    authorization?: string
    body?: unknown
  }): Promise<{ status: number; body: unknown }> {
    if (request.method === 'GET' && request.path === '/healthz')
      return { status: 200, body: { status: 'ok' } }
    if (request.method === 'GET' && request.path === '/readyz')
      return { status: 200, body: { status: 'ready', hostinger: this.options.hostingerEnabled, telegram: this.options.telegramEnabled } }
    if (!authorized(request.authorization, this.options.bearer))
      return { status: 401, body: { error: 'unauthorized' } }
    try {
      if (request.method === 'POST' && request.path === '/internal/v1/mail/block-status') {
        const input = mailIdentity(request.body)
        const blocked = !this.options.hostingerEnabled ||
          await this.options.safety.isActive({ missionId: '*', channel: 'email' }) ||
          await this.options.hostinger!.isBlocked(input)
        return { status: 200, body: { blocked } }
      }
      if (request.method === 'POST' && request.path === '/internal/v1/mail/send') {
        if (!this.options.hostingerEnabled) return { status: 403, body: { error: 'hostinger_disabled' } }
        const input = internalMail(request.body)
        if (await this.options.safety.isActive({ missionId: input.missionId, channel: 'email' }))
          return { status: 403, body: { error: 'kill_switch_active' } }
        if (await this.options.hostinger!.isBlocked({ mailbox: input.mailbox, recipient: input.recipient }))
          return { status: 403, body: { error: 'recipient_blocked' } }
        const receipt = await this.options.hostinger!.sendInternal({
          mailbox: input.mailbox,
          recipient: input.recipient,
          subject: input.subject,
          content: input.content,
          idempotencyKey: input.idempotencyKey,
        })
        return { status: 200, body: receipt }
      }
      if (request.method === 'POST' && request.path === '/internal/v1/telegram/approval-request') {
        if (!this.options.telegramEnabled) return { status: 403, body: { error: 'telegram_disabled' } }
        const input = telegramApproval(request.body)
        if (await this.options.safety.isActive({ missionId: input.mission_id, channel: 'telegram' }))
          return { status: 403, body: { error: 'kill_switch_active' } }
        await this.options.telegram!.postApprovalRequest(input)
        return { status: 200, body: { accepted: true } }
      }
      return { status: 404, body: { error: 'not_found' } }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'EXTERNAL_ACTION_FAILURE'
      if (/_(?:INVALID|NOT_ALLOWED)$/.test(code)) return { status: 400, body: { error: 'invalid_request' } }
      if (code === 'HOSTINGER_DELIVERY_UNCERTAIN' || code === 'TELEGRAM_DELIVERY_UNCERTAIN')
        return { status: 503, body: { error: 'delivery_uncertain' } }
      return { status: 503, body: { error: 'provider_unavailable' } }
    }
  }
}

function authorized(header: string | undefined, expected: string): boolean {
  const candidate = header?.match(/^Bearer ([^\s]+)$/)?.[1]
  return candidate !== undefined && constantTimeSecretEqual(candidate, expected)
}

function mailIdentity(value: unknown): { mailbox: string; recipient: string } {
  if (!record(value) || exactKeys(value, ['mailbox', 'recipient']) === false ||
      typeof value.mailbox !== 'string' || typeof value.recipient !== 'string')
    throw new Error('MAIL_IDENTITY_INVALID')
  return { mailbox: value.mailbox, recipient: value.recipient }
}

function internalMail(value: unknown): {
  missionId: string
  mailbox: 'ventas@proptimiza.com'
  recipient: 'contacto@proptimiza.com'
  subject: string
  content: string
  idempotencyKey: string
} {
  const keys = ['content', 'idempotencyKey', 'mailbox', 'missionId', 'recipient', 'subject']
  if (!record(value) || !exactKeys(value, keys) || !UUID.test(String(value.missionId)) ||
      value.mailbox !== 'ventas@proptimiza.com' || value.recipient !== 'contacto@proptimiza.com' ||
      typeof value.subject !== 'string' || typeof value.content !== 'string' || typeof value.idempotencyKey !== 'string')
    throw new Error('INTERNAL_MAIL_INVALID')
  return value as ReturnType<typeof internalMail>
}

function telegramApproval(value: unknown): { approval_id: string; mission_id: string; action_hash: string } {
  if (!record(value) || !exactKeys(value, ['action_hash', 'approval_id', 'mission_id']) ||
      !UUID.test(String(value.approval_id)) || !UUID.test(String(value.mission_id)) || !HASH.test(String(value.action_hash)))
    throw new Error('TELEGRAM_APPROVAL_INVALID')
  return value as ReturnType<typeof telegramApproval>
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
