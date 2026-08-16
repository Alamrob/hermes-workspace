export class ValidationError extends Error {
  constructor(readonly issues: string[]) {
    super('invalid work order')
    this.name = 'ValidationError'
  }
}

const REQUIRED_FIELDS = [
  'mission_id',
  'trace_id',
  'created_at',
  'expires_at',
  'project_id',
  'project_version',
  'offer_id',
  'offer_version',
  'icp_version',
  'policy_version',
  'objective',
  'business_context',
  'target_segment',
  'allowed_actions',
  'prohibited_actions',
  'approved_channels',
  'approved_tools',
  'autonomy_level',
  'budget_limit',
  'volume_limits',
  'success_criteria',
  'stop_conditions',
  'required_evidence',
  'approval_token',
  'idempotency_key',
  'requested_by',
  'authority',
  'data_policy',
  'contact_policy',
  'dry_run',
] as const

const OPTIONAL_FIELDS = ['metadata'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type WorkOrder = Record<(typeof REQUIRED_FIELDS)[number], unknown> & {
  mission_id: string
  trace_id: string
  autonomy_level: 'A0' | 'A1' | 'A2' | 'A3' | 'A4'
  dry_run: boolean
  metadata?: Record<string, unknown>
}

export function validateWorkOrder(value: unknown): WorkOrder {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(['work order must be an object'])
  }
  const candidate = value as Record<string, unknown>
  const issues: string[] = REQUIRED_FIELDS.filter((field) => !(field in candidate)).map(
    (field) => `${field} is required`,
  )
  const allowed = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS])
  for (const field of Object.keys(candidate)) {
    if (!allowed.has(field)) issues.push(`${field} is not allowed`)
  }
  for (const field of ['mission_id', 'trace_id'] as const) {
    if (field in candidate && (typeof candidate[field] !== 'string' || !UUID.test(candidate[field]))) {
      issues.push(`${field} must be a UUID`)
    }
  }
  for (const field of ['created_at', 'expires_at'] as const) {
    if (field in candidate && (typeof candidate[field] !== 'string' || !Number.isFinite(Date.parse(candidate[field])))) {
      issues.push(`${field} must be an ISO date-time`)
    }
  }
  if (
    typeof candidate.created_at === 'string' &&
    typeof candidate.expires_at === 'string' &&
    Date.parse(candidate.expires_at) <= Date.parse(candidate.created_at)
  ) {
    issues.push('expires_at must be after created_at')
  }
  for (const field of [
    'project_id',
    'project_version',
    'offer_id',
    'offer_version',
    'icp_version',
    'policy_version',
    'objective',
    'business_context',
    'target_segment',
    'idempotency_key',
    'requested_by',
  ] as const) {
    if (field in candidate && (typeof candidate[field] !== 'string' || candidate[field].trim() === '')) {
      issues.push(`${field} must be a non-empty string`)
    }
  }
  for (const field of [
    'allowed_actions',
    'prohibited_actions',
    'approved_channels',
    'approved_tools',
    'success_criteria',
    'stop_conditions',
    'required_evidence',
  ] as const) {
    if (
      field in candidate &&
      (!Array.isArray(candidate[field]) || candidate[field].some((entry) => typeof entry !== 'string'))
    ) {
      issues.push(`${field} must be a string array`)
    }
  }
  if (
    'autonomy_level' in candidate &&
    !['A0', 'A1', 'A2', 'A3', 'A4'].includes(String(candidate.autonomy_level))
  ) {
    issues.push('autonomy_level is invalid')
  }
  if ('dry_run' in candidate && typeof candidate.dry_run !== 'boolean') {
    issues.push('dry_run must be a boolean')
  }
  for (const field of [
    'budget_limit',
    'volume_limits',
    'authority',
    'data_policy',
    'contact_policy',
    'metadata',
  ] as const) {
    if (
      field in candidate &&
      (candidate[field] === null || typeof candidate[field] !== 'object' || Array.isArray(candidate[field]))
    ) {
      issues.push(`${field} must be an object`)
    }
  }
  if (issues.length > 0) throw new ValidationError(issues)
  return candidate as WorkOrder
}
