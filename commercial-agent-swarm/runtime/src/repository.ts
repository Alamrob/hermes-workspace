import type { ApprovalAction } from './approvals.js'
import { inMemoryPortfolioReadModel, type PortfolioReadModel } from './portfolio-read-model.js'
import type {
  CompleteShadowReviewInput,
  RecordShadowDecisionInput,
  ShadowReview,
} from './shadow-review.js'

interface ApprovalRecord {
  approval_id: string
  action: ApprovalAction
  action_hash: string
  requested_at: string
}

export interface ApprovalRequestRecord extends ApprovalRecord {
  status: 'pending' | 'denied'
}

export interface ApprovalGrantRecord extends ApprovalRecord {
  status: 'approved'
  approved_by: string
  expires_at: string
  nonce: string
  token: string
  consumed_at: string | null
}

export interface RuntimeRepository {
  ready(): Promise<boolean>
  getPortfolioReadModel(): Promise<PortfolioReadModel>
  listShadowReviews(): Promise<ShadowReview[]>
  getShadowReview(id: string): Promise<ShadowReview | null>
  recordShadowDecision(input: RecordShadowDecisionInput): Promise<ShadowReview>
  completeShadowReview(input: CompleteShadowReviewInput): Promise<ShadowReview>
  saveMission(record: MissionRecord): Promise<void>
  createInstructionRequest(record: InstructionRequestRecord): Promise<InstructionRequestResult>
  getMission(id: string): Promise<MissionRecord | null>
  isMissionA3Enabled(id: string): Promise<boolean>
  deliveryPolicyAllows(action: ApprovalAction): Promise<boolean>
  storeWebhookEvent(record: WebhookEventRecord): Promise<boolean>
  createApprovalRequest(record: ApprovalRequestRecord): Promise<void>
  getApprovalRequest(id: string): Promise<ApprovalRequestRecord | ApprovalGrantRecord | null>
  saveApprovalDecision(record: ApprovalGrantRecord | (ApprovalRequestRecord & { status: 'denied' })): Promise<boolean>
  consumeApproval(input: {
    missionId: string
    actionHash: string
    nonce: string
    now: string
  }): Promise<ApprovalGrantRecord | null>
  isKillSwitchActive(input: { missionId: string; channel: string }): Promise<boolean>
  externalActionsBlocked(): Promise<boolean>
  claimExternalAction(input: { missionId: string; channel: string; idempotencyKey: string; actionHash: string }): Promise<{ status: 'acquired' } | { status: 'completed'; receipt_id: string; approval_id: string }>
  completeExternalAction(input: { missionId: string; idempotencyKey: string; actionHash: string; receipt_id: string; approval_id: string }): Promise<void>
}

export interface InstructionRequestRecord {
  request_id: string
  idempotency_key: string
  project_id: 'proptimiza'
  title: string
  instruction: string
  instruction_sha256: string
  requested_by: string
  source: 'workspace' | 'sales'
  autonomy_ceiling: 'A0' | 'A1' | 'A2'
  created_at: string
  expires_at: string
  metadata: Record<string, unknown>
}

export interface InstructionRequestResult {
  request_id: string
  project_id: 'proptimiza'
  title: string
  status: 'pending_codex_review'
  autonomy_ceiling: 'A0' | 'A1' | 'A2'
  requires_codex_review: true
  external_actions_allowed: false
  created_at: string
  expires_at: string
  created: boolean
}

export interface WebhookEventRecord {
  mailbox_key: string
  provider_event_id: string
  received_at: string
  trust_classification: 'untrusted_external'
  instruction_eligible: false
  untrusted_payload: Record<string, unknown>
}

export interface MissionRecord {
  mission_id: string
  autonomy_level: string
  a3_enabled: boolean
  [key: string]: unknown
}

