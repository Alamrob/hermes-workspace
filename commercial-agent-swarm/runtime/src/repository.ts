import type { ApprovalAction } from './approvals.js'
import { inMemoryPortfolioReadModel, type PortfolioReadModel } from './portfolio-read-model.js'
import type {
  CompleteShadowReviewInput,
  RecordShadowDecisionInput,
  ShadowReview,
} from './shadow-review.js'
import type {
  CompleteDraftReviewInput,
  DraftReview,
  RecordDraftReviewItemInput,
} from './draft-review.js'
import type { A1ResearchDossier } from './a1-research-dossier.js'
import type {
  A1ResearchAuthorizationState,
  RecordA1ResearchAuthorizationInput,
} from './a1-research-authorization.js'
import type {
  A1ResearchOrderAuthorizationState,
  RecordA1ResearchOrderAuthorizationInput,
} from './a1-research-order-authorization.js'
import type {
  A1DispatchAuthorizationState,
  RecordA1DispatchAuthorizationInput,
} from './a1-dispatch-authorization.js'
import type {
  A1AssignmentEnqueueAuthorizationState,
  RecordA1AssignmentEnqueueAuthorizationInput,
} from './a1-assignment-enqueue-authorization.js'
import { PolicyReviewError, type PolicyReviewState, type RecordPolicyReviewInput } from './policy-review.js'
import type { PolicyActivationDossierState } from './policy-activation-dossier.js'

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
  listDraftReviews(): Promise<DraftReview[]>
  getDraftReview(id: string): Promise<DraftReview | null>
  recordDraftReviewItem(input: RecordDraftReviewItemInput): Promise<DraftReview>
  completeDraftReview(input: CompleteDraftReviewInput): Promise<DraftReview>
  getA1ResearchDossier(reviewId: string): Promise<A1ResearchDossier | null>
  getA1ResearchAuthorizationState(reviewId: string, dossierSha256: string): Promise<A1ResearchAuthorizationState | null>
  recordA1ResearchAuthorization(input: RecordA1ResearchAuthorizationInput): Promise<A1ResearchAuthorizationState>
  getA1ResearchOrderAuthorizationState(orderAuthorizationId: string): Promise<A1ResearchOrderAuthorizationState | null>
  recordA1ResearchOrderAuthorization(input: RecordA1ResearchOrderAuthorizationInput): Promise<A1ResearchOrderAuthorizationState>
  getA1DispatchAuthorizationState(missionId: string): Promise<A1DispatchAuthorizationState | null>
  recordA1DispatchAuthorization(input: RecordA1DispatchAuthorizationInput): Promise<A1DispatchAuthorizationState>
  getA1AssignmentEnqueueAuthorizationState(missionId: string): Promise<A1AssignmentEnqueueAuthorizationState | null>
  recordA1AssignmentEnqueueAuthorization(input: RecordA1AssignmentEnqueueAuthorizationInput): Promise<A1AssignmentEnqueueAuthorizationState>
  getPolicyReviewState(): Promise<PolicyReviewState>
  recordPolicyReview(input: RecordPolicyReviewInput): Promise<PolicyReviewState>
  getPolicyActivationDossierState(): Promise<PolicyActivationDossierState>
  saveMission(record: MissionRecord): Promise<void>
  createInstructionRequest(record: InstructionRequestRecord): Promise<InstructionRequestResult>
  listInstructionRequests(): Promise<InstructionRequestView[]>
  getInstructionRequest(id: string): Promise<InstructionRequestView | null>
  reviewInstructionRequest(input: InstructionReviewInput): Promise<InstructionReviewResult>
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
  isGlobalKillSwitchActive(): Promise<boolean>
  activateKillSwitch(scope: string, scopeId: string): Promise<void>
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
  status: 'pending_codex_review' | 'rejected' | 'converted'
  autonomy_ceiling: 'A0' | 'A1' | 'A2'
  requires_codex_review: true
  external_actions_allowed: false
  created_at: string
  expires_at: string
  created: boolean
}

