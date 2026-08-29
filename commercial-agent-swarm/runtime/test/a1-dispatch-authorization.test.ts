import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  assertA1DispatchAuthorizationAdmission,
  hashA1AssignmentPlan,
  hashA1Mission,
  validateA1DispatchAuthorizationRequest,
  validateA1DispatchAuthorizationState,
} from '../src/a1-dispatch-authorization.js'
import type { AssignmentPlan } from '../src/assignment-plan.js'
import type { MissionRecord } from '../src/repository.js'

const NOW = new Date('2026-08-29T18:00:00.000Z')
const MISSION_ID = 'a3500000-0000-4500-8500-000000000053'
const TRACE_ID = 'a3500000-0000-4500-8500-000000000054'
const AUTHORIZATION_ID = 'a3500000-0000-4500-8500-000000000055'

function mission(): MissionRecord {
  return {
    mission_id: MISSION_ID,
    trace_id: TRACE_ID,
    autonomy_level: 'A1',
    a3_enabled: false,
    dry_run: true,
    project_id: 'proptimiza',
    offer_id: 'operacion-sin-planillas',
  }
}

function plan(): AssignmentPlan {
  return {
    mission_id: MISSION_ID,
    trace_id: TRACE_ID,
    plan_version: 'a1-plan-v1',
    assignments: [{
      assignment_id: 'a3500000-0000-4500-8500-000000000056',
      idempotency_key: 'a1-assignment:00000053',
      profile_id: 'sales-orchestrator',
      instruction: 'Clasificar únicamente la misión interna aprobada.',
      evidence: 'Expediente A1 cerrado y sin fuentes externas.',
      depends_on: [],
      usage_value_reservation_usd: 0.01,
      maximum_tokens: 6_144,
      maximum_api_calls: 3,
      max_attempts: 1,
    }],
  }
}

function attestations() {
  return {
    exact_assignment_plan_confirmed: true,
    authorization_record_only: true,
    no_assignments_created: true,
    no_dispatch_queued: true,
    no_execution: true,
    no_contact: true,
    no_crm_write: true,
    no_external_actions: true,
    no_provider_credit_spend: true,
    global_kill_switch_required: true,
  }
}

function request() {
  return {
    decision: 'approved',
    rationale: 'Autoriza registrar solamente el plan exacto sin crear ni ejecutar asignaciones.',
    reviewer_id: 'director',
    reviewer_email: 'proptimizaspa@gmail.com',
    reviewed_at: NOW.toISOString(),
    expires_at: '2026-08-29T18:20:00.000Z',
    expected_mission_sha256: hashA1Mission(mission()),
    user_authorization_sha256: 'd'.repeat(64),
    attestations: attestations(),
    idempotency_key: 'a1-dispatch-auth:mission-00000053',
    assignment_plan: plan(),
  }
}

function state() {
  return {
    authorizationId: AUTHORIZATION_ID,
    missionId: MISSION_ID,
    traceId: TRACE_ID,
    planVersion: 'a1-plan-v1',
    decision: 'approved',
    rationale: 'Autoriza registrar solamente el plan exacto sin crear ni ejecutar asignaciones.',
    reviewerId: 'director',
    reviewerEmail: 'proptimizaspa@gmail.com',
    reviewedAt: NOW.toISOString(),
    expiresAt: '2026-08-29T18:20:00.000Z',
    missionSha256: hashA1Mission(mission()),
    assignmentPlanSha256: hashA1AssignmentPlan(plan()),
    userAuthorizationSha256: 'd'.repeat(64),
    attestations: {
      exactAssignmentPlanConfirmed: true, authorizationRecordOnly: true,
      noAssignmentsCreated: true, noDispatchQueued: true, noExecution: true,
      noContact: true, noCrmWrite: true, noExternalActions: true,
      noProviderCreditSpend: true, globalKillSwitchRequired: true,
    },
    idempotencyKey: 'a1-dispatch-auth:mission-00000053',
    assignmentCreated: false,
    dispatchQueued: false,
    executionAuthorized: false,
    internetAccessAllowed: false,
    providerCreditSpendAllowed: false,
    contactPermitted: false,
    crmWriteAllowed: false,
    maximumExternalActions: 0,
    globalKillSwitchRequired: true,
    productionGate: 'blocked',
    nextRequiredGate: 'enqueue_exact_assignment_plan_separately',
    provenance: {
      source: 'control-broker',
      sourceId: `a1-dispatch-authorization:${AUTHORIZATION_ID}`,
      observedAt: NOW.toISOString(),
      synthetic: false,
    },
  } as const
}

