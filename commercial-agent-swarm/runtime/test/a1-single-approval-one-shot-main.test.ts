import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  A1_SINGLE_APPROVAL_PROFILES,
  A1_SINGLE_APPROVAL_STAGES,
  requiredA1SingleApprovalAuthorizationBytes,
  type A1SingleApprovalChainRequest,
} from '../src/a1-single-approval-chain.js'
import {
  A1SingleApprovalOneShotError,
  runA1SingleApprovalOneShot,
} from '../src/a1-single-approval-one-shot-main.js'
import { hashAction } from '../src/canonical.js'

const NOW = new Date('2026-09-06T21:00:00.000Z')
const MISSION = 'a3900000-0000-4390-8390-000000000001'
const TRACE = 'a3900000-0000-4390-8390-000000000002'

function environment(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    COMMERCIAL_MODE: 'simulation',
    A3_ENABLED: 'false',
    HOSTINGER_MAIL_ENABLED: 'false',
    TELEGRAM_APPROVAL_ENABLED: 'false',
    EXTERNAL_RESEARCH_ENABLED: 'false',
    EXTERNAL_ACTION_KILL_SWITCH: 'true',
    DISPATCH_LOOP_MODE: 'manual',
    A1_SINGLE_APPROVAL_RUN_MODE: 'one_shot',
    A1_CHAIN_REQUEST_FILE: '/run/a1-single-approval/request.json',
    A1_CHAIN_ENVELOPE_FILE: '/run/a1-single-approval/envelope.json',
    A1_CHAIN_AUTHORIZATION_FILE: '/run/a1-single-approval/authorization.txt',
    A1_CHAIN_TIMER_ATTESTATION_FILE: '/run/a1-single-approval/timer.json',
    A1_CHAIN_DATABASE_URL_FILE: '/run/secrets/a1-chain-database-url',
  }
}