export interface InstructionRequestView extends Omit<InstructionRequestRecord, 'metadata'> {
  status: 'pending_codex_review' | 'approved' | 'rejected' | 'converted'
  requires_codex_review: true
  external_actions_allowed: false
  metadata: Record<string, unknown>
  reviewed_by: string | null
  reviewed_at: string | null
  review_reason: string | null
  converted_mission_id: string | null
}

export interface InstructionReviewInput {
  requestId: string
  decision: 'reject' | 'convert'
  actorId: string
  reason: string
  reviewedAt: string
  idempotencyKey: string
  expectedInstructionSha256: string
  reviewRequestSha256: string
  mission: MissionRecord | null
}

export interface InstructionReviewResult {
  request_id: string
  status: 'rejected' | 'converted'
  reviewed_by: string
  reviewed_at: string
  review_reason: string
  converted_mission_id: string | null
  replayed: boolean
  external_actions_allowed: false
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
  private readonly instructionReviews = new Map<string, InstructionReviewInput>()
  private readonly webhookEvents = new Map<string, WebhookEventRecord>()
  private readonly externalActions = new Map<string, { action_hash: string; channel: string; receipt_id?: string; approval_id?: string }>()
  private readonly policyReviews = new Map<string, RecordPolicyReviewInput>()
  private readonly a1OrderAuthorizations = new Map<string, A1ResearchOrderAuthorizationState>()
  private readonly a1DispatchAuthorizations = new Map<string, A1DispatchAuthorizationState>()
  private readonly a1AssignmentEnqueueAuthorizations = new Map<string, A1AssignmentEnqueueAuthorizationState>()

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

  async isGlobalKillSwitchActive(): Promise<boolean> {
    return this.killSwitches.has('global:*')
  }

  async getA1ResearchOrderAuthorizationState(orderAuthorizationId: string): Promise<A1ResearchOrderAuthorizationState | null> {
    const state = this.a1OrderAuthorizations.get(orderAuthorizationId)
    return state ? structuredClone(state) : null
  }

  async recordA1ResearchOrderAuthorization(input: RecordA1ResearchOrderAuthorizationInput): Promise<A1ResearchOrderAuthorizationState> {
    const state: A1ResearchOrderAuthorizationState = {
      orderAuthorizationId: input.orderAuthorizationId,
      reviewId: input.reviewId,
      parentAuthorizationId: input.parentAuthorizationId,
      decision: input.decision,
      rationale: input.rationale,
      reviewerId: input.reviewerId,
      reviewerEmail: input.reviewerEmail,
      reviewedAt: input.reviewedAt,
      expiresAt: input.expiresAt,
      dossierSha256: input.expectedDossierSha256,
      unsignedWorkOrderSha256: input.unsignedWorkOrderSha256,
      missionId: input.missionId,
      userAuthorizationSha256: input.userAuthorizationSha256,
      attestations: input.attestations,
      idempotencyKey: input.idempotencyKey,
      executionAuthorized: false,
      missionCreated: false,
      dispatchQueued: false,
      internetAccessAllowed: false,
      providerCreditSpendAllowed: false,
      contactPermitted: false,
      crmWriteAllowed: false,
      maximumExternalActions: 0,
      productionGate: 'blocked',
      nextRequiredGate: 'sign_exact_work_order',
      provenance: {
        source: 'control-broker',
        sourceId: `a1-research-order-authorization:${input.orderAuthorizationId}`,
        observedAt: input.reviewedAt,
        synthetic: false,
      },
    }
    const existing = this.a1OrderAuthorizations.get(input.orderAuthorizationId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(state))
      throw new Error('A1_RESEARCH_ORDER_AUTHORIZATION_IMMUTABLE_CONFLICT')
    this.a1OrderAuthorizations.set(input.orderAuthorizationId, structuredClone(state))
    return structuredClone(state)
  }

  async getA1DispatchAuthorizationState(missionId: string): Promise<A1DispatchAuthorizationState | null> {
    const state = this.a1DispatchAuthorizations.get(missionId)
    return state ? structuredClone(state) : null
  }

