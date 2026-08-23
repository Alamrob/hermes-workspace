import { ACTIVE_PROFILES, type ProfileId } from './executor-contract.js'

export class AssignmentPlanError extends Error {
  constructor(readonly issues: string[]) {
    super('invalid assignment plan')
    this.name = 'AssignmentPlanError'
  }
}

export interface AssignmentPlanItem {
  assignment_id: string
  idempotency_key: string
  profile_id: ProfileId
  instruction: string
  evidence: string
  depends_on: string[]
  usage_value_reservation_usd: number
  maximum_tokens: number
  maximum_api_calls: number
  max_attempts: number
}

export interface AssignmentPlan {
  mission_id: string
  trace_id: string
  plan_version: string
  assignments: AssignmentPlanItem[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/
const PLAN_VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function validateAssignmentPlan(value: unknown): AssignmentPlan {
  const issues: string[] = []
  if (!record(value)) throw new AssignmentPlanError(['assignment plan must be an object'])
  closed(value, ['mission_id', 'trace_id', 'plan_version', 'assignments'], 'assignment plan', issues)
  if (typeof value.mission_id !== 'string' || !UUID.test(value.mission_id)) issues.push('mission_id must be a UUID')
  if (typeof value.trace_id !== 'string' || !UUID.test(value.trace_id)) issues.push('trace_id must be a UUID')
  if (typeof value.plan_version !== 'string' || !PLAN_VERSION.test(value.plan_version)) issues.push('plan_version is invalid')
  if (!Array.isArray(value.assignments) || value.assignments.length < 1 || value.assignments.length > 6) {
    issues.push('assignments must contain between 1 and 6 items')
  } else {
    const ids = new Set<string>()
    const keys = new Set<string>()
    value.assignments.forEach((entry, index) => {
      const path = `assignments[${index}]`
      if (!record(entry)) {
        issues.push(`${path} must be an object`)
        return
      }
      closed(entry, [
        'assignment_id', 'idempotency_key', 'profile_id', 'instruction', 'evidence',
        'depends_on', 'usage_value_reservation_usd', 'maximum_tokens',
        'maximum_api_calls', 'max_attempts',
      ], path, issues)
      if (typeof entry.assignment_id !== 'string' || !UUID.test(entry.assignment_id)) issues.push(`${path}.assignment_id is invalid`)
      else if (ids.has(entry.assignment_id)) issues.push(`${path}.assignment_id is duplicated`)
      if (typeof entry.idempotency_key !== 'string' || !IDEMPOTENCY_KEY.test(entry.idempotency_key)) issues.push(`${path}.idempotency_key is invalid`)
      else if (keys.has(entry.idempotency_key)) issues.push(`${path}.idempotency_key is duplicated`)
      if (typeof entry.profile_id !== 'string' || !ACTIVE_PROFILES.includes(entry.profile_id as ProfileId)) issues.push(`${path}.profile_id is invalid`)
      if (typeof entry.instruction !== 'string' || entry.instruction.length < 1 || entry.instruction.length > 16_384) issues.push(`${path}.instruction is invalid`)
      if (typeof entry.evidence !== 'string' || entry.evidence.length > 131_072) issues.push(`${path}.evidence is invalid`)
      if (!Array.isArray(entry.depends_on) || entry.depends_on.some((id) => typeof id !== 'string' || !UUID.test(id))) issues.push(`${path}.depends_on is invalid`)
      else {
        if (new Set(entry.depends_on).size !== entry.depends_on.length) issues.push(`${path}.depends_on is duplicated`)
        for (const dependency of entry.depends_on) if (!ids.has(dependency)) issues.push(`${path}.depends_on must reference an earlier assignment`)
      }
      if (typeof entry.usage_value_reservation_usd !== 'number' || !Number.isFinite(entry.usage_value_reservation_usd) || entry.usage_value_reservation_usd < 0.01 || entry.usage_value_reservation_usd > 0.1) issues.push(`${path}.usage_value_reservation_usd is invalid`)
      if (typeof entry.maximum_tokens !== 'number' || !Number.isSafeInteger(entry.maximum_tokens) || entry.maximum_tokens < 6_144 || entry.maximum_tokens > 1_000_000) issues.push(`${path}.maximum_tokens is invalid`)
      if (typeof entry.maximum_api_calls !== 'number' || !Number.isSafeInteger(entry.maximum_api_calls) || entry.maximum_api_calls < 3 || entry.maximum_api_calls > 100) issues.push(`${path}.maximum_api_calls is invalid`)
      if (typeof entry.max_attempts !== 'number' || !Number.isSafeInteger(entry.max_attempts) || entry.max_attempts < 1 || entry.max_attempts > 2) issues.push(`${path}.max_attempts is invalid`)
      if (typeof entry.assignment_id === 'string') ids.add(entry.assignment_id)
      if (typeof entry.idempotency_key === 'string') keys.add(entry.idempotency_key)
    })
    const last = value.assignments.at(-1)
    if (value.assignments.length > 1 && record(last) && last.profile_id !== 'commercial-qa-compliance') issues.push('the final assignment must be commercial-qa-compliance')
  }
  if (issues.length) throw new AssignmentPlanError(issues)
  return structuredClone(value) as unknown as AssignmentPlan
}

function closed(value: Record<string, unknown>, fields: string[], path: string, issues: string[]): void {
  const expected = new Set(fields)
  for (const field of fields) if (!(field in value)) issues.push(`${path}.${field} is required`)
  for (const field of Object.keys(value)) if (!expected.has(field)) issues.push(`${path}.${field} is not allowed`)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
