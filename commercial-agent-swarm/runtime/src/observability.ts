import { createHash } from 'node:crypto'

export interface StructuredAuditEvent {
  mission_id: string | null
  agent_id: string
  tool_action: string
  started_at: string
  completed_at: string
  duration_ms: number
  token_cost: { input_tokens: number; output_tokens: number; currency: string; amount: number }
  redacted_input: string
  result: string | null
  error: string | null
  retries: number
  external_action: boolean
  approval_reference: string | null
  receipt_reference: string | null
  evidence: string[]
  state_changes: string[]
  deployed_version: string
}

export interface AuditSink {
  record(event: StructuredAuditEvent): Promise<void>
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: StructuredAuditEvent[] = []

  async record(event: StructuredAuditEvent): Promise<void> {
    this.events.push(sanitizeAuditEvent(event))
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^sha256:[0-9a-f]{64}$/
const SAFE_RECEIPT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/
const SAFE_TOOLS = new Set([
  'work_order.create',
  'mission.get',
  'approval.request',
  'approval.decision',
  'mail.send',
  'webhook.ingest',
  'runtime.unknown',
])
const SAFE_ERRORS = new Set([
  'INVALID_AUTHORITY',
  'INVALID_PROJECT',
  'EXPIRED_AUTHORITY',
  'AUTHORITY_NOT_YET_VALID',
  'INVALID_SIGNATURE',
  'UNAUTHORIZED',
  'UNAUTHORIZED_APPROVER',
  'NOT_PENDING',
  'INVALID_TTL',
  'TOKEN_REQUIRED',
  'MALFORMED_TOKEN',
  'CONTENT_MISMATCH',
  'EXPIRED',
  'KILL_SWITCH_ACTIVE',
  'REPLAYED',
  'INVALID_ACTION',
  'SENDER_NOT_ALLOWED',
  'RECIPIENT_NOT_ALLOWED',
  'VOLUME_NOT_ALLOWED',
  'ACTION_NOT_ALLOWED',
  'A3_DISABLED',
  'MISSION_POLICY_DENIED',
  'IDEMPOTENCY_CONFLICT',
  'EXECUTION_IN_PROGRESS',
  'VALIDATION_ERROR',
  'UNEXPECTED_ERROR',
])

export function sanitizeAuditEvent(event: StructuredAuditEvent): StructuredAuditEvent {
  const result = typeof event.result === 'string' && /^status:[1-5][0-9]{2}$/.test(event.result)
    ? event.result
    : null
  const error = event.error === null
    ? null
    : event.error === 'invalid work order'
      ? 'VALIDATION_ERROR'
      : SAFE_ERRORS.has(event.error)
        ? event.error
        : 'UNEXPECTED_ERROR'
  return {
    mission_id: typeof event.mission_id === 'string' && UUID.test(event.mission_id) ? event.mission_id : null,
    agent_id: 'commercial-broker',
    tool_action: SAFE_TOOLS.has(event.tool_action) ? event.tool_action : 'runtime.unknown',
    started_at: safeTimestamp(event.started_at),
    completed_at: safeTimestamp(event.completed_at),
    duration_ms: Number.isFinite(event.duration_ms) && event.duration_ms >= 0 ? event.duration_ms : 0,
    token_cost: {
      input_tokens: safeNonNegative(event.token_cost.input_tokens),
      output_tokens: safeNonNegative(event.token_cost.output_tokens),
      currency: /^[A-Z]{3}$/.test(event.token_cost.currency) ? event.token_cost.currency : 'USD',
      amount: safeNonNegative(event.token_cost.amount),
    },
    redacted_input: HASH.test(event.redacted_input) ? event.redacted_input : digest(event.redacted_input),
    result,
    error,
    retries: Number.isInteger(event.retries) && event.retries >= 0 ? event.retries : 0,
    external_action: event.external_action === true,
    approval_reference: typeof event.approval_reference === 'string' && UUID.test(event.approval_reference) ? event.approval_reference : null,
    receipt_reference: safeReceipt(event.receipt_reference),
    evidence: event.evidence.map((entry) => HASH.test(entry) ? entry : digest(entry)),
    state_changes: event.state_changes.filter((entry) => SAFE_TOOLS.has(entry)),
    deployed_version: SAFE_VERSION.test(event.deployed_version) ? event.deployed_version : 'unknown',
  }
}

function safeReceipt(value: string | null): string | null {
  if (typeof value !== 'string' || !SAFE_RECEIPT.test(value)) return null
  if (/^(?:APPROVAL|Bearer|sk-)/i.test(value)) return null
  return value
}

function safeTimestamp(value: string): string {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : new Date(0).toISOString()
}

function safeNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