  async recordA1DispatchAuthorization(input: RecordA1DispatchAuthorizationInput): Promise<A1DispatchAuthorizationState> {
    const state: A1DispatchAuthorizationState = {
      authorizationId: input.authorizationId,
      missionId: input.missionId,
      traceId: input.traceId,
      planVersion: input.planVersion,
      decision: input.decision,
      rationale: input.rationale,
      reviewerId: input.reviewerId,
      reviewerEmail: input.reviewerEmail,
      reviewedAt: input.reviewedAt,
      expiresAt: input.expiresAt,
      missionSha256: input.missionSha256,
      assignmentPlanSha256: input.assignmentPlanSha256,
      userAuthorizationSha256: input.userAuthorizationSha256,
      attestations: input.attestations,
      idempotencyKey: input.idempotencyKey,
      assignmentCreated: false,
      dispatchQueued: false,
      executionAuthorized: false,
      internetAccessAllowed: false,
      providerCreditSpendAllowed: false,
      contactPermitted: false,
      crmWriteAllowed: false,
      maximumExternalActions: 0,
      globalKillSwitchRequired: true,
      productionGate: 'blocked',
      nextRequiredGate: 'enqueue_exact_assignment_plan_separately',
      provenance: {
        source: 'control-broker',
        sourceId: `a1-dispatch-authorization:${input.authorizationId}`,
        observedAt: input.reviewedAt,
        synthetic: false,
      },
    }
    const existing = this.a1DispatchAuthorizations.get(input.missionId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(state))
      throw new Error('A1_DISPATCH_AUTHORIZATION_IMMUTABLE_CONFLICT')
    this.a1DispatchAuthorizations.set(input.missionId, structuredClone(state))
    return structuredClone(state)
  }

  async getA1AssignmentEnqueueAuthorizationState(missionId: string): Promise<A1AssignmentEnqueueAuthorizationState | null> {
    const state = this.a1AssignmentEnqueueAuthorizations.get(missionId)
    return state ? structuredClone(state) : null
  }

  async recordA1AssignmentEnqueueAuthorization(input: RecordA1AssignmentEnqueueAuthorizationInput): Promise<A1AssignmentEnqueueAuthorizationState> {
    const state: A1AssignmentEnqueueAuthorizationState = {
      authorizationId: input.authorizationId, missionId: input.missionId, traceId: input.traceId,
      planVersion: input.planVersion, dispatchAuthorizationId: input.dispatchAuthorizationId,
      decision: input.decision, rationale: input.rationale, reviewerId: input.reviewerId,
      reviewerEmail: input.reviewerEmail, reviewedAt: input.reviewedAt, expiresAt: input.expiresAt,
      missionSha256: input.missionSha256, assignmentPlanSha256: input.assignmentPlanSha256,
      userAuthorizationSha256: input.userAuthorizationSha256, attestations: input.attestations,
      idempotencyKey: input.idempotencyKey, enqueueAuthorizationRecorded: true,
      assignmentEnqueuePermitted: input.decision === 'approved', assignmentsEnqueued: false,
      executionAuthorized: false, dispatchClaimingPermitted: false, internetAccessAllowed: false,
      providerCreditSpendAllowed: false, contactPermitted: false, crmWriteAllowed: false,
      maximumExternalActions: 0, globalKillSwitchRequired: true, productionGate: 'blocked',
      nextRequiredGate: 'enqueue_exact_assignment_plan_separately',
      provenance: { source: 'control-broker', sourceId: `a1-assignment-enqueue-authorization:${input.authorizationId}`, observedAt: input.reviewedAt, synthetic: false },
    }
    const existing = this.a1AssignmentEnqueueAuthorizations.get(input.missionId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(state))
      throw new Error('A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_IMMUTABLE_CONFLICT')
    this.a1AssignmentEnqueueAuthorizations.set(input.missionId, structuredClone(state))
    return structuredClone(state)
  }

