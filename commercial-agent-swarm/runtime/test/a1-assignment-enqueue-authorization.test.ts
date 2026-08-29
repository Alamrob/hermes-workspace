import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  assertA1AssignmentEnqueueAuthorizationAdmission,
  validateA1AssignmentEnqueueAuthorizationRequest,
  validateA1AssignmentEnqueueAuthorizationState,
} from '../src/a1-assignment-enqueue-authorization.js'
import { hashA1AssignmentPlan, hashA1Mission, type A1DispatchAuthorizationState } from '../src/a1-dispatch-authorization.js'
import type { AssignmentPlan } from '../src/assignment-plan.js'
import type { MissionRecord } from '../src/repository.js'

const NOW = new Date('2026-08-29T19:00:00.000Z')
const MISSION_ID = 'a4500000-0000-4500-8500-000000000053'
const TRACE_ID = 'a4500000-0000-4500-8500-000000000054'
const DISPATCH_AUTH_ID = 'a4500000-0000-4500-8500-000000000055'
const ENQUEUE_AUTH_ID = 'a4500000-0000-4500-8500-000000000056'

function mission(): MissionRecord { return { mission_id:MISSION_ID, trace_id:TRACE_ID, autonomy_level:'A1', a3_enabled:false, dry_run:true, project_id:'proptimiza', offer_id:'operacion-sin-planillas' } }
function plan(): AssignmentPlan { return { mission_id:MISSION_ID, trace_id:TRACE_ID, plan_version:'a1-plan-v1', assignments:[{ assignment_id:'a4500000-0000-4500-8500-000000000057', idempotency_key:'a1-assignment:00000053', profile_id:'sales-orchestrator', instruction:'Clasificar únicamente la misión interna aprobada.', evidence:'Expediente interno exacto.', depends_on:[], usage_value_reservation_usd:0.01, maximum_tokens:6144, maximum_api_calls:3, max_attempts:1 }] } }
function request() { return { decision:'approved', rationale:'Autoriza solamente el enqueue posterior del plan exacto, sin ejecutar.', reviewer_id:'director', reviewer_email:'proptimizaspa@gmail.com', reviewed_at:NOW.toISOString(), expires_at:'2026-08-29T19:15:00.000Z', expected_mission_sha256:hashA1Mission(mission()), expected_assignment_plan_sha256:hashA1AssignmentPlan(plan()), expected_dispatch_authorization_id:DISPATCH_AUTH_ID, user_authorization_sha256:'e'.repeat(64), attestations:{ exact_enqueue_confirmed:true, authorization_record_only:true, no_assignments_enqueued_by_authorization:true, no_execution:true, no_contact:true, no_crm_write:true, no_external_actions:true, no_provider_credit_spend:true, global_kill_switch_required:true }, idempotency_key:'a1-enqueue-auth:mission-00000053', assignment_plan:plan() } }
function dispatchAuthorization(): A1DispatchAuthorizationState { return { authorizationId:DISPATCH_AUTH_ID, missionId:MISSION_ID, traceId:TRACE_ID, planVersion:'a1-plan-v1', decision:'approved', rationale:'Autoriza registrar solamente el plan exacto sin crear ni ejecutar asignaciones.', reviewerId:'director', reviewerEmail:'proptimizaspa@gmail.com', reviewedAt:NOW.toISOString(), expiresAt:'2026-08-29T19:20:00.000Z', missionSha256:hashA1Mission(mission()), assignmentPlanSha256:hashA1AssignmentPlan(plan()), userAuthorizationSha256:'d'.repeat(64), attestations:{ exactAssignmentPlanConfirmed:true, authorizationRecordOnly:true, noAssignmentsCreated:true, noDispatchQueued:true, noExecution:true, noContact:true, noCrmWrite:true, noExternalActions:true, noProviderCreditSpend:true, globalKillSwitchRequired:true }, idempotencyKey:'a1-dispatch-auth:mission-00000053', assignmentCreated:false, dispatchQueued:false, executionAuthorized:false, internetAccessAllowed:false, providerCreditSpendAllowed:false, contactPermitted:false, crmWriteAllowed:false, maximumExternalActions:0, globalKillSwitchRequired:true, productionGate:'blocked', nextRequiredGate:'enqueue_exact_assignment_plan_separately', provenance:{ source:'control-broker', sourceId:`a1-dispatch-authorization:${DISPATCH_AUTH_ID}`, observedAt:NOW.toISOString(), synthetic:false } } }
function state() { return { authorizationId:ENQUEUE_AUTH_ID, missionId:MISSION_ID, traceId:TRACE_ID, planVersion:'a1-plan-v1', dispatchAuthorizationId:DISPATCH_AUTH_ID, decision:'approved', rationale:'Autoriza solamente el enqueue posterior del plan exacto, sin ejecutar.', reviewerId:'director', reviewerEmail:'proptimizaspa@gmail.com', reviewedAt:NOW.toISOString(), expiresAt:'2026-08-29T19:15:00.000Z', missionSha256:hashA1Mission(mission()), assignmentPlanSha256:hashA1AssignmentPlan(plan()), userAuthorizationSha256:'e'.repeat(64), attestations:{ exactEnqueueConfirmed:true, authorizationRecordOnly:true, noAssignmentsEnqueuedByAuthorization:true, noExecution:true, noContact:true, noCrmWrite:true, noExternalActions:true, noProviderCreditSpend:true, globalKillSwitchRequired:true }, idempotencyKey:'a1-enqueue-auth:mission-00000053', enqueueAuthorizationRecorded:true, assignmentEnqueuePermitted:true, assignmentsEnqueued:false, executionAuthorized:false, dispatchClaimingPermitted:false, internetAccessAllowed:false, providerCreditSpendAllowed:false, contactPermitted:false, crmWriteAllowed:false, maximumExternalActions:0, globalKillSwitchRequired:true, productionGate:'blocked', nextRequiredGate:'enqueue_exact_assignment_plan_separately', provenance:{ source:'control-broker', sourceId:`a1-assignment-enqueue-authorization:${ENQUEUE_AUTH_ID}`, observedAt:NOW.toISOString(), synthetic:false } } as const }

