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
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const ACTION = /^[a-z][a-z0-9._:-]{1,127}$/
const TOOL = /^[a-z][a-z0-9._:-]{0,127}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/
const LOCAL_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
const APPROVAL_TOKEN = /^APPROVAL::[0-9a-fA-F-]{36}::[0-9a-f]{64}::\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})::[^:]{16,256}::[0-9a-f]{64}$/

const CHANNELS = new Set([
  'none',
  'internal',
  'public_web',
  'crm',
  'email',
  'whatsapp',
  'calendar',
  'web_chat',
  'telephone',
])
const AUTONOMY_LEVELS = new Set(['A0', 'A1', 'A2', 'A3', 'A4'])
const DATA_CLASSIFICATIONS = new Set(['public', 'internal', 'confidential', 'restricted'])
const LEGAL_BASES = new Set([
  'consent',
  'contract',
  'legal_obligation',
  'legitimate_interest_reviewed',
  'public_source_reviewed',
  'none',
])
const VOLUME_PERIODS = new Set(['mission', 'hour', 'day', 'week'])

export type WorkOrder = Record<(typeof REQUIRED_FIELDS)[number], unknown> & {
  mission_id: string
  trace_id: string
  autonomy_level: 'A0' | 'A1' | 'A2' | 'A3' | 'A4'
  dry_run: boolean
  metadata?: Record<string, unknown>
}

export function validateWorkOrder(value: unknown): WorkOrder {
  if (!isRecord(value)) throw new ValidationError(['work order must be an object'])
  const candidate = value
  const issues: string[] = []
  const allowed = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS])

  for (const field of REQUIRED_FIELDS) {
    if (!(field in candidate)) issues.push(`${field} is required`)
  }
  for (const field of Object.keys(candidate)) {
    if (!allowed.has(field)) issues.push(`${field} is not allowed`)
  }

  for (const field of ['mission_id', 'trace_id'] as const) {
    if (field in candidate && (typeof candidate[field] !== 'string' || !UUID.test(candidate[field]))) {
      issues.push(`${field} must be a UUID`)
    }
  }

  for (const field of ['created_at', 'expires_at'] as const) {
    if (field in candidate && !isDateTime(candidate[field])) issues.push(`${field} must be an ISO date-time`)
  }
  if (
    isDateTime(candidate.created_at) &&
    isDateTime(candidate.expires_at) &&
    Date.parse(candidate.expires_at) <= Date.parse(candidate.created_at)
  ) {
    issues.push('expires_at must be after created_at')
  }

  const boundedStrings: Array<[string, number]> = [
    ['project_id', 128],
    ['project_version', 128],
    ['offer_id', 128],
    ['offer_version', 128],
    ['icp_version', 128],
    ['policy_version', 128],
    ['objective', 2000],
    ['business_context', 10000],
    ['target_segment', 1000],
    ['requested_by', 256],
  ]
  for (const [field, maximum] of boundedStrings) {
    if (field in candidate && !isBoundedString(candidate[field], 1, maximum)) {
      issues.push(`${field} must be a non-empty string of at most ${maximum} characters`)
    }
  }
  if ('idempotency_key' in candidate && (typeof candidate.idempotency_key !== 'string' || !IDEMPOTENCY_KEY.test(candidate.idempotency_key))) {
    issues.push('idempotency_key is invalid')
  }

  validateStringArray(candidate.allowed_actions, 'allowed_actions', issues, { pattern: ACTION, unique: true })
  validateStringArray(candidate.prohibited_actions, 'prohibited_actions', issues, { pattern: ACTION, unique: true, minimum: 1 })
  validateStringArray(candidate.approved_channels, 'approved_channels', issues, { allowed: CHANNELS, unique: true })
  validateStringArray(candidate.approved_tools, 'approved_tools', issues, { pattern: TOOL, unique: true })
  for (const field of ['success_criteria', 'stop_conditions', 'required_evidence'] as const) {
    validateStringArray(candidate[field], field, issues, { minimum: 1, itemMaximum: 1000 })
  }

  if ('autonomy_level' in candidate && (typeof candidate.autonomy_level !== 'string' || !AUTONOMY_LEVELS.has(candidate.autonomy_level))) {
    issues.push('autonomy_level is invalid')
  }
  if ('dry_run' in candidate && typeof candidate.dry_run !== 'boolean') issues.push('dry_run must be a boolean')
  if (
    'approval_token' in candidate &&
    candidate.approval_token !== null &&
    (typeof candidate.approval_token !== 'string' || candidate.approval_token.length > 512 || !APPROVAL_TOKEN.test(candidate.approval_token))
  ) {
    issues.push('approval_token is invalid')
  }

  validateBudget(candidate.budget_limit, issues)
  validateVolumeLimits(candidate.volume_limits, issues)
  validateAuthority(candidate.authority, issues)
  validateDataPolicy(candidate.data_policy, issues)
  validateContactPolicy(candidate.contact_policy, issues)
  if ('metadata' in candidate && !isRecord(candidate.metadata)) issues.push('metadata must be an object')

  if (issues.length > 0) throw new ValidationError(issues)
  return structuredClone(candidate) as WorkOrder
}

