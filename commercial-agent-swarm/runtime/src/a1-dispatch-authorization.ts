import { hashAction } from './canonical.js'
import {
  validateAssignmentPlan,
  type AssignmentPlan,
} from './assignment-plan.js'
import type { MissionRecord } from './repository.js'

export interface A1DispatchAuthorizationAttestations {
  exactAssignmentPlanConfirmed: true
  authorizationRecordOnly: true
  noAssignmentsCreated: true
  noDispatchQueued: true
  noExecution: true
  noContact: true
  noCrmWrite: true
  noExternalActions: true
  noProviderCreditSpend: true
  globalKillSwitchRequired: true
}

export interface RecordA1DispatchAuthorizationInput {
  authorizationId: string
  missionId: string
  traceId: string
  planVersion: string
  decision: 'approved' | 'rejected'
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  expiresAt: string
  missionSha256: string
  assignmentPlanSha256: string
  userAuthorizationSha256: string
  attestations: A1DispatchAuthorizationAttestations
  idempotencyKey: string
  requestSha256: string
}

export interface A1DispatchAuthorizationState
  extends Omit<RecordA1DispatchAuthorizationInput, 'requestSha256'> {
  assignmentCreated: false
  dispatchQueued: false
  executionAuthorized: false
  internetAccessAllowed: false
  providerCreditSpendAllowed: false
  contactPermitted: false
  crmWriteAllowed: false
  maximumExternalActions: 0
  globalKillSwitchRequired: true
  productionGate: 'blocked'
  nextRequiredGate: 'enqueue_exact_assignment_plan_separately'
  provenance: {
    source: 'control-broker'
    sourceId: string
    observedAt: string
    synthetic: false
  }
}

export interface A1DispatchAuthorizationRequest {
  decision: 'approved' | 'rejected'
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  expiresAt: string
  expectedMissionSha256: string
  userAuthorizationSha256: string
  attestations: A1DispatchAuthorizationAttestations
  idempotencyKey: string
  assignmentPlan: AssignmentPlan
}

export class A1DispatchAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const ACTOR = /^[A-Za-z0-9._:@+-]{3,254}$/
const IDEMPOTENCY = /^a1-dispatch-auth:[A-Za-z0-9._:-]{8,104}$/
const FORBIDDEN_TEXT = /(https?:\/\/|www\.|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{20,})/i

export function hashA1Mission(mission: MissionRecord): string {
  return hashAction(mission)
}

export function hashA1AssignmentPlan(plan: AssignmentPlan): string {
  return hashAction(plan)
}

