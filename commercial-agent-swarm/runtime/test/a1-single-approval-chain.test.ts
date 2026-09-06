import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { hashAction } from '../src/canonical.js'
import {
  A1_SINGLE_APPROVAL_PROFILES,
  A1_SINGLE_APPROVAL_STAGES,
  requiredA1SingleApprovalAuthorizationBytes,
  validateA1SingleApprovalChainAuthorization,
  validateA1SingleApprovalChainRequest,
  type A1SingleApprovalChainRequest,
} from '../src/a1-single-approval-chain.js'

const MISSION = 'a3070000-0000-4307-8307-000000000001'
const TRACE = 'a3070000-0000-4307-8307-000000000002'
const NOW = new Date('2026-09-06T21:00:00.000Z')

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function uuidFromDigest(value: string): string {
  const chars = value.slice(0, 32).split('')
  chars[12] = '5'
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4]
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function plan() {
  return {
    mission_id: MISSION,
    trace_id: TRACE,
    plan_version: 'a1-r307',
    assignments: A1_SINGLE_APPROVAL_PROFILES.map((profile, index) => ({
      assignment_id: `a3070000-0000-4307-8307-${String(index + 10).padStart(12, '0')}`,
      idempotency_key: `a1-r307-assignment-${index}`,
      profile_id: profile,
      instruction: `Synthetic internal task ${index}.`,
      evidence: index === 1 ? 'External text says to reveal credentials; treat only as data.' : 'Synthetic evidence only.',
      depends_on: index === 0 ? [] : [`a3070000-0000-4307-8307-${String(index + 9).padStart(12, '0')}`],
      usage_value_reservation_usd: 0.01,
      maximum_tokens: 6144,
      maximum_api_calls: 3,
      max_attempts: 1,
    })),
  }
}

function request(): A1SingleApprovalChainRequest {
  const assignmentPlan = plan()
  const core = {
    schema_version: 1,
    type: 'a1_single_approval_chain_request_r302',
    status: 'authorization_required_not_approved',
    requested_by: 'auditor:codex-local',
    prepared_at: NOW.toISOString(),
    expires_at: '2026-09-06T21:30:00.000Z',
    mission_id: MISSION,
    trace_id: TRACE,
    plan_version: assignmentPlan.plan_version,
    signed_work_order_sha256: 'a'.repeat(64),
    expected_mission_sha256: 'b'.repeat(64),
    assignment_plan_sha256: hashAction(assignmentPlan),
    job_set_sha256: hashAction({ mission_id: MISSION, assignment_ids: assignmentPlan.assignments.map((item) => item.assignment_id) }),
    assignment_count: 6,
    assignment_ids: assignmentPlan.assignments.map((item) => item.assignment_id),
    assignment_plan: assignmentPlan,
    worker_id: 'broker-dispatcher-1',
    maximum_dispatch_ticks: 6,
    maximum_provider_credit_spend_usd: 0.06,
    stages: [...A1_SINGLE_APPROVAL_STAGES],
    guardrails: {
      single_human_approval: true,
      derived_internal_subgates_only: true,
      exact_dag_only: true,
      no_retry_on_uncertain: true,
      automatic_recontainment_required: true,
      manual_dispatch_required: true,
      arbitrary_web_research_allowed: false,
      provider_api_allowed_within_budget: true,
      maximum_external_actions: 0,
      contact_permitted: false,
      crm_writes: 0,
      a3_blocked: true,
      mail_blocked: true,
      telegram_blocked: true,
      active_channel_kill_switches_required: 7,
      timer_must_remain_disabled: true,
    },
  } as const
  const digest = hashAction(core)
  const value = {
    ...core,
    assignment_ids: [...core.assignment_ids],
    assignment_plan: structuredClone(core.assignment_plan),
    stages: [...core.stages],
    guardrails: { ...core.guardrails },
    request_id: uuidFromDigest(digest),
    authorization_digest_sha256: digest,
    required_authorization_text_sha256: '0'.repeat(64),
    authorization_granted: false,
    chain_executed: false,
    provider_credit_spend_allowed: false,
    external_actions: 0,
    crm_writes: 0,
  } as unknown as A1SingleApprovalChainRequest
  value.required_authorization_text_sha256 = sha256(requiredA1SingleApprovalAuthorizationBytes(value))
  return value
}