export class InMemoryRuntimeRepository implements RuntimeRepository {
  private readonly approvals = new Map<string, ApprovalRequestRecord | ApprovalGrantRecord>()
  private readonly killSwitches = new Set<string>()
  private readonly missions = new Map<string, MissionRecord>()
  private readonly instructionRequests = new Map<string, InstructionRequestRecord>()
  private readonly webhookEvents = new Map<string, WebhookEventRecord>()
  private readonly externalActions = new Map<string, { action_hash: string; channel: string; receipt_id?: string; approval_id?: string }>()

  async ready(): Promise<boolean> {
    return true
  }

  async getPortfolioReadModel(): Promise<PortfolioReadModel> {
    return inMemoryPortfolioReadModel({
      missionCount: this.missions.size,
      approvalCount: this.approvals.size,
      auditCount: 0,
      killSwitchActive: this.killSwitches.has('global:*'),
    })
  }

  async saveMission(record: MissionRecord): Promise<void> {
    this.missions.set(record.mission_id, structuredClone(record))
  }

  async getMission(id: string): Promise<MissionRecord | null> {
    const mission = this.missions.get(id)
    return mission ? structuredClone(mission) : null
  }

  async isMissionA3Enabled(id: string): Promise<boolean> {
    const mission = this.missions.get(id)
    return mission?.autonomy_level === 'A3' && mission.a3_enabled === true
  }

  async deliveryPolicyAllows(action: ApprovalAction): Promise<boolean> {
    return action.project_id === 'proptimiza' && action.policy_version === 'policy-v1' &&
      action.sender === 'ventas@proptimiza.com' && action.recipients.length === 1 &&
      action.recipients[0] === 'contacto@proptimiza.com' && action.volume === 1
  }

  async storeWebhookEvent(record: WebhookEventRecord): Promise<boolean> {
    const key = `${record.mailbox_key}:${record.provider_event_id}`
    if (this.webhookEvents.has(key)) return false
    this.webhookEvents.set(key, structuredClone(record))
    return true
  }

  async listWebhookEvents(): Promise<WebhookEventRecord[]> {
    return [...this.webhookEvents.values()].map((event) => structuredClone(event))
  }

