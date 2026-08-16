import type {
  ApprovalChannelEvidence,
  ApprovalEvidenceStorePort,
} from './approval-mode.js'

interface QueryPort {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>
}

export class PostgresApprovalEvidenceStore
  implements ApprovalEvidenceStorePort
{
  constructor(private readonly database: QueryPort) {}

  async record(evidence: ApprovalChannelEvidence): Promise<void> {
    const result = await this.database.query(
      `SELECT control.record_approval_channel_evidence(
        $1::uuid,$2,$3,$4,$5,$6::timestamptz
      ) AS recorded`,
      [
        evidence.approvalId,
        evidence.actionHash,
        evidence.channel,
        evidence.decision,
        evidence.actorId,
        evidence.decidedAt,
      ],
    )
    if (result.rows[0]?.recorded !== true)
      throw new Error('APPROVAL_EVIDENCE_NOT_RECORDED')
  }

  async list(approvalId: string): Promise<ApprovalChannelEvidence[]> {
    const result = await this.database.query(
      `SELECT approval_id,action_hash,channel,decision,actor_id,decided_at
       FROM control.list_approval_channel_evidence($1::uuid)`,
      [approvalId],
    )
    return result.rows.map((row) => ({
      approvalId: requireText(row.approval_id, 'approval_id'),
      actionHash: requireText(row.action_hash, 'action_hash'),
      channel: requireChannel(row.channel),
      decision: requireDecision(row.decision),
      actorId: requireText(row.actor_id, 'actor_id'),
      decidedAt: normalizeTimestamp(row.decided_at),
    }))
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string')
    throw new Error(`INVALID_APPROVAL_EVIDENCE_ROW:${field}`)
  return value
}

function requireChannel(value: unknown): ApprovalChannelEvidence['channel'] {
  if (value !== 'sales' && value !== 'telegram')
    throw new Error('INVALID_APPROVAL_EVIDENCE_ROW:channel')
  return value
}

function requireDecision(value: unknown): ApprovalChannelEvidence['decision'] {
  if (value !== 'approved' && value !== 'denied')
    throw new Error('INVALID_APPROVAL_EVIDENCE_ROW:decision')
  return value
}

function normalizeTimestamp(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.valueOf()))
    return value.toISOString()
  if (typeof value === 'string' && Number.isFinite(Date.parse(value)))
    return new Date(value).toISOString()
  throw new Error('INVALID_APPROVAL_EVIDENCE_ROW:decided_at')
}
