import type { AssignmentPlan } from './assignment-plan.js'
import { validateAssignmentPlan } from './assignment-plan.js'
import {
  hashA1AssignmentPlan,
  hashA1Mission,
  type A1DispatchAuthorizationState,
} from './a1-dispatch-authorization.js'
import type { MissionRecord } from './repository.js'

export interface A1AssignmentEnqueueAttestations {
  exactEnqueueConfirmed: true
  authorizationRecordOnly: true
  noAssignmentsEnqueuedByAuthorization: true
  noExecution: true
  noContact: true
  noCrmWrite: true
  noExternalActions: true
  noProviderCreditSpend: true
  globalKillSwitchRequired: true
}

export interface RecordA1AssignmentEnqueueAuthorizationInput {
  authorizationId: string
  missionId: string
  traceId: string
  planVersion: string
  dispatchAuthorizationId: string
  decision: 'approved' | 'rejected'
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  expiresAt: string
  missionSha256: string
  assignmentPlanSha256: string
  userAuthorizationSha256: string
  attestations: A1AssignmentEnqueueAttestations
  idempotencyKey: string
  requestSha256: string
}

export interface A1AssignmentEnqueueAuthorizationState
  extends Omit<RecordA1AssignmentEnqueueAuthorizationInput, 'requestSha256'> {
  enqueueAuthorizationRecorded: true
  assignmentEnqueuePermitted: boolean
  assignmentsEnqueued: false
  executionAuthorized: false
  dispatchClaimingPermitted: false
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

export interface A1AssignmentEnqueueAuthorizationRequest {
  decision: 'approved' | 'rejected'
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  expiresAt: string
  expectedMissionSha256: string
  expectedAssignmentPlanSha256: string
  expectedDispatchAuthorizationId: string
  userAuthorizationSha256: string
  attestations: A1AssignmentEnqueueAttestations
  idempotencyKey: string
  assignmentPlan: AssignmentPlan
}

export class A1AssignmentEnqueueAuthorizationError extends Error {
  constructor(readonly code: string) { super(code) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const ACTOR = /^[A-Za-z0-9._:@+-]{3,254}$/
const IDEMPOTENCY = /^a1-enqueue-auth:[A-Za-z0-9._:-]{8,105}$/
const FORBIDDEN_TEXT = /(https?:\/\/|www\.|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{20,})/i

export function validateA1AssignmentEnqueueAuthorizationRequest(
  value: unknown,
  now: Date,
): A1AssignmentEnqueueAuthorizationRequest {
  try {
    const input = object(value)
    exactKeys(input, [
      'decision','rationale','reviewer_id','reviewer_email','reviewed_at','expires_at',
      'expected_mission_sha256','expected_assignment_plan_sha256',
      'expected_dispatch_authorization_id','user_authorization_sha256',
      'attestations','idempotency_key','assignment_plan',
    ])
    const decision = text(input.decision)
    const rationale = text(input.rationale).trim()
    const reviewedAt = text(input.reviewed_at)
    const expiresAt = text(input.expires_at)
    const reviewedMs = Date.parse(reviewedAt)
    const expiresMs = Date.parse(expiresAt)
    if (
      !['approved','rejected'].includes(decision) || rationale.length < 20 || rationale.length > 1_000 ||
      /[\u0000-\u001f\u007f]/.test(rationale) || FORBIDDEN_TEXT.test(rationale) ||
      !ACTOR.test(text(input.reviewer_id)) || input.reviewer_email !== 'proptimizaspa@gmail.com' ||
      !Number.isFinite(reviewedMs) || !Number.isFinite(expiresMs) ||
      Math.abs(reviewedMs - now.getTime()) > 5 * 60_000 || expiresMs <= reviewedMs ||
      expiresMs > reviewedMs + 30 * 60_000 ||
      !SHA256.test(text(input.expected_mission_sha256)) ||
      !SHA256.test(text(input.expected_assignment_plan_sha256)) ||
      !UUID.test(text(input.expected_dispatch_authorization_id)) ||
      !SHA256.test(text(input.user_authorization_sha256)) ||
      !IDEMPOTENCY.test(text(input.idempotency_key))
    ) throw new Error('fields')
    return {
      decision: decision as 'approved' | 'rejected', rationale,
      reviewerId: text(input.reviewer_id), reviewerEmail: 'proptimizaspa@gmail.com',
      reviewedAt: new Date(reviewedMs).toISOString(), expiresAt: new Date(expiresMs).toISOString(),
      expectedMissionSha256: text(input.expected_mission_sha256),
      expectedAssignmentPlanSha256: text(input.expected_assignment_plan_sha256),
      expectedDispatchAuthorizationId: text(input.expected_dispatch_authorization_id),
      userAuthorizationSha256: text(input.user_authorization_sha256),
      attestations: validateRequestAttestations(input.attestations),
      idempotencyKey: text(input.idempotency_key),
      assignmentPlan: validateAssignmentPlan(input.assignment_plan),
    }
  } catch {
    throw new A1AssignmentEnqueueAuthorizationError('A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_INVALID')
  }
}

export function validateA1AssignmentEnqueueAuthorizationState(
  value: unknown,
): A1AssignmentEnqueueAuthorizationState {
  try {
    const state = object(value)
    exactKeys(state, [
      'authorizationId','missionId','traceId','planVersion','dispatchAuthorizationId',
      'decision','rationale','reviewerId','reviewerEmail','reviewedAt','expiresAt',
      'missionSha256','assignmentPlanSha256','userAuthorizationSha256','attestations',
      'idempotencyKey','enqueueAuthorizationRecorded','assignmentEnqueuePermitted',
      'assignmentsEnqueued','executionAuthorized','dispatchClaimingPermitted',
      'internetAccessAllowed','providerCreditSpendAllowed','contactPermitted','crmWriteAllowed',
      'maximumExternalActions','globalKillSwitchRequired','productionGate','nextRequiredGate','provenance',
    ])
    if (
      !UUID.test(text(state.authorizationId)) || !UUID.test(text(state.missionId)) ||
      !UUID.test(text(state.traceId)) || !UUID.test(text(state.dispatchAuthorizationId)) ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(text(state.planVersion)) ||
      !['approved','rejected'].includes(text(state.decision)) ||
      text(state.rationale).length < 20 || !ACTOR.test(text(state.reviewerId)) ||
      state.reviewerEmail !== 'proptimizaspa@gmail.com' || !validDate(state.reviewedAt) ||
      !validDate(state.expiresAt) || !SHA256.test(text(state.missionSha256)) ||
      !SHA256.test(text(state.assignmentPlanSha256)) || !SHA256.test(text(state.userAuthorizationSha256)) ||
      !IDEMPOTENCY.test(text(state.idempotencyKey)) || state.enqueueAuthorizationRecorded !== true ||
      state.assignmentEnqueuePermitted !== (state.decision === 'approved') ||
      state.assignmentsEnqueued !== false || state.executionAuthorized !== false ||
      state.dispatchClaimingPermitted !== false || state.internetAccessAllowed !== false ||
      state.providerCreditSpendAllowed !== false || state.contactPermitted !== false ||
      state.crmWriteAllowed !== false || state.maximumExternalActions !== 0 ||
      state.globalKillSwitchRequired !== true || state.productionGate !== 'blocked' ||
      state.nextRequiredGate !== 'enqueue_exact_assignment_plan_separately'
    ) throw new Error('state')
    validateStateAttestations(state.attestations)
    const provenance = object(state.provenance)
    exactKeys(provenance, ['source','sourceId','observedAt','synthetic'])
    if (provenance.source !== 'control-broker' || provenance.sourceId !== `a1-assignment-enqueue-authorization:${state.authorizationId}` || !validDate(provenance.observedAt) || provenance.synthetic !== false) throw new Error('provenance')
    return value as A1AssignmentEnqueueAuthorizationState
  } catch {
    throw new A1AssignmentEnqueueAuthorizationError('A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_STATE_INVALID')
  }
}

export function assertA1AssignmentEnqueueAuthorizationAdmission(
  mission: MissionRecord,
  plan: AssignmentPlan,
  dispatchAuthorization: A1DispatchAuthorizationState | null,
  enqueueAuthorization: A1AssignmentEnqueueAuthorizationState | null,
  now: Date,
): void {
  if (!dispatchAuthorization || !enqueueAuthorization)
    throw new A1AssignmentEnqueueAuthorizationError('A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_GATE_CLOSED')
  const state = validateA1AssignmentEnqueueAuthorizationState(enqueueAuthorization)
  if (
    state.decision !== 'approved' || Date.parse(state.expiresAt) <= now.getTime() ||
    Date.parse(dispatchAuthorization.expiresAt) <= now.getTime() ||
    state.dispatchAuthorizationId !== dispatchAuthorization.authorizationId ||
    state.missionId !== mission.mission_id || state.traceId !== plan.trace_id ||
    state.planVersion !== plan.plan_version || state.missionSha256 !== hashA1Mission(mission) ||
    state.assignmentPlanSha256 !== hashA1AssignmentPlan(plan) ||
    state.assignmentPlanSha256 !== dispatchAuthorization.assignmentPlanSha256
  ) throw new A1AssignmentEnqueueAuthorizationError('A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_GATE_CLOSED')
}

function validateRequestAttestations(value: unknown): A1AssignmentEnqueueAttestations {
  const input = object(value)
  exactKeys(input, ['exact_enqueue_confirmed','authorization_record_only','no_assignments_enqueued_by_authorization','no_execution','no_contact','no_crm_write','no_external_actions','no_provider_credit_spend','global_kill_switch_required'])
  if (Object.values(input).some(entry => entry !== true)) throw new Error('attestations')
  return { exactEnqueueConfirmed:true, authorizationRecordOnly:true, noAssignmentsEnqueuedByAuthorization:true, noExecution:true, noContact:true, noCrmWrite:true, noExternalActions:true, noProviderCreditSpend:true, globalKillSwitchRequired:true }
}
function validateStateAttestations(value: unknown): A1AssignmentEnqueueAttestations {
  const input = object(value)
  exactKeys(input, ['exactEnqueueConfirmed','authorizationRecordOnly','noAssignmentsEnqueuedByAuthorization','noExecution','noContact','noCrmWrite','noExternalActions','noProviderCreditSpend','globalKillSwitchRequired'])
  if (Object.values(input).some(entry => entry !== true)) throw new Error('attestations')
  return input as unknown as A1AssignmentEnqueueAttestations
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object'); return value as Record<string, unknown> }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function validDate(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { const actual=Object.keys(value).sort(), wanted=[...expected].sort(); if(actual.length!==wanted.length||actual.some((key,index)=>key!==wanted[index])) throw new Error('keys') }