function validateBudget(value: unknown, issues: string[]): void {
  const budget = validateClosedObject(value, 'budget_limit', ['currency', 'maximum'], ['warning_at_percent'], issues)
  if (!budget) return
  if (typeof budget.currency !== 'string' || !/^[A-Z]{3}$/.test(budget.currency)) issues.push('budget_limit.currency is invalid')
  if (!isFiniteNumber(budget.maximum) || budget.maximum < 0) issues.push('budget_limit.maximum is invalid')
  if ('warning_at_percent' in budget && (!isFiniteNumber(budget.warning_at_percent) || budget.warning_at_percent < 1 || budget.warning_at_percent > 100)) {
    issues.push('budget_limit.warning_at_percent is invalid')
  }
}

function validateVolumeLimits(value: unknown, issues: string[]): void {
  const required = ['maximum_accounts', 'maximum_contacts', 'maximum_external_actions', 'maximum_per_contact', 'period']
  const volume = validateClosedObject(value, 'volume_limits', required, ['channel_limits'], issues)
  if (!volume) return
  for (const field of required.slice(0, 4)) {
    if (!isNonNegativeInteger(volume[field])) issues.push(`volume_limits.${field} is invalid`)
  }
  if (typeof volume.period !== 'string' || !VOLUME_PERIODS.has(volume.period)) issues.push('volume_limits.period is invalid')
  if ('channel_limits' in volume) {
    if (!isRecord(volume.channel_limits) || Object.values(volume.channel_limits).some((entry) => !isNonNegativeInteger(entry))) {
      issues.push('volume_limits.channel_limits is invalid')
    }
  }
}

function validateAuthority(value: unknown, issues: string[]): void {
  const authority = validateClosedObject(value, 'authority', ['issuer', 'audience', 'key_id', 'algorithm', 'signature'], [], issues)
  if (!authority) return
  if (!isBoundedString(authority.issuer, 1, Number.MAX_SAFE_INTEGER)) issues.push('authority.issuer is invalid')
  if (!isBoundedString(authority.audience, 1, 256)) issues.push('authority.audience is invalid')
  if (!isBoundedString(authority.key_id, 1, 256)) issues.push('authority.key_id is invalid')
  if (authority.algorithm !== 'HMAC-SHA256') issues.push('authority.algorithm is invalid')
  if (typeof authority.signature !== 'string' || !/^[0-9a-f]{64}$/.test(authority.signature)) issues.push('authority.signature is invalid')
}