  async listShadowReviews(): Promise<ShadowReview[]> { return [] }
  async getShadowReview(_id: string): Promise<ShadowReview | null> { return null }
  async recordShadowDecision(_input: RecordShadowDecisionInput): Promise<ShadowReview> {
    throw new Error('SHADOW_REVIEW_NOT_FOUND')
  }
  async completeShadowReview(_input: CompleteShadowReviewInput): Promise<ShadowReview> {
    throw new Error('SHADOW_REVIEW_NOT_FOUND')
  }
  async listDraftReviews(): Promise<DraftReview[]> { return [] }
  async getDraftReview(_id: string): Promise<DraftReview | null> { return null }
  async recordDraftReviewItem(_input: RecordDraftReviewItemInput): Promise<DraftReview> {
    throw new Error('DRAFT_REVIEW_NOT_FOUND')
  }
  async completeDraftReview(_input: CompleteDraftReviewInput): Promise<DraftReview> {
    throw new Error('DRAFT_REVIEW_NOT_FOUND')
  }
  async getA1ResearchDossier(_reviewId: string): Promise<A1ResearchDossier | null> { return null }
  async getA1ResearchAuthorizationState(_reviewId: string, _dossierSha256: string): Promise<A1ResearchAuthorizationState | null> { return null }
  async recordA1ResearchAuthorization(_input: RecordA1ResearchAuthorizationInput): Promise<A1ResearchAuthorizationState> {
    throw new Error('A1_RESEARCH_DOSSIER_NOT_FOUND')
  }

  async getPolicyReviewState(): Promise<PolicyReviewState> {
    return inMemoryPolicyReviewState(this.policyReviews)
  }

  async recordPolicyReview(input: RecordPolicyReviewInput): Promise<PolicyReviewState> {
    const existing = this.policyReviews.get(input.kind)
    if (existing) {
      if (existing.idempotencyKey !== input.idempotencyKey || existing.requestSha256 !== input.requestSha256)
        throw new PolicyReviewError('POLICY_REVIEW_IMMUTABLE_CONFLICT')
      return inMemoryPolicyReviewState(this.policyReviews)
    }
    this.policyReviews.set(input.kind, structuredClone(input))
    return inMemoryPolicyReviewState(this.policyReviews)
  }

  async getPolicyActivationDossierState(): Promise<PolicyActivationDossierState> {
    const review = inMemoryPolicyReviewState(this.policyReviews)
    const globalKillSwitchActive = this.killSwitches.has('global:*')
    const emailKillSwitchActive = this.killSwitches.has('channel:email')
    return {
      projectId: 'proptimiza', policyVersion: 'policy-v2', policyDigest: review.policyDigest,
      reviewCompleted: review.reviewCompleted, authorizationRecorded: false, internalMailAttested: false,
      activePolicyVersion: 'policy-v1', policyEffective: false, externalContact: false,
      versionActivationCreated: false, deliveryPolicyCreated: false, deliveryPolicyActivationCreated: false,
      globalKillSwitchActive, emailKillSwitchActive, databaseGateSatisfied: false, activationAllowed: false,
      nextRequiredGate: review.reviewCompleted ? 'internal_mail_attestation' : 'human_reviews',
      provenance: { source: 'control-broker', sourceId: 'policy-activation-dossier:proptimiza:policy-v2', observedAt: new Date().toISOString(), synthetic: false },
    }
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
      return instructionResult(current, false, this.instructionReviews.get(current.request_id))
    }
    this.instructionRequests.set(record.idempotency_key, structuredClone(record))
    return instructionResult(record, true)
  }

  async listInstructionRequests(): Promise<InstructionRequestView[]> {
    return [...this.instructionRequests.values()]
      .map((record) => instructionView(record, this.instructionReviews.get(record.request_id)))
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
  }

  async getInstructionRequest(id: string): Promise<InstructionRequestView | null> {
    const record = [...this.instructionRequests.values()].find((candidate) => candidate.request_id === id)
    return record ? instructionView(record, this.instructionReviews.get(id)) : null
  }

  async reviewInstructionRequest(input: InstructionReviewInput): Promise<InstructionReviewResult> {
    const record = [...this.instructionRequests.values()].find((candidate) => candidate.request_id === input.requestId)
    if (!record) throw new Error('INSTRUCTION_REQUEST_NOT_FOUND')
    const current = this.instructionReviews.get(input.requestId)
    if (current) {
      if (current.idempotencyKey !== input.idempotencyKey || current.reviewRequestSha256 !== input.reviewRequestSha256)
        throw new Error('INSTRUCTION_REVIEW_CONFLICT')
      return instructionReviewResult(current, true)
    }
    if (record.instruction_sha256 !== input.expectedInstructionSha256)
      throw new Error('INSTRUCTION_REVIEW_CONFLICT')
    if (Date.parse(record.expires_at) <= Date.parse(input.reviewedAt))
      throw new Error('INSTRUCTION_REQUEST_EXPIRED')
    if (input.decision === 'convert' && !input.mission)
      throw new Error('INSTRUCTION_REVIEW_INVALID')
    if (input.decision === 'reject' && input.mission)
      throw new Error('INSTRUCTION_REVIEW_INVALID')
    if (input.mission) this.missions.set(input.mission.mission_id, structuredClone(input.mission))
    this.instructionReviews.set(input.requestId, structuredClone(input))
    return instructionReviewResult(input, false)
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
  review?: InstructionReviewInput,
): InstructionRequestResult {
  return {
    request_id: record.request_id,
    project_id: record.project_id,
    title: record.title,
    status: review ? (review.decision === 'convert' ? 'converted' : 'rejected') : 'pending_codex_review',
    autonomy_ceiling: record.autonomy_ceiling,
    requires_codex_review: true,
    external_actions_allowed: false,
    created_at: record.created_at,
    expires_at: record.expires_at,
    created,
  }
}