describe('A1 exact assignment enqueue authorization', () => {
  it('validates one short-lived record-only request', () => {
    const value = validateA1AssignmentEnqueueAuthorizationRequest(request(), NOW)
    assert.equal(value.expectedDispatchAuthorizationId, DISPATCH_AUTH_ID)
    assert.equal(value.attestations.noAssignmentsEnqueuedByAuthorization, true)
  })
  it('rejects recovery identity, false safeguards, stale time and changed plan hash', () => {
    assert.throws(() => validateA1AssignmentEnqueueAuthorizationRequest({ ...request(), reviewer_email:'lamrobcompany@gmail.com' }, NOW), /A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_INVALID/)
    assert.throws(() => validateA1AssignmentEnqueueAuthorizationRequest({ ...request(), attestations:{ ...request().attestations, no_execution:false } }, NOW), /A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_INVALID/)
    assert.throws(() => validateA1AssignmentEnqueueAuthorizationRequest({ ...request(), reviewed_at:'2026-08-29T18:54:59.000Z' }, NOW), /A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_INVALID/)
  })
  it('binds admission to both exact authorizations, mission and plan', () => {
    assert.equal(validateA1AssignmentEnqueueAuthorizationState(state()).assignmentsEnqueued, false)
    assert.doesNotThrow(() => assertA1AssignmentEnqueueAuthorizationAdmission(mission(), plan(), dispatchAuthorization(), state(), NOW))
    const changed = plan(); changed.assignments[0].instruction='Changed instruction'
    assert.throws(() => assertA1AssignmentEnqueueAuthorizationAdmission(mission(), changed, dispatchAuthorization(), state(), NOW), /A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_GATE_CLOSED/)
    assert.throws(() => assertA1AssignmentEnqueueAuthorizationAdmission(mission(), plan(), dispatchAuthorization(), state(), new Date('2026-08-29T19:15:00.000Z')), /A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_GATE_CLOSED/)
  })
  it('ships a record-only migration that cannot enqueue or claim', async () => {
    const sql=await readFile(new URL('../migrations/031_a1_assignment_enqueue_authorization.sql',import.meta.url),'utf8')
    assert.match(sql,/CREATE TABLE control\.a1_assignment_enqueue_authorizations/)
    assert.match(sql,/NOT control\.is_global_kill_switch_active\(\)/)
    assert.match(sql,/'assignmentsEnqueued',false/)
    assert.match(sql,/'dispatchClaimingPermitted',false/)
    assert.doesNotMatch(sql,/control\.enqueue_dispatch|control\.claim_dispatch|mail\.send|integration\.enqueue_crm_change/i)
    const rollback=await readFile(new URL('../migrations/031_a1_assignment_enqueue_authorization.rollback.sql',import.meta.url),'utf8')
    assert.match(rollback,/A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_HISTORY_PRESENT/)
  })
  it('requires the second gate before the existing endpoint can enqueue', async () => {
    const source=await readFile(new URL('../src/application.ts',import.meta.url),'utf8')
    assert.match(source,/await this\.requireA1AssignmentEnqueueAdmission\(mission, plan, admissionTime\)/)
    assert.match(source,/assertA1AssignmentEnqueueAuthorizationAdmission/)
  })
})