export function validateA1DispatchAuthorizationRequest(
  value: unknown,
  now: Date,
): A1DispatchAuthorizationRequest {
  try {
    const input = object(value)
    exactKeys(input, [
      'decision', 'rationale', 'reviewer_id', 'reviewer_email', 'reviewed_at',
      'expires_at', 'expected_mission_sha256', 'user_authorization_sha256',
      'attestations', 'idempotency_key', 'assignment_plan',
    ])
    const decision = text(input.decision)
    const rationale = text(input.rationale).trim()
    const reviewerId = text(input.reviewer_id)
    const reviewerEmail = text(input.reviewer_email)
    const reviewedAt = text(input.reviewed_at)
    const expiresAt = text(input.expires_at)
    const expectedMissionSha256 = text(input.expected_mission_sha256)
    const userAuthorizationSha256 = text(input.user_authorization_sha256)
    const idempotencyKey = text(input.idempotency_key)
    if (
      !['approved', 'rejected'].includes(decision) ||
      rationale.length < 20 || rationale.length > 1_000 ||
      /[\u0000-\u001f\u007f]/.test(rationale) || FORBIDDEN_TEXT.test(rationale) ||
      !ACTOR.test(reviewerId) || reviewerEmail !== 'proptimizaspa@gmail.com' ||
      !validDate(reviewedAt) || !validDate(expiresAt) ||
      !SHA256.test(expectedMissionSha256) || !SHA256.test(userAuthorizationSha256) ||
      !IDEMPOTENCY.test(idempotencyKey)
    ) throw new Error('fields')
    const reviewedMs = Date.parse(reviewedAt)
    const expiresMs = Date.parse(expiresAt)
    const nowMs = now.getTime()
    if (
      Math.abs(reviewedMs - nowMs) > 5 * 60_000 ||
      expiresMs <= reviewedMs || expiresMs > reviewedMs + 30 * 60_000
    ) throw new Error('time')
    return {
      decision: decision as 'approved' | 'rejected',
      rationale,
      reviewerId,
      reviewerEmail: 'proptimizaspa@gmail.com',
      reviewedAt: new Date(reviewedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      expectedMissionSha256,
      userAuthorizationSha256,
      attestations: validateRequestAttestations(input.attestations),
      idempotencyKey,
      assignmentPlan: validateAssignmentPlan(input.assignment_plan),
    }
  } catch {
    throw new A1DispatchAuthorizationError('A1_DISPATCH_AUTHORIZATION_INVALID')
  }
}

export function validateA1DispatchAuthorizationState(
  value: unknown,
): A1DispatchAuthorizationState {
  try {
    const state = object(value)
    exactKeys(state, [
      'authorizationId', 'missionId', 'traceId', 'planVersion', 'decision',
      'rationale', 'reviewerId', 'reviewerEmail', 'reviewedAt', 'expiresAt',
      'missionSha256', 'assignmentPlanSha256', 'userAuthorizationSha256',
      'attestations', 'idempotencyKey', 'assignmentCreated', 'dispatchQueued',
      'executionAuthorized', 'internetAccessAllowed', 'providerCreditSpendAllowed',
      'contactPermitted', 'crmWriteAllowed', 'maximumExternalActions',
      'globalKillSwitchRequired', 'productionGate', 'nextRequiredGate', 'provenance',
    ])
    if (
      !UUID.test(text(state.authorizationId)) || !UUID.test(text(state.missionId)) ||
      !UUID.test(text(state.traceId)) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(text(state.planVersion)) ||
      !['approved', 'rejected'].includes(text(state.decision)) ||
      text(state.rationale).length < 20 || !ACTOR.test(text(state.reviewerId)) ||
      state.reviewerEmail !== 'proptimizaspa@gmail.com' ||
      !validDate(state.reviewedAt) || !validDate(state.expiresAt) ||
      !SHA256.test(text(state.missionSha256)) || !SHA256.test(text(state.assignmentPlanSha256)) ||
      !SHA256.test(text(state.userAuthorizationSha256)) || !IDEMPOTENCY.test(text(state.idempotencyKey)) ||
      state.assignmentCreated !== false || state.dispatchQueued !== false ||
      state.executionAuthorized !== false || state.internetAccessAllowed !== false ||
      state.providerCreditSpendAllowed !== false || state.contactPermitted !== false ||
      state.crmWriteAllowed !== false || state.maximumExternalActions !== 0 ||
      state.globalKillSwitchRequired !== true || state.productionGate !== 'blocked' ||
      state.nextRequiredGate !== 'enqueue_exact_assignment_plan_separately'
    ) throw new Error('state')
    validateStateAttestations(state.attestations)
    const provenance = object(state.provenance)
    exactKeys(provenance, ['source', 'sourceId', 'observedAt', 'synthetic'])
    if (
      provenance.source !== 'control-broker' ||
      provenance.sourceId !== `a1-dispatch-authorization:${state.authorizationId}` ||
      !validDate(provenance.observedAt) || provenance.synthetic !== false
    ) throw new Error('provenance')
    return value as A1DispatchAuthorizationState
  } catch (error) {
    if (error instanceof A1DispatchAuthorizationError) throw error
    throw new A1DispatchAuthorizationError('A1_DISPATCH_AUTHORIZATION_STATE_INVALID')
  }
}

export function assertA1DispatchAuthorizationAdmission(
  mission: MissionRecord,
  plan: AssignmentPlan,
  authorizationValue: A1DispatchAuthorizationState | null,
  now: Date,
): void {
  if (authorizationValue === null)
    throw new A1DispatchAuthorizationError('A1_DISPATCH_AUTHORIZATION_GATE_CLOSED')
  const authorization = validateA1DispatchAuthorizationState(authorizationValue)
  if (
    authorization.decision !== 'approved' || Date.parse(authorization.expiresAt) <= now.getTime() ||
    authorization.missionId !== mission.mission_id || authorization.traceId !== plan.trace_id ||
    authorization.planVersion !== plan.plan_version ||
    authorization.missionSha256 !== hashA1Mission(mission) ||
    authorization.assignmentPlanSha256 !== hashA1AssignmentPlan(plan)
  ) throw new A1DispatchAuthorizationError('A1_DISPATCH_AUTHORIZATION_GATE_CLOSED')
}

function validateRequestAttestations(value: unknown): A1DispatchAuthorizationAttestations {
  const input = object(value)
  exactKeys(input, [
    'exact_assignment_plan_confirmed', 'authorization_record_only',
    'no_assignments_created', 'no_dispatch_queued', 'no_execution', 'no_contact',
    'no_crm_write', 'no_external_actions', 'no_provider_credit_spend',
    'global_kill_switch_required',
  ])
  if (Object.values(input).some((entry) => entry !== true)) throw new Error('attestations')
  return {
    exactAssignmentPlanConfirmed: true, authorizationRecordOnly: true,
    noAssignmentsCreated: true, noDispatchQueued: true, noExecution: true,
    noContact: true, noCrmWrite: true, noExternalActions: true,
    noProviderCreditSpend: true, globalKillSwitchRequired: true,
  }
}

function validateStateAttestations(value: unknown): A1DispatchAuthorizationAttestations {
  const input = object(value)
  exactKeys(input, [
    'exactAssignmentPlanConfirmed', 'authorizationRecordOnly', 'noAssignmentsCreated',
    'noDispatchQueued', 'noExecution', 'noContact', 'noCrmWrite',
    'noExternalActions', 'noProviderCreditSpend', 'globalKillSwitchRequired',
  ])
  if (Object.values(input).some((entry) => entry !== true)) throw new Error('attestations')
  return input as unknown as A1DispatchAuthorizationAttestations
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
  return value as Record<string, unknown>
}
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function validDate(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error('keys')
}
