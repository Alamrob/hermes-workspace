export interface ApprovalAction {
  mission_id: string
  project_id: string
  project_version: string
  action_type: string
  channel: string
  sender: string
  recipients: string[]
  subject: string
  content: string
  content_version: string
  volume: number
  offer_version: string
  policy_version: string
  idempotency_key: string
}

const APPROVAL_ACTION_FIELDS = [
  'mission_id',
  'project_id',
  'project_version',
  'action_type',
  'channel',
  'sender',
  'recipients',
  'subject',
  'content',
  'content_version',
  'volume',
  'offer_version',
  'policy_version',
  'idempotency_key',
] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACTION_NAME = /^[a-z][a-z0-9._:-]{1,127}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/

export interface TelegramTransport {
  notifyApprovalRequest(request: {
    approval_id: string
    mission_id: string
    action_hash: string
  }): Promise<void>
}

export class ApprovalError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ApprovalError'
  }
}

interface ApprovalBrokerOptions {
  repository: RuntimeRepository
  hmacSecret: string
  now?: () => Date
  nonce?: () => string
  id?: () => string
  telegram?: TelegramTransport
}

interface ApprovalDecision {
  approved: boolean
  approved_by: string
  expires_at: string
}

export class ApprovalBroker {
  private readonly now: () => Date
  private readonly nonce: () => string
  private readonly id: () => string

  constructor(private readonly options: ApprovalBrokerOptions) {
    if (Buffer.byteLength(options.hmacSecret) < 32) throw new Error('HMAC secret must be at least 32 bytes')
    this.now = options.now ?? (() => new Date())
    this.nonce = options.nonce ?? (() => crypto.randomUUID().replaceAll('-', ''))
    this.id = options.id ?? (() => crypto.randomUUID())
  }

  async request(action: ApprovalAction): Promise<ApprovalRequestRecord> {
    const validatedAction = validateApprovalAction(action)
    const record: ApprovalRequestRecord = {
      approval_id: this.id(),
      action: validatedAction,
      action_hash: hashAction(validatedAction),
      requested_at: this.now().toISOString(),
      status: 'pending',
    }
    await this.options.repository.createApprovalRequest(record)
    await this.options.telegram?.notifyApprovalRequest({
      approval_id: record.approval_id,
      mission_id: validatedAction.mission_id,
      action_hash: record.action_hash,
    })
    return record
  }