function validateDataPolicy(value: unknown, issues: string[]): void {
  const policy = validateClosedObject(
    value,
    'data_policy',
    ['classification', 'allowed_countries', 'legal_basis', 'retention_days', 'sensitive_data_allowed'],
    ['allowed_data_categories'],
    issues,
  )
  if (!policy) return
  if (typeof policy.classification !== 'string' || !DATA_CLASSIFICATIONS.has(policy.classification)) issues.push('data_policy.classification is invalid')
  if (!isUniqueStringArray(policy.allowed_countries, 1) || policy.allowed_countries.some((country) => !/^[A-Z]{2}$/.test(country))) {
    issues.push('data_policy.allowed_countries is invalid')
  }
  if (!isUniqueStringArray(policy.legal_basis) || policy.legal_basis.some((basis) => !LEGAL_BASES.has(basis))) issues.push('data_policy.legal_basis is invalid')
  if (!isNonNegativeInteger(policy.retention_days) || policy.retention_days > 3650) issues.push('data_policy.retention_days is invalid')
  if (typeof policy.sensitive_data_allowed !== 'boolean') issues.push('data_policy.sensitive_data_allowed is invalid')
  if ('allowed_data_categories' in policy && (!isUniqueStringArray(policy.allowed_data_categories) || policy.allowed_data_categories.some((category) => category.length < 1))) {
    issues.push('data_policy.allowed_data_categories is invalid')
  }
}

function validateContactPolicy(value: unknown, issues: string[]): void {
  const policy = validateClosedObject(
    value,
    'contact_policy',
    ['contact_permitted', 'suppression_check_required', 'consent_check_required', 'maximum_frequency_days', 'quiet_hours_timezone'],
    ['allowed_local_time_start', 'allowed_local_time_end'],
    issues,
  )
  if (!policy) return
  if (typeof policy.contact_permitted !== 'boolean') issues.push('contact_policy.contact_permitted is invalid')
  if (policy.suppression_check_required !== true) issues.push('contact_policy.suppression_check_required must be true')
  if (typeof policy.consent_check_required !== 'boolean') issues.push('contact_policy.consent_check_required is invalid')
  if (!isNonNegativeInteger(policy.maximum_frequency_days) || policy.maximum_frequency_days > 365) issues.push('contact_policy.maximum_frequency_days is invalid')
  if (!isBoundedString(policy.quiet_hours_timezone, 1, Number.MAX_SAFE_INTEGER)) issues.push('contact_policy.quiet_hours_timezone is invalid')
  for (const field of ['allowed_local_time_start', 'allowed_local_time_end'] as const) {
    if (field in policy && (typeof policy[field] !== 'string' || !LOCAL_TIME.test(policy[field]))) issues.push(`contact_policy.${field} is invalid`)
  }
}

function validateClosedObject(
  value: unknown,
  path: string,
  required: string[],
  optional: string[],
  issues: string[],
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`)
    return null
  }
  const allowed = new Set([...required, ...optional])
  for (const field of required) {
    if (!(field in value)) issues.push(`${path}.${field} is required`)
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) issues.push(`${path}.${field} is not allowed`)
  }
  return value
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: string[],
  rules: { minimum?: number; itemMaximum?: number; pattern?: RegExp; allowed?: Set<string>; unique?: boolean },
): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    issues.push(`${path} must be a string array`)
    return
  }
  if (value.length < (rules.minimum ?? 0)) issues.push(`${path} must contain at least one item`)
  if (rules.unique && new Set(value).size !== value.length) issues.push(`${path} must contain unique items`)
  if (rules.pattern && value.some((entry) => !rules.pattern!.test(entry))) issues.push(`${path} contains an invalid item`)
  if (rules.allowed && value.some((entry) => !rules.allowed!.has(entry))) issues.push(`${path} contains an invalid item`)
  if (rules.itemMaximum && value.some((entry) => entry.length < 1 || entry.length > rules.itemMaximum!)) issues.push(`${path} contains an invalid item`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isUniqueStringArray(value: unknown, minimum = 0): value is string[] {
  return Array.isArray(value) && value.length >= minimum && value.every((entry) => typeof entry === 'string') && new Set(value).size === value.length
}