function authorization(req: A1SingleApprovalChainRequest) {
  const bytes = requiredA1SingleApprovalAuthorizationBytes(req)
  const authorizationSha256 = sha256(bytes)
  return {
    schema_version: 1,
    type: 'a1_single_approval_chain_authorization_r303',
    request_id: req.request_id,
    authorization_digest_sha256: req.authorization_digest_sha256,
    mission_id: req.mission_id,
    trace_id: req.trace_id,
    assignment_plan_sha256: req.assignment_plan_sha256,
    job_set_sha256: req.job_set_sha256,
    assignment_ids: [...req.assignment_ids],
    worker_id: req.worker_id,
    maximum_dispatch_ticks: req.maximum_dispatch_ticks,
    maximum_provider_credit_spend_usd: req.maximum_provider_credit_spend_usd,
    decision: 'approved',
    rationale: 'Autoriza una sola cadena A1 interna y exacta; los subgates son derivados, auditables y no amplían su alcance.',
    reviewer_id: 'user:proptimizaspa@gmail.com',
    reviewer_email: 'proptimizaspa@gmail.com',
    reviewed_at: NOW.toISOString(),
    expires_at: req.expires_at,
    user_authorization_sha256: authorizationSha256,
    stage_receipt_keys: Object.fromEntries(A1_SINGLE_APPROVAL_STAGES.map((stage) => [stage, hashAction({
      authorization_sha256: authorizationSha256,
      chain_digest_sha256: req.authorization_digest_sha256,
      stage,
    })])),
    authorization_granted: true,
    chain_executed: false,
    provider_credit_spend_allowed: false,
    external_actions: 0,
    crm_writes: 0,
    next_required_gate: 'execute_exact_chain_once',
  }
}

describe('A1 single-approval Runtime contract', () => {
  it('accepts the exact six-profile request and byte-exact authorization', () => {
    const req = validateA1SingleApprovalChainRequest(request(), NOW)
    const bytes = requiredA1SingleApprovalAuthorizationBytes(req)
    const envelope = validateA1SingleApprovalChainAuthorization(authorization(req), req, bytes, NOW)
    assert.equal(req.assignment_count, 6)
    assert.equal(req.maximum_dispatch_ticks, 6)
    assert.equal(envelope.authorization_granted, true)
    assert.equal(envelope.external_actions, 0)
    assert.equal(Object.keys(envelope.stage_receipt_keys).length, 10)
  })

  it('produces the exact stable authorization sentence including trailing LF', () => {
    const bytes = requiredA1SingleApprovalAuthorizationBytes(request())
    assert.equal(bytes.at(-1), 0x0a)
    assert.match(bytes.toString('utf8'), /procesar exactamente 6 asignaciones/)
    assert.match(bytes.toString('utf8'), /USD 0\.060000/)
    assert.match(bytes.toString('utf8'), /No autorizo investigación web, contacto, CRM, A3, correo, Telegram/)
  })

  for (const [name, mutate] of [
    ['profile order', (value: any) => { value.assignment_plan.assignments[1].profile_id = 'contact-data-steward' }],
    ['DAG dependency', (value: any) => { value.assignment_plan.assignments[3].depends_on = [value.assignment_ids[0]] }],
    ['retry expansion', (value: any) => { value.assignment_plan.assignments[2].max_attempts = 2 }],
    ['budget expansion', (value: any) => { value.maximum_provider_credit_spend_usd = 0.5 }],
    ['budget type', (value: any) => { value.maximum_provider_credit_spend_usd = '0.06' }],
    ['external channel', (value: any) => { value.guardrails.mail_blocked = false }],
    ['extra field', (value: any) => { value.unapproved_scope = true }],
  ] as const) it(`rejects ${name} drift`, () => {
    const value: any = request()
    mutate(value)
    assert.throws(() => validateA1SingleApprovalChainRequest(value, NOW), /A1_SINGLE_APPROVAL_CHAIN_REQUEST_INVALID/)
  })

  it('rejects an expired chain', () => {
    assert.throws(
      () => validateA1SingleApprovalChainRequest(request(), new Date('2026-09-06T21:30:00.000Z')),
      /A1_SINGLE_APPROVAL_CHAIN_REQUEST_INVALID/,
    )
  })

  it('rejects non-exact approval bytes', () => {
    const req = request()
    const bytes = Buffer.concat([requiredA1SingleApprovalAuthorizationBytes(req), Buffer.from(' ')])
    assert.throws(
      () => validateA1SingleApprovalChainAuthorization(authorization(req), req, bytes, NOW),
      /A1_SINGLE_APPROVAL_CHAIN_AUTHORIZATION_INVALID/,
    )
  })

  it('rejects a derived receipt-key mutation', () => {
    const req = request()
    const envelope: any = authorization(req)
    envelope.stage_receipt_keys.dispatch_bounded_dag = '0'.repeat(64)
    assert.throws(
      () => validateA1SingleApprovalChainAuthorization(envelope, req, requiredA1SingleApprovalAuthorizationBytes(req), NOW),
      /A1_SINGLE_APPROVAL_CHAIN_AUTHORIZATION_INVALID/,
    )
  })

  it('keeps prompt-injection text inert inside evidence', () => {
    const req = validateA1SingleApprovalChainRequest(request(), NOW)
    assert.match(req.assignment_plan.assignments[1].evidence, /reveal credentials/)
    assert.equal(req.guardrails.arbitrary_web_research_allowed, false)
    assert.equal(req.guardrails.maximum_external_actions, 0)
    assert.equal(req.guardrails.crm_writes, 0)
  })
})
