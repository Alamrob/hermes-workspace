import type { Pool, PoolClient } from 'pg'
import type { ApprovalAction } from './approvals.js'
import { sanitizeAuditEvent, type AuditSink, type StructuredAuditEvent } from './observability.js'
import type {
  ApprovalGrantRecord,
  ApprovalRequestRecord,
  MissionRecord,
  RuntimeRepository,
  WebhookEventRecord,
} from './repository.js'

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
  constructor(private readonly pool: Pool) {}

  async ready(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1 FROM control.kill_switch_guard WHERE guard_id = $1', [1])
      return true
    } catch {
      return false
    }
  }

  async saveMission(record: MissionRecord): Promise<void> {
    const idempotencyKey = record.idempotency_key
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new Error('MISSION_IDEMPOTENCY_KEY_REQUIRED')
    }
    const payload = JSON.stringify(record)
    const inserted = await this.pool.query(
      `INSERT INTO control.missions (mission_id, idempotency_key, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING mission_id`,
      [record.mission_id, idempotencyKey, payload],
    )
    if (inserted.rowCount === 1) return
    const same = await this.pool.query(
      `SELECT 1
       FROM control.missions
       WHERE (mission_id = $1 OR idempotency_key = $2)
         AND payload = $3::jsonb`,
      [record.mission_id, idempotencyKey, payload],
    )
    if (same.rowCount !== 1) throw new Error('MISSION_CONFLICT')
  }

  async getMission(id: string): Promise<MissionRecord | null> {
    const result = await this.pool.query<{ payload: MissionRecord }>(
      'SELECT payload FROM control.missions WHERE mission_id = $1',
      [id],
    )
    return result.rows[0]?.payload ?? null
  }

  async isMissionA3Enabled(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM control.missions
       WHERE mission_id = $1
         AND payload @> $2::jsonb`,
      [id, JSON.stringify({ autonomy_level: 'A3', a3_enabled: true })],
    )
    return result.rowCount === 1
  }

  async storeWebhookEvent(record: WebhookEventRecord): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO mail.webhook_events (
         mailbox_key, provider_event_id, received_at, trust_classification,
         instruction_eligible, untrusted_payload
       ) VALUES ($1, $2, $3::timestamptz, $4, $5, $6::jsonb)
       ON CONFLICT (mailbox_key, provider_event_id) DO NOTHING
       RETURNING provider_event_id`,
      [
        record.mailbox_key,
        record.provider_event_id,
        record.received_at,
        record.trust_classification,
        record.instruction_eligible,
        JSON.stringify(record.untrusted_payload),
      ],
    )
    return result.rowCount === 1
  }

  async createApprovalRequest(record: ApprovalRequestRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO control.approvals (
         approval_id, action, action_hash, requested_at, status
       ) VALUES ($1, $2::jsonb, $3, $4::timestamptz, $5)`,
      [
        record.approval_id,
        JSON.stringify(record.action),
        record.action_hash,
        record.requested_at,
        record.status,
      ],
    )
  }

  async getApprovalRequest(
    id: string,
  ): Promise<ApprovalRequestRecord | ApprovalGrantRecord | null> {
    const result = await this.pool.query<ApprovalRow>(
      'SELECT * FROM control.approvals WHERE approval_id = $1',
      [id],
    )
    return result.rows[0] ? approvalFromRow(result.rows[0]) : null
  }

  async saveApprovalDecision(
    record: ApprovalGrantRecord | (ApprovalRequestRecord & { status: 'denied' }),
  ): Promise<boolean> {
    const approved = record.status === 'approved' ? record : null
    const result = await this.pool.query(
      `UPDATE control.approvals
       SET status = $2,
           approved_by = $3,
           expires_at = $4::timestamptz,
           nonce = $5,
           token = $6,
           consumed_at = $7::timestamptz
       WHERE approval_id = $1
         AND status = 'pending'
         AND action = $8::jsonb
         AND action_hash = $9
         AND requested_at = $10::timestamptz
       RETURNING approval_id`,
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
    return result.rowCount === 1
  }

  async consumeApproval(input: {
    missionId: string
    actionHash: string
    nonce: string
    now: string
  }): Promise<ApprovalGrantRecord | null> {
    const result = await this.pool.query<ApprovalRow>(
      `UPDATE control.approvals
       SET consumed_at = $4::timestamptz
       WHERE status = 'approved'
         AND action ->> 'mission_id' = $1
         AND action_hash = $2
         AND nonce = $3
         AND consumed_at IS NULL
         AND expires_at > $4::timestamptz
       RETURNING *`,
      [input.missionId, input.actionHash, input.nonce, input.now],
    )
    if (result.rowCount === 0) return null
    if (result.rowCount !== 1) throw new Error('APPROVAL_CONSUMPTION_CONFLICT')
    const row = result.rows[0]!
    const record = approvalFromRow(row)
    return record.status === 'approved' ? record : null
  }

  async isKillSwitchActive(input: { missionId: string; channel: string }): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM control.kill_switches
       WHERE active = TRUE
         AND (
           (scope = 'global' AND scope_id = '*')
           OR (scope = 'mission' AND scope_id = $1)
           OR (scope = 'channel' AND scope_id = $2)
         )
       LIMIT 1`,
      [input.missionId, input.channel],
    )
    return result.rowCount === 1
  }

  async activateKillSwitch(scope: string, scopeId: string): Promise<void> {
    if (!['global', 'mission', 'channel'].includes(scope)) {
      throw new Error('INVALID_KILL_SWITCH_SCOPE')
    }
    await inTransaction(this.pool, async (client) => {
      await lockKillSwitchGuard(client)
      await client.query(
        `INSERT INTO control.kill_switches (scope, scope_id, active, activated_at)
         VALUES ($1, $2, TRUE, clock_timestamp())
         ON CONFLICT (scope, scope_id)
         DO UPDATE SET active = TRUE, activated_at = EXCLUDED.activated_at`,
        [scope, scopeId],
      )
    })
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
    return inTransaction(this.pool, async (client) => {
      await lockKillSwitchGuard(client)
      const killed = await client.query(
        `SELECT 1
         FROM control.kill_switches
         WHERE active = TRUE
           AND (
             (scope = 'global' AND scope_id = '*')
             OR (scope = 'mission' AND scope_id = $1)
             OR (scope = 'channel' AND scope_id = $2)
           )
         LIMIT 1`,
        [input.missionId, input.channel],
      )
      if (killed.rowCount === 1) throw new Error('KILL_SWITCH_ACTIVE')

      const inserted = await client.query(
        `INSERT INTO mail.external_actions (mission_id, idempotency_key, action_hash, channel)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (mission_id, idempotency_key) DO NOTHING
         RETURNING mission_id`,
        [input.missionId, input.idempotencyKey, input.actionHash, input.channel],
      )
      if (inserted.rowCount === 1) return { status: 'acquired' as const }

      const existing = await client.query<{
        channel: string
        action_hash: string
        receipt_id: string | null
        approval_id: string | null
      }>(
        `SELECT channel, action_hash, receipt_id, approval_id
         FROM mail.external_actions
         WHERE mission_id = $1 AND idempotency_key = $2`,
        [input.missionId, input.idempotencyKey],
      )
      const action = existing.rows[0]
      if (!action || action.channel !== input.channel || action.action_hash !== input.actionHash) throw new Error('IDEMPOTENCY_CONFLICT')
      if (action.receipt_id && action.approval_id) {
        return {
          status: 'completed' as const,
          receipt_id: action.receipt_id,
          approval_id: action.approval_id,
        }
      }
      throw new Error('EXECUTION_IN_PROGRESS')
    })
  }

  async completeExternalAction(input: {
    missionId: string
    idempotencyKey: string
    actionHash: string
    receipt_id: string
    approval_id: string
  }): Promise<void> {
    const completed = await this.pool.query(
      `UPDATE mail.external_actions
       SET receipt_id = $4,
           approval_id = $5,
           completed_at = clock_timestamp()
       WHERE mission_id = $1
         AND idempotency_key = $2
         AND action_hash = $3
         AND receipt_id IS NULL
         AND approval_id IS NULL
       RETURNING mission_id`,
      [input.missionId, input.idempotencyKey, input.actionHash, input.receipt_id, input.approval_id],
    )
    if (completed.rowCount === 1) return
    const same = await this.pool.query(
      `SELECT 1
       FROM mail.external_actions
       WHERE mission_id = $1
         AND idempotency_key = $2
          AND action_hash = $3
          AND receipt_id = $4
          AND approval_id = $5`,
      [input.missionId, input.idempotencyKey, input.actionHash, input.receipt_id, input.approval_id],
    )
    if (same.rowCount !== 1) throw new Error('EXTERNAL_ACTION_COMPLETION_CONFLICT')
  }
}

export class PostgresAuditSink implements AuditSink {
  constructor(private readonly pool: Pool) {}

  async record(event: StructuredAuditEvent): Promise<void> {
    await this.pool.query('INSERT INTO control.audit_events (event) VALUES ($1::jsonb)', [
      JSON.stringify(sanitizeAuditEvent(event)),
    ])
  }
}

function approvalFromRow(row: ApprovalRow): ApprovalRequestRecord | ApprovalGrantRecord {
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
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

async function lockKillSwitchGuard(client: PoolClient): Promise<void> {
  await client.query(
    'SELECT guard_id FROM control.kill_switch_guard WHERE guard_id = $1 FOR UPDATE',
    [1],
  )
}

async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
