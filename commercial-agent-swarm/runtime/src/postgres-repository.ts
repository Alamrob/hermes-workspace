import { sanitizeAuditEvent } from './observability.js'
import type { AuditSink, StructuredAuditEvent } from './observability.js'
import type { Pool } from 'pg'
import type { ApprovalAction } from './approvals.js'
import type {
  ApprovalGrantRecord,
  ApprovalRequestRecord,
  MissionRecord,
  InstructionRequestRecord,
  InstructionRequestResult,
  RuntimeRepository,
  WebhookEventRecord,
} from './repository.js'
import {
  validatePortfolioReadModel,
  type PortfolioReadModel,
} from './portfolio-read-model.js'
import {
  validateShadowReview,
  validateShadowReviewList,
  type CompleteShadowReviewInput,
  type RecordShadowDecisionInput,
  type ShadowReview,
} from './shadow-review.js'

type ApprovalRow = {
  approval_id: string
  action: ApprovalAction
  action_hash: string
  requested_at: Date | string
  status: 'pending' | 'approved' | 'denied'
  approved_by: string | null
  expires_at: Date | string | null
  nonce: string | null
  token: string | null
  consumed_at: Date | string | null
}

export class PostgresRuntimeRepository implements RuntimeRepository {
  private readonly ingestorPool: Pool
  private readonly approverPool: Pool
  private readonly safetyPool: Pool

  constructor(
    private readonly pool: Pool,
    capabilities: {
      ingestorPool?: Pool
      approverPool?: Pool
      safetyPool?: Pool
    } = {},
  ) {
    this.ingestorPool = capabilities.ingestorPool ?? pool
    this.approverPool = capabilities.approverPool ?? pool
    this.safetyPool = capabilities.safetyPool ?? pool
  }