describe('A1 exact assignment-plan authorization', () => {
  it('validates one short-lived record-only authorization request', () => {
    const value = validateA1DispatchAuthorizationRequest(request(), NOW)
    assert.equal(value.assignmentPlan.plan_version, 'a1-plan-v1')
    assert.equal(value.attestations.authorizationRecordOnly, true)
  })

  it('rejects recovery identity, false safeguards, stale time and secret-bearing rationale', () => {
    assert.throws(() => validateA1DispatchAuthorizationRequest({
      ...request(), reviewer_email: 'lamrobcompany@gmail.com',
    }, NOW), /A1_DISPATCH_AUTHORIZATION_INVALID/)
    assert.throws(() => validateA1DispatchAuthorizationRequest({
      ...request(), attestations: { ...attestations(), no_dispatch_queued: false },
    }, NOW), /A1_DISPATCH_AUTHORIZATION_INVALID/)
    assert.throws(() => validateA1DispatchAuthorizationRequest({
      ...request(), reviewed_at: '2026-08-29T17:54:59.000Z',
    }, NOW), /A1_DISPATCH_AUTHORIZATION_INVALID/)
    assert.throws(() => validateA1DispatchAuthorizationRequest({
      ...request(), rationale: `Bearer ${'a'.repeat(32)}`,
    }, NOW), /A1_DISPATCH_AUTHORIZATION_INVALID/)
  })

  it('binds admission to the exact mission and exact plan while still authorizing no execution', () => {
    assert.equal(validateA1DispatchAuthorizationState(state()).dispatchQueued, false)
    assert.doesNotThrow(() => assertA1DispatchAuthorizationAdmission(mission(), plan(), state(), NOW))
    const changed = plan()
    changed.assignments[0].instruction = 'Changed instruction'
    assert.throws(() => assertA1DispatchAuthorizationAdmission(
      mission(), changed, state(), NOW,
    ), /A1_DISPATCH_AUTHORIZATION_GATE_CLOSED/)
    assert.throws(() => assertA1DispatchAuthorizationAdmission(
      mission(), plan(), state(), new Date('2026-08-29T18:20:00.000Z'),
    ), /A1_DISPATCH_AUTHORIZATION_GATE_CLOSED/)
  })

  it('ships an immutable record-only migration with empty-ledger rollback', async () => {
    const sql = await readFile(new URL('../migrations/030_a1_dispatch_authorization.sql', import.meta.url), 'utf8')
    assert.match(sql, /CREATE TABLE control\.a1_dispatch_authorizations/)
    assert.match(sql, /A1_DISPATCH_AUTHORIZATION_IMMUTABLE_CONFLICT/)
    assert.match(sql, /NOT control\.is_global_kill_switch_active\(\)/)
    assert.match(sql, /'assignmentCreated',false/)
    assert.match(sql, /'dispatchQueued',false/)
    assert.doesNotMatch(sql, /control\.enqueue_dispatch|control\.claim_dispatch|mail\.send|integration\.enqueue_crm_change/i)
    const rollback = await readFile(new URL('../migrations/030_a1_dispatch_authorization.rollback.sql', import.meta.url), 'utf8')
    assert.match(rollback, /A1_DISPATCH_AUTHORIZATION_HISTORY_PRESENT/)
    assert.match(rollback, /DELETE FROM control\.schema_migrations WHERE version='030_a1_dispatch_authorization'/)
  })

  it('requires the exact authorization before the existing assignment endpoint can enqueue', async () => {
    const source = await readFile(new URL('../src/application.ts', import.meta.url), 'utf8')
    assert.match(source, /await this\.requireA1DispatchAdmission\(mission, plan, admissionTime\)/)
    assert.match(source, /hashA1AssignmentPlan\(plan\)/)
    assert.match(source, /execution\.assignments\.length !== 0/)
    assert.match(source, /A1_DISPATCH_AUTHORIZATION_GATE_CLOSED/)
  })
})
