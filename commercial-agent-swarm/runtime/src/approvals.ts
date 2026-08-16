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
    const record: ApprovalRequestRecord = {
      approval_id: this.id(),
      action: structuredClone(action),
      action_hash: hashAction(action),
      requested_at: this.now().toISOString(),
      status: 'pending',
    }
    await this.options.repository.createApprovalRequest(record)
    await this.options.telegram?.notifyApprovalRequest({
      approval_id: record.approval_id,
      mission_id: action.mission_id,
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
    if (!token) throw new ApprovalError('TOKEN_REQUIRED')
    const claims = this.parse(token)
    const expectedSignature = this.sign({
      mission_id: claims.missionId,
      action_hash: claims.actionHash,
      expires_at: claims.expiresAt,
      nonce: claims.nonce,
    })
    if (!safeEqual(claims.signature, expectedSignature)) throw new ApprovalError('INVALID_SIGNATURE')
    if (claims.missionId !== action.mission_id || claims.actionHash !== hashAction(action)) {
      throw new ApprovalError('CONTENT_MISMATCH')
    }
    const now = this.now()
    if (Date.parse(claims.expiresAt) <= now.getTime()) throw new ApprovalError('EXPIRED')
    if (
      await this.options.repository.isKillSwitchActive({
        missionId: action.mission_id,
        channel: action.channel,
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