function instructionView(
  record: InstructionRequestRecord,
  review?: InstructionReviewInput,
): InstructionRequestView {
  return {
    ...structuredClone(record),
    status: review ? (review.decision === 'convert' ? 'converted' : 'rejected') : 'pending_codex_review',
    requires_codex_review: true,
    external_actions_allowed: false,
    reviewed_by: review?.actorId ?? null,
    reviewed_at: review?.reviewedAt ?? null,
    review_reason: review?.reason ?? null,
    converted_mission_id: review?.mission?.mission_id ?? null,
  }
}

function instructionReviewResult(
  input: InstructionReviewInput,
  replayed: boolean,
): InstructionReviewResult {
  return {
    request_id: input.requestId,
    status: input.decision === 'convert' ? 'converted' : 'rejected',
    reviewed_by: input.actorId,
    reviewed_at: input.reviewedAt,
    review_reason: input.reason,
    converted_mission_id: input.mission?.mission_id ?? null,
    replayed,
    external_actions_allowed: false,
  }
}

function inMemoryPolicyReviewState(reviews: Map<string, RecordPolicyReviewInput>): PolicyReviewState {
  const project = (input: RecordPolicyReviewInput | undefined) => input ? {
    kind: input.kind,
    decision: input.decision,
    rationale: input.rationale,
    reviewerId: input.reviewerId,
    reviewerEmail: input.reviewerEmail,
    reviewedAt: input.reviewedAt,
    policyDigest: input.expectedPolicyDigest,
    attestations: structuredClone(input.attestations),
  } : null
  const commercial = project(reviews.get('commercial'))
  const privacyLegal = project(reviews.get('privacy_legal'))
  return {
    projectId: 'proptimiza',
    policyVersion: 'policy-v2',
    policyDigest: '888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19',
    draftStatus: 'draft_human_approval_required',
    effective: false,
    externalContact: false,
    activePolicyVersion: 'policy-v1',
    commercialReview: commercial,
    privacyLegalReview: privacyLegal,
    reviewCompleted: commercial?.decision === 'approved' && privacyLegal?.decision === 'approved',
    activationCreated: false,
    provenance: { source: 'control-broker', sourceId: 'policy-review:proptimiza:policy-v2', observedAt: new Date().toISOString(), synthetic: false },
  }
}