  async createApprovalRequest(record: ApprovalRequestRecord): Promise<void> {
    if (this.approvals.has(record.approval_id)) throw new Error('duplicate approval id')
    this.approvals.set(record.approval_id, structuredClone(record))
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequestRecord | ApprovalGrantRecord | null> {
    const record = this.approvals.get(id)
    return record ? structuredClone(record) : null
  }

  async saveApprovalDecision(
    record: ApprovalGrantRecord | (ApprovalRequestRecord & { status: 'denied' }),
  ): Promise<boolean> {
    const current = this.approvals.get(record.approval_id)
    if (!current || current.status !== 'pending') return false
    if (
      record.status === 'approved' &&
      [...this.approvals.values()].some((approval) =>
        approval.status === 'approved' &&
        approval.approval_id !== record.approval_id &&
        approval.action.mission_id === record.action.mission_id &&
        approval.action_hash === record.action_hash &&
        approval.nonce === record.nonce
      )
    ) {
      throw new Error('APPROVAL_GRANT_CONFLICT')
    }
    this.approvals.set(record.approval_id, structuredClone(record))
    return true
  }

  async consumeApproval(input: {
    missionId: string
    actionHash: string
    nonce: string
    now: string
  }): Promise<ApprovalGrantRecord | null> {
    for (const [id, record] of this.approvals) {
      if (
        record.status === 'approved' &&
        record.action.mission_id === input.missionId &&
        record.action_hash === input.actionHash &&
        record.nonce === input.nonce &&
        record.consumed_at === null &&
        Date.parse(record.expires_at) > Date.parse(input.now)
      ) {
        const consumed = { ...record, consumed_at: input.now }
        this.approvals.set(id, consumed)
        return structuredClone(consumed)
      }
    }
    return null
  }

  async activateKillSwitch(scope: string, scopeId: string): Promise<void> {
    this.killSwitches.add(`${scope}:${scopeId}`)
  }

  async isKillSwitchActive(input: { missionId: string; channel: string }): Promise<boolean> {
    return (
      this.killSwitches.has('global:*') ||
      this.killSwitches.has(`mission:${input.missionId}`) ||
      this.killSwitches.has(`channel:${input.channel}`)
    )
  }

  async listShadowReviews(): Promise<ShadowReview[]> { return [] }
  async getShadowReview(_id: string): Promise<ShadowReview | null> { return null }
  async recordShadowDecision(_input: RecordShadowDecisionInput): Promise<ShadowReview> {
    throw new Error('SHADOW_REVIEW_NOT_FOUND')
  }
  async completeShadowReview(_input: CompleteShadowReviewInput): Promise<ShadowReview> {
    throw new Error('SHADOW_REVIEW_NOT_FOUND')
  }

  async createInstructionRequest(
    record: InstructionRequestRecord,
  ): Promise<InstructionRequestResult> {
    const current = this.instructionRequests.get(record.idempotency_key)
    if (current) {
      if (
        current.request_id !== record.request_id ||
        current.project_id !== record.project_id ||
        current.title !== record.title ||
        current.instruction_sha256 !== record.instruction_sha256 ||
        current.requested_by !== record.requested_by ||
        current.source !== record.source ||
        current.autonomy_ceiling !== record.autonomy_ceiling
      )
        throw new Error('INSTRUCTION_IDEMPOTENCY_CONFLICT')
      return instructionResult(current, false)
    }
    this.instructionRequests.set(record.idempotency_key, structuredClone(record))
    return instructionResult(record, true)
  }

  async externalActionsBlocked(): Promise<boolean> {
    return [
      'email',
      'whatsapp',
      'calendar',
      'web_chat',
      'telephone',
      'crm',
      'public_web',
    ].every((channel) => this.killSwitches.has(`channel:${channel}`))
  }

  async claimExternalAction(input: { missionId: string; channel: string; idempotencyKey: string; actionHash: string }): Promise<{ status: 'acquired' } | { status: 'completed'; receipt_id: string; approval_id: string }> {
    if (await this.isKillSwitchActive(input)) throw new Error('KILL_SWITCH_ACTIVE')
    const key = `${input.missionId}:${input.idempotencyKey}`
    const current = this.externalActions.get(key)
    if (current && (current.action_hash !== input.actionHash || current.channel !== input.channel)) {
      throw new Error('IDEMPOTENCY_CONFLICT')
    }
    if (current?.receipt_id && current.approval_id) {
      return {
        status: 'completed',
        receipt_id: current.receipt_id,
        approval_id: current.approval_id,
      }
    }
    if (current) throw new Error('EXECUTION_IN_PROGRESS')
    this.externalActions.set(key, { action_hash: input.actionHash, channel: input.channel })
    return { status: 'acquired' }
  }

  async completeExternalAction(input: { missionId: string; idempotencyKey: string; actionHash: string; receipt_id: string; approval_id: string }): Promise<void> {
    const key = `${input.missionId}:${input.idempotencyKey}`
    const current = this.externalActions.get(key)
    if (!current || current.action_hash !== input.actionHash) throw new Error('IDEMPOTENCY_CONFLICT')
    this.externalActions.set(key, { ...current, receipt_id: input.receipt_id, approval_id: input.approval_id })
  }
}

function instructionResult(
  record: InstructionRequestRecord,
  created: boolean,
): InstructionRequestResult {
  return {
    request_id: record.request_id,
    project_id: record.project_id,
    title: record.title,
    status: 'pending_codex_review',
    autonomy_ceiling: record.autonomy_ceiling,
    requires_codex_review: true,
    external_actions_allowed: false,
    created_at: record.created_at,
    expires_at: record.expires_at,
    created,
  }
}