function request(): A1SingleApprovalChainRequest {
  const plan = {
    mission_id: MISSION,
    trace_id: TRACE,
    plan_version: 'a1-r390',
    assignments: A1_SINGLE_APPROVAL_PROFILES.map((profile, index) => ({
      assignment_id: `a3900000-0000-4390-8390-${String(index + 10).padStart(12, '0')}`,
      idempotency_key: `a1-r390-${index}`,
      profile_id: profile,
      instruction: `Synthetic internal task ${index}.`,
      evidence: 'Synthetic evidence only.',
      depends_on: index === 0 ? [] : [`a3900000-0000-4390-8390-${String(index + 9).padStart(12, '0')}`],
      usage_value_reservation_usd: 0.01,
      maximum_tokens: 6144,
      maximum_api_calls: 3,
      max_attempts: 1,
    })),
  }
  const core = {
    schema_version: 1,
    type: 'a1_single_approval_chain_request_r302',
    status: 'authorization_required_not_approved',
    requested_by: 'auditor:codex-local',
    prepared_at: NOW.toISOString(),
    expires_at: '2026-09-06T21:30:00.000Z',
    mission_id: MISSION,
    trace_id: TRACE,
    plan_version: plan.plan_version,
    signed_work_order_sha256: 'a'.repeat(64),
    expected_mission_sha256: 'b'.repeat(64),
    assignment_plan_sha256: hashAction(plan),
    job_set_sha256: hashAction({ mission_id: MISSION, assignment_ids: plan.assignments.map((item) => item.assignment_id) }),
    assignment_count: 6,
    assignment_ids: plan.assignments.map((item) => item.assignment_id),
    assignment_plan: plan,
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
  const req = {
    ...core,
    request_id: uuidFromDigest(digest),
    authorization_digest_sha256: digest,
    required_authorization_text_sha256: '0'.repeat(64),
    authorization_granted: false,
    chain_executed: false,
    provider_credit_spend_allowed: false,
    external_actions: 0,
    crm_writes: 0,
  } as unknown as A1SingleApprovalChainRequest
  req.required_authorization_text_sha256 = sha256(requiredA1SingleApprovalAuthorizationBytes(req))
  return req
}

function authorization(req: A1SingleApprovalChainRequest): Record<string, unknown> {
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

describe('A1 single-approval one-shot main boundary', () => {
  it('rejects arguments, open channels, file reuse and raw database credentials before IO', async () => {
    const cases: Array<[Record<string, string>, string[]]> = [
      [environment(), ['--retry']],
      [{ ...environment(), HOSTINGER_MAIL_ENABLED: 'true' }, []],
      [{ ...environment(), A1_CHAIN_ENVELOPE_FILE: '/run/a1-single-approval/request.json' }, []],
      [{ ...environment(), A1_CHAIN_DATABASE_URL: 'postgresql://secret' }, []],
    ]
    for (const [env, argv] of cases) {
      let reads = 0
      await assert.rejects(
        runA1SingleApprovalOneShot(env, {
          readSealed: async () => { reads += 1; return Buffer.from('{}') },
        }, argv),
        (error) => error instanceof A1SingleApprovalOneShotError,
      )
      assert.equal(reads, 0)
    }
  })

  it('rejects malformed sealed content before opening database or broker resources', async () => {
    let databases = 0
    let runtimes = 0
    await assert.rejects(runA1SingleApprovalOneShot(environment(), {
      readSealed: async () => Buffer.from('{}'),
      readDatabaseUrl: async () => 'postgresql://not-opened',
      createDatabase: () => { databases += 1; throw new Error('must not open') },
      createRuntime: async () => { runtimes += 1; throw new Error('must not open') },
      now: () => NOW,
    }), /A1_ONE_SHOT_INVOCATION_INVALID/)
    assert.equal(databases, 0)
    assert.equal(runtimes, 0)
  })

  it('validates exact request, envelope and authorization bytes before runtime startup', async () => {
    const req = request()
    const envelope = authorization(req)
    const bytes = requiredA1SingleApprovalAuthorizationBytes(req)
    const files = new Map([
      ['/run/a1-single-approval/request.json', Buffer.from(JSON.stringify(req))],
      ['/run/a1-single-approval/envelope.json', Buffer.from(JSON.stringify(envelope))],
      ['/run/a1-single-approval/authorization.txt', bytes],
    ])
    let databaseOpened = false
    let runtimeOpened = false
    await assert.rejects(runA1SingleApprovalOneShot(environment(), {
      readSealed: async (path) => files.get(path) ?? Buffer.from('{}'),
      readDatabaseUrl: async () => 'postgresql://a1@runtime/control',
      createDatabase: () => {
        databaseOpened = true
        return { query: async () => { throw new Error('unused') }, end: async () => undefined } as never
      },
      createRuntime: async () => {
        runtimeOpened = true
        throw new Error('EXPECTED_RUNTIME_STOP')
      },
      now: () => NOW,
    }), /EXPECTED_RUNTIME_STOP/)
    assert.equal(databaseOpened, true)
    assert.equal(runtimeOpened, true)
  })

  it('rejects one-byte authorization drift before opening capabilities', async () => {
    const req = request()
    const files = new Map([
      ['/run/a1-single-approval/request.json', Buffer.from(JSON.stringify(req))],
      ['/run/a1-single-approval/envelope.json', Buffer.from(JSON.stringify(authorization(req)))],
      ['/run/a1-single-approval/authorization.txt', Buffer.concat([
        requiredA1SingleApprovalAuthorizationBytes(req), Buffer.from(' '),
      ])],
    ])
    let opened = false
    await assert.rejects(runA1SingleApprovalOneShot(environment(), {
      readSealed: async (path) => files.get(path) ?? Buffer.from('{}'),
      readDatabaseUrl: async () => { opened = true; return 'postgresql://unused' },
      now: () => NOW,
    }), /A1_ONE_SHOT_INVOCATION_INVALID/)
    assert.equal(opened, false)
  })
})

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