  async decide(
    id: string,
    decision: ApprovalDecision,
  ): Promise<{ status: 'approved' | 'denied'; token?: string }> {
    const request = await this.options.repository.getApprovalRequest(id)
    if (!request || request.status !== 'pending') throw new ApprovalError('NOT_PENDING')
    if (!decision.approved) {
      const saved = await this.options.repository.saveApprovalDecision({ ...request, status: 'denied' })
      if (!saved) throw new ApprovalError('NOT_PENDING')
      return { status: 'denied' }
    }

    const issuedAt = this.now().getTime()
    const expiresAt = Date.parse(decision.expires_at)
    if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 30 * 60_000) {
      throw new ApprovalError('INVALID_TTL')
    }
    const nonce = this.nonce()
    const claims = {
      mission_id: request.action.mission_id,
      action_hash: request.action_hash,
      expires_at: new Date(expiresAt).toISOString(),
      nonce,
    }
    const signature = this.sign(claims)
    const token = [
      'APPROVAL',
      claims.mission_id,
      claims.action_hash,
      claims.expires_at,
      claims.nonce,
      signature,
    ].join('::')
    const grant: ApprovalGrantRecord = {
      ...request,
      status: 'approved',
      approved_by: decision.approved_by,
      expires_at: claims.expires_at,
      nonce,
      token,
      consumed_at: null,
    }
    const saved = await this.options.repository.saveApprovalDecision(grant)
    if (!saved) throw new ApprovalError('NOT_PENDING')
    return { status: 'approved', token }
  }

  async authorize(token: string | undefined, action: ApprovalAction): Promise<ApprovalGrantRecord> {
    const validatedAction = validateApprovalAction(action)
    if (!token) throw new ApprovalError('TOKEN_REQUIRED')
    const claims = this.parse(token)
    const expectedSignature = this.sign({
      mission_id: claims.missionId,
      action_hash: claims.actionHash,
      expires_at: claims.expiresAt,
      nonce: claims.nonce,
    })
    if (!safeEqual(claims.signature, expectedSignature)) throw new ApprovalError('INVALID_SIGNATURE')
    if (claims.missionId !== validatedAction.mission_id || claims.actionHash !== hashAction(validatedAction)) {
      throw new ApprovalError('CONTENT_MISMATCH')
    }
    const now = this.now()
    if (Date.parse(claims.expiresAt) <= now.getTime()) throw new ApprovalError('EXPIRED')
    if (
      await this.options.repository.isKillSwitchActive({
        missionId: validatedAction.mission_id,
        channel: validatedAction.channel,
      })
    ) {
      throw new ApprovalError('KILL_SWITCH_ACTIVE')
    }
    const consumed = await this.options.repository.consumeApproval({
      missionId: claims.missionId,
      actionHash: claims.actionHash,
      nonce: claims.nonce,
      now: now.toISOString(),
    })
    if (!consumed) throw new ApprovalError('REPLAYED')
    return consumed
  }

  private sign(claims: object): string {
    return createHmac('sha256', this.options.hmacSecret)
      .update(canonicalJson(claims))
      .digest('hex')
  }

  private parse(token: string): {
    missionId: string
    actionHash: string
    expiresAt: string
    nonce: string
    signature: string
  } {
    const [prefix, missionId, actionHash, expiresAt, nonce, signature, extra] = token.split('::')
    if (
      prefix !== 'APPROVAL' ||
      !missionId ||
      !/^[0-9a-f]{64}$/.test(actionHash ?? '') ||
      !expiresAt ||
      !nonce ||
      !/^[0-9a-f]{64}$/.test(signature ?? '') ||
      extra !== undefined
    ) {
      throw new ApprovalError('MALFORMED_TOKEN')
    }
    return { missionId, actionHash: actionHash!, expiresAt, nonce, signature: signature! }
  }
}

export function validateApprovalAction(value: unknown): ApprovalAction {
  if (!isRecord(value)) throw new ApprovalError('INVALID_ACTION')
  const allowed = new Set<string>(APPROVAL_ACTION_FIELDS)
  if (
    APPROVAL_ACTION_FIELDS.some((field) => !(field in value)) ||
    Object.keys(value).some((field) => !allowed.has(field)) ||
    typeof value.mission_id !== 'string' ||
    !UUID.test(value.mission_id) ||
    !validString(value.project_id, 128) ||
    !validString(value.project_version, 128) ||
    typeof value.action_type !== 'string' ||
    !ACTION_NAME.test(value.action_type) ||
    !validString(value.channel, 64) ||
    !validString(value.sender, 320) ||
    !Array.isArray(value.recipients) ||
    value.recipients.length < 1 ||
    new Set(value.recipients).size !== value.recipients.length ||
    value.recipients.some((recipient) => !validString(recipient, 320)) ||
    !validString(value.subject, 998) ||
    !validString(value.content, 100_000) ||
    !validString(value.content_version, 128) ||
    !Number.isInteger(value.volume) ||
    (value.volume as number) < 1 ||
    !validString(value.offer_version, 128) ||
    !validString(value.policy_version, 128) ||
    typeof value.idempotency_key !== 'string' ||
    !IDEMPOTENCY_KEY.test(value.idempotency_key)
  ) {
    throw new ApprovalError('INVALID_ACTION')
  }
  return {
    mission_id: value.mission_id,
    project_id: value.project_id as string,
    project_version: value.project_version as string,
    action_type: value.action_type,
    channel: value.channel as string,
    sender: value.sender as string,
    recipients: [...value.recipients] as string[],
    subject: value.subject as string,
    content: value.content as string,
    content_version: value.content_version as string,
    volume: value.volume as number,
    offer_version: value.offer_version as string,
    policy_version: value.policy_version as string,
    idempotency_key: value.idempotency_key,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}
import { createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalJson, hashAction } from './canonical.js'
import type {
  ApprovalGrantRecord,
  ApprovalRequestRecord,
  RuntimeRepository,
} from './repository.js'