  async ready(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(
        'SELECT control.runtime_ready() AS ready',
      )
      return result.rows[0]?.ready === true
    } catch {
      return false
    }
  }

  async getPortfolioReadModel(): Promise<PortfolioReadModel> {
    const result = await this.pool.query<{ model: PortfolioReadModel }>(
      'SELECT control.get_portfolio_read_model() AS model',
    )
    const model = result.rows[0]?.model
    if (!model) throw new Error('PORTFOLIO_READ_MODEL_UNAVAILABLE')
    return validatePortfolioReadModel(model)
  }

  async saveMission(record: MissionRecord): Promise<void> {
    const idempotencyKey = record.idempotency_key
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new Error('MISSION_IDEMPOTENCY_KEY_REQUIRED')
    }
    const payload = JSON.stringify(record)
    await this.ingestorPool.query(
      'SELECT control.save_mission($1::uuid,$2,$3::jsonb)',
      [record.mission_id, idempotencyKey, payload],
    )
  }

  async getMission(id: string): Promise<MissionRecord | null> {
    const result = await this.pool.query<{ payload: MissionRecord }>(
      'SELECT control.get_mission($1::uuid) AS payload',
      [id],
    )
    return result.rows[0]?.payload ?? null
  }

  async isMissionA3Enabled(id: string): Promise<boolean> {
    const result = await this.pool.query<{ enabled: boolean }>(
      'SELECT control.is_mission_a3($1::uuid) AS enabled',
      [id],
    )
    return result.rows[0]?.enabled === true
  }

  async deliveryPolicyAllows(action: ApprovalAction): Promise<boolean> {
    const result = await this.pool.query<{ allowed: boolean }>(
      'SELECT mail.delivery_policy_allows($1,$2,$3,$4,$5) AS allowed',
      [
        action.project_id,
        action.policy_version,
        action.sender,
        action.recipients[0] ?? '',
        action.volume,
      ],
    )
    return result.rows[0]?.allowed === true
  }

  async storeWebhookEvent(record: WebhookEventRecord): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT mail.store_webhook_event($1,$2,$3::timestamptz,$4,$5,$6::jsonb) AS inserted',
      [
        record.mailbox_key,
        record.provider_event_id,
        record.received_at,
        record.trust_classification,
        record.instruction_eligible,
        JSON.stringify(record.untrusted_payload),
      ],
    )
    return result.rows[0]?.inserted === true
  }

  async createApprovalRequest(record: ApprovalRequestRecord): Promise<void> {
    await this.pool.query(
      'SELECT control.request_approval($1::uuid,$2::jsonb,$3,$4::timestamptz)',
      [
        record.approval_id,
        JSON.stringify(record.action),
        record.action_hash,
        record.requested_at,
      ],
    )
  }

  async getApprovalRequest(
    id: string,
  ): Promise<ApprovalRequestRecord | ApprovalGrantRecord | null> {
    const result = await this.approverPool.query<ApprovalRow>(
      'SELECT * FROM control.get_pending_approval($1::uuid)',
      [id],
    )
    return result.rows[0] ? approvalFromRow(result.rows[0]) : null
  }

  async saveApprovalDecision(
    record:
      | ApprovalGrantRecord
      | (ApprovalRequestRecord & { status: 'denied' }),
  ): Promise<boolean> {
    const approved = record.status === 'approved' ? record : null
    const result = await this.approverPool.query<{ decided: boolean }>(
      `SELECT control.decide_approval($1::uuid,$2,$3,$4::timestamptz,$5,$6,$7::timestamptz,$8::jsonb,$9,$10::timestamptz) AS decided`,
      [
        record.approval_id,
        record.status,
        approved?.approved_by ?? null,
        approved?.expires_at ?? null,
        approved?.nonce ?? null,
        approved?.token ?? null,
        approved?.consumed_at ?? null,
        JSON.stringify(record.action),
        record.action_hash,
        record.requested_at,
      ],
    )
    return result.rows[0]?.decided === true
  }

  async consumeApproval(input: {
    missionId: string
    actionHash: string
    nonce: string
    now: string
  }): Promise<ApprovalGrantRecord | null> {
    const result = await this.pool.query<ApprovalRow>(
      'SELECT * FROM control.consume_approval($1,$2,$3,$4::timestamptz)',
      [input.missionId, input.actionHash, input.nonce, input.now],
    )
    if (result.rowCount === 0) return null
    if (result.rowCount !== 1) throw new Error('APPROVAL_CONSUMPTION_CONFLICT')
    const row = result.rows[0]
    const record = approvalFromRow(row)
    return record.status === 'approved' ? record : null
  }

  async isKillSwitchActive(input: {
    missionId: string
    channel: string
  }): Promise<boolean> {
    const result = await this.pool.query<{ active: boolean }>(
      'SELECT control.is_kill_switch_active($1,$2) AS active',
      [input.missionId, input.channel],
    )
    return result.rows[0]?.active === true
  }

  async listShadowReviews(): Promise<ShadowReview[]> {
    const result = await this.pool.query<{ reviews: unknown }>(
      'SELECT control.list_shadow_reviews() AS reviews',
    )
    return validateShadowReviewList(result.rows[0]?.reviews)
  }

  async getShadowReview(id: string): Promise<ShadowReview | null> {
    const result = await this.pool.query<{ review: unknown }>(
      'SELECT control.get_shadow_review($1::uuid) AS review',
      [id],
    )
    const review = result.rows[0]?.review
    return review === null || review === undefined ? null : validateShadowReview(review)
  }

  async recordShadowDecision(input: RecordShadowDecisionInput): Promise<ShadowReview> {
    const result = await this.pool.query<{ review: unknown }>(
      'SELECT control.record_shadow_review_decision($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS review',
      [input.reviewId,input.accountSlot,input.dimension,input.humanValue,input.rationale,input.evidenceUrl,input.expectedVersion,input.actorId,input.idempotencyKey,input.requestSha256],
    )
    return validateShadowReview(result.rows[0]?.review)
  }

  async completeShadowReview(input: CompleteShadowReviewInput): Promise<ShadowReview> {
    const result = await this.pool.query<{ review: unknown }>(
      'SELECT control.complete_shadow_review($1::uuid,$2,$3,$4,$5) AS review',
      [input.reviewId,input.expectedVersion,input.actorId,input.idempotencyKey,input.requestSha256],
    )
    return validateShadowReview(result.rows[0]?.review)
  }

  async createInstructionRequest(
    record: InstructionRequestRecord,
  ): Promise<InstructionRequestResult> {
    const result = await this.ingestorPool.query<{ result: InstructionRequestResult }>(
      `SELECT control.create_instruction_request(
        $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12::jsonb
      ) AS result`,
      [
        record.request_id,
        record.idempotency_key,
        record.project_id,
        record.title,
        record.instruction,
        record.instruction_sha256,
        record.requested_by,
        record.source,
        record.autonomy_ceiling,
        record.created_at,
        record.expires_at,
        JSON.stringify(record.metadata),
      ],
    )
    const created = result.rows[0]?.result
    if (!created) throw new Error('INSTRUCTION_REQUEST_UNAVAILABLE')
    return created
  }

  async externalActionsBlocked(): Promise<boolean> {
    const result = await this.pool.query<{ blocked: boolean }>(
      'SELECT control.external_actions_blocked() AS blocked',
    )
    return result.rows[0]?.blocked === true
  }

  async activateKillSwitch(scope: string, scopeId: string): Promise<void> {
    if (!['global', 'mission', 'channel'].includes(scope)) {
      throw new Error('INVALID_KILL_SWITCH_SCOPE')
    }
    await this.safetyPool.query('SELECT control.set_kill_switch($1,$2,TRUE)', [
      scope,
      scopeId,
    ])
  }

  async claimExternalAction(input: {
    missionId: string
    channel: string
    idempotencyKey: string
    actionHash: string
  }): Promise<
    | { status: 'acquired' }
    | { status: 'completed'; receipt_id: string; approval_id: string }
  > {
    const result = await this.pool.query<{
      status: 'acquired' | 'completed'
      receipt_id: string | null
      approval_id: string | null
    }>('SELECT * FROM mail.claim_external_action($1::uuid,$2,$3,$4)', [
      input.missionId,
      input.channel,
      input.idempotencyKey,
      input.actionHash,
    ])
    const row = result.rows[0]
    return row.status === 'completed'
      ? {
          status: 'completed',
          receipt_id: row.receipt_id!,
          approval_id: row.approval_id!,
        }
      : { status: 'acquired' }
  }

  async completeExternalAction(input: {
    missionId: string
    idempotencyKey: string
    actionHash: string
    receipt_id: string
    approval_id: string
  }): Promise<void> {
    const completed = await this.pool.query<{ completed: boolean }>(
      'SELECT mail.complete_external_action($1::uuid,$2,$3,$4,$5::uuid) AS completed',
      [
        input.missionId,
        input.idempotencyKey,
        input.actionHash,
        input.receipt_id,
        input.approval_id,
      ],
    )
    if (completed.rows[0]?.completed !== true)
      throw new Error('EXTERNAL_ACTION_COMPLETION_CONFLICT')
  }
}

export class PostgresAuditSink implements AuditSink {
  constructor(private readonly pool: Pool) {}

  async record(event: StructuredAuditEvent): Promise<void> {
    await this.pool.query('SELECT control.record_audit_event($1::jsonb)', [
      JSON.stringify(sanitizeAuditEvent(event)),
    ])
  }
}

function approvalFromRow(
  row: ApprovalRow,
): ApprovalRequestRecord | ApprovalGrantRecord {
  const base = {
    approval_id: row.approval_id,
    action: row.action,
    action_hash: row.action_hash,
    requested_at: iso(row.requested_at),
  }
  if (row.status !== 'approved') return { ...base, status: row.status }
  if (!row.approved_by || !row.expires_at || !row.nonce || !row.token) {
    throw new Error('INVALID_APPROVAL_ROW')
  }
  return {
    ...base,
    status: 'approved',
    approved_by: row.approved_by,
    expires_at: iso(row.expires_at),
    nonce: row.nonce,
    token: row.token,
    consumed_at: row.consumed_at ? iso(row.consumed_at) : null,
  }
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}
