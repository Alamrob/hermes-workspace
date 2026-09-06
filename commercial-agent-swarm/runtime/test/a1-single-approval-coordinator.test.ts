import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  A1SingleApprovalCoordinatorError,
  runA1SingleApprovalCoordinator,
  type A1SingleApprovalControlState,
  type A1SingleApprovalCoordinatorAdapter,
  type A1SingleApprovalOperationResult,
  type A1SingleApprovalStageContext,
} from '../src/a1-single-approval-coordinator.js'
import {
  A1_SINGLE_APPROVAL_PROFILES,
  A1_SINGLE_APPROVAL_STAGES,
  requiredA1SingleApprovalAuthorizationBytes,
  type A1SingleApprovalChainRequest,
} from '../src/a1-single-approval-chain.js'
import { hashAction } from '../src/canonical.js'

const MISSION = 'a3080000-0000-4308-8308-000000000001'
const TRACE = 'a3080000-0000-4308-8308-000000000002'
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

function artifacts() {
  const assignmentPlan = {
    mission_id: MISSION,
    trace_id: TRACE,
    plan_version: 'a1-r308',
    assignments: A1_SINGLE_APPROVAL_PROFILES.map((profile, index) => ({
      assignment_id: `a3080000-0000-4308-8308-${String(index + 10).padStart(12, '0')}`,
      idempotency_key: `a1-r308-assignment-${index}`,
      profile_id: profile,
      instruction: `Synthetic internal task ${index}.`,
      evidence: 'Synthetic evidence only.',
      depends_on: index === 0 ? [] : [`a3080000-0000-4308-8308-${String(index + 9).padStart(12, '0')}`],
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
    plan_version: assignmentPlan.plan_version,
    signed_work_order_sha256: 'a'.repeat(64),
    expected_mission_sha256: 'b'.repeat(64),
    assignment_plan_sha256: hashAction(assignmentPlan),
    job_set_sha256: hashAction({
      mission_id: MISSION,
      assignment_ids: assignmentPlan.assignments.map((item) => item.assignment_id),
    }),
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
  const request = {
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
  const bytes = requiredA1SingleApprovalAuthorizationBytes(request)
  request.required_authorization_text_sha256 = sha256(bytes)
  const authorizationSha256 = sha256(bytes)
  const envelope = {
    schema_version: 1,
    type: 'a1_single_approval_chain_authorization_r303',
    request_id: request.request_id,
    authorization_digest_sha256: request.authorization_digest_sha256,
    mission_id: request.mission_id,
    trace_id: request.trace_id,
    assignment_plan_sha256: request.assignment_plan_sha256,
    job_set_sha256: request.job_set_sha256,
    assignment_ids: [...request.assignment_ids],
    worker_id: request.worker_id,
    maximum_dispatch_ticks: request.maximum_dispatch_ticks,
    maximum_provider_credit_spend_usd: request.maximum_provider_credit_spend_usd,
    decision: 'approved',
    rationale: 'Autoriza una sola cadena A1 interna y exacta; los subgates son derivados, auditables y no amplían su alcance.',
    reviewer_id: 'user:proptimizaspa@gmail.com',
    reviewer_email: 'proptimizaspa@gmail.com',
    reviewed_at: NOW.toISOString(),
    expires_at: request.expires_at,
    user_authorization_sha256: authorizationSha256,
    stage_receipt_keys: Object.fromEntries(A1_SINGLE_APPROVAL_STAGES.map((stage) => [stage, hashAction({
      authorization_sha256: authorizationSha256,
      chain_digest_sha256: request.authorization_digest_sha256,
      stage,
    })])),
    authorization_granted: true,
    chain_executed: false,
    provider_credit_spend_allowed: false,
    external_actions: 0,
    crm_writes: 0,
    next_required_gate: 'execute_exact_chain_once',
  }
  return { request, bytes, envelope }
}

class FakeAdapter implements A1SingleApprovalCoordinatorAdapter {
  readonly calls: string[] = []
  parent = false
  window = false
  completed = 0
  usage = 0

  constructor(readonly options: {
    failAt?: string
    uncertainAt?: number
    duplicateAt?: number
    budgetAt?: number
    killDriftAt?: number
    containmentFailure?: boolean
  } = {}) {}

  async inspect(): Promise<A1SingleApprovalControlState> {
    return {
      mission_id: MISSION,
      channel_kills: 7,
      external_actions_blocked: true,
      timer_enabled: false,
      timer_active: false,
      external_actions: 0,
      crm_writes: 0,
      crm_outbox: 0,
      global_kill: !this.window,
      execution_window_open: this.window,
      dispatch_claiming_permitted: this.window,
      active_or_uncertain_jobs: 0,
      parent_authorization_consumed: this.parent,
      completed_jobs: this.completed,
      usage_value_consumed_usd: this.usage,
    }
  }

  private async step(name: string, extra: Record<string, unknown> = {}): Promise<A1SingleApprovalOperationResult> {
    this.calls.push(name)
    if (this.options.failAt === name) throw new Error('synthetic secret-bearing adapter error')
    return {
      status: 'completed',
      mission_id: MISSION,
      external_actions: 0,
      crm_writes: 0,
      untrusted_detail: 'must-not-escape',
      ...extra,
    }
  }

  async consumeParentAuthorization(): Promise<A1SingleApprovalOperationResult> {
    const result = await this.step('consume_parent_authorization', { consumed: true })
    this.parent = true
    return result
  }

  async registerAssignmentPlanAuthorization(): Promise<A1SingleApprovalOperationResult> {
    return this.step('register_assignment_plan_authorization')
  }

  async registerEnqueueAuthorization(): Promise<A1SingleApprovalOperationResult> {
    return this.step('register_enqueue_authorization')
  }

  async materializeExactJobSet(): Promise<A1SingleApprovalOperationResult> {
    return this.step('materialize_exact_job_set')
  }

  async registerExecutionAuthorization(): Promise<A1SingleApprovalOperationResult> {
    return this.step('register_execution_authorization')
  }

  async createExecutionArm(): Promise<A1SingleApprovalOperationResult> {
    return this.step('create_execution_arm')
  }

  async openExecutionWindow(): Promise<A1SingleApprovalOperationResult> {
    const result = await this.step('open_execution_window', {
      execution_window_open: true,
      dispatch_claiming_permitted: true,
    })
    this.window = true
    return result
  }

  async dispatchOne(context: A1SingleApprovalStageContext & { tick: number }): Promise<A1SingleApprovalOperationResult> {
    const result = await this.step('dispatch_bounded_dag', {
      processed: this.options.uncertainAt === context.tick ? null : true,
      job_id: `job-${this.options.duplicateAt === context.tick ? 1 : context.tick}`,
      retry_attempted: false,
    })
    if (this.options.killDriftAt === context.tick) this.window = false
    this.usage = this.options.budgetAt === context.tick ? 1 : this.usage + 0.01
    this.completed += 1
    return result
  }

  async recontainExecutionWindow(): Promise<A1SingleApprovalOperationResult> {
    if (this.options.containmentFailure) throw new Error('synthetic containment failure')
    const result = await this.step('recontain_execution_window', { recontained: true })
    this.window = false
    return result
  }

  async auditTerminalState(): Promise<A1SingleApprovalOperationResult> {
    return this.step('audit_terminal_state', {
      verdict: 'pass',
      completed_jobs: this.completed,
      usage_value_consumed_usd: this.usage,
    })
  }
}

describe('A1 single-approval Runtime coordinator', () => {
  it('executes the exact six-profile DAG once and recontains', async () => {
    const data = artifacts()
    const adapter = new FakeAdapter()
    const result = await runA1SingleApprovalCoordinator({ ...data, authorizationBytes: data.bytes, adapter, now: NOW })
    assert.equal(result.status, 'completed')
    assert.equal(result.completed_jobs, 6)
    assert.equal(result.dispatch_ticks, 6)
    assert.equal(result.receipts.length, 15)
    assert.equal(result.external_actions, 0)
    assert.equal(result.crm_writes, 0)
    assert.equal(JSON.stringify(result).includes('must-not-escape'), false)
    assert.equal(adapter.window, false)
  })

  it('rejects an incomplete adapter before mutation', async () => {
    const data = artifacts()
    await assert.rejects(
      runA1SingleApprovalCoordinator({ ...data, authorizationBytes: data.bytes, adapter: {} as A1SingleApprovalCoordinatorAdapter, now: NOW }),
      /A1_SINGLE_APPROVAL_ADAPTER_METHOD_MISSING/,
    )
  })

  it('rejects non-exact authorization bytes before mutation', async () => {
    const data = artifacts()
    const adapter = new FakeAdapter()
    await assert.rejects(
      runA1SingleApprovalCoordinator({ ...data, authorizationBytes: Buffer.from('wrong'), adapter, now: NOW }),
      /A1_SINGLE_APPROVAL_CHAIN_AUTHORIZATION_INVALID/,
    )
    assert.equal(adapter.calls.length, 0)
  })

  it('rejects a previously consumed parent before consuming again', async () => {
    const data = artifacts()
    const adapter = new FakeAdapter()
    adapter.parent = true
    await assert.rejects(
      runA1SingleApprovalCoordinator({ ...data, authorizationBytes: data.bytes, adapter, now: NOW }),
      /A1_SINGLE_APPROVAL_FAILED_CLOSED/,
    )
    assert.equal(adapter.calls.includes('consume_parent_authorization'), false)
  })

  it('recontains an internal failure and never retries it', async () => {
    const data = artifacts()
    const adapter = new FakeAdapter({ failAt: 'register_execution_authorization' })
    await assert.rejects(
      runA1SingleApprovalCoordinator({ ...data, authorizationBytes: data.bytes, adapter, now: NOW }),
      /A1_SINGLE_APPROVAL_FAILED_CLOSED/,
    )
    assert.equal(adapter.calls.filter((item) => item === 'register_execution_authorization').length, 1)
    assert.equal(adapter.window, false)
  })

  for (const [name, options, ticks] of [
    ['uncertain dispatch', { uncertainAt: 2 }, 2],
    ['duplicate job receipt', { duplicateAt: 2 }, 2],
    ['provider budget overrun', { budgetAt: 3 }, 3],
    ['execution authority drift', { killDriftAt: 2 }, 2],
  ] as const) {
    it(`recontains after ${name} without retry`, async () => {
      const data = artifacts()
      const adapter = new FakeAdapter(options)
      await assert.rejects(
        runA1SingleApprovalCoordinator({ ...data, authorizationBytes: data.bytes, adapter, now: NOW }),
        /A1_SINGLE_APPROVAL_FAILED_CLOSED/,
      )
      assert.equal(adapter.calls.filter((item) => item === 'dispatch_bounded_dag').length, ticks)
      assert.equal(adapter.window, false)
    })
  }

  it('reports unproven containment as a distinct critical error without leaking adapter details', async () => {
    const data = artifacts()
    const adapter = new FakeAdapter({ uncertainAt: 1, containmentFailure: true })
    await assert.rejects(
      runA1SingleApprovalCoordinator({ ...data, authorizationBytes: data.bytes, adapter, now: NOW }),
      (error) => {
        assert.ok(error instanceof A1SingleApprovalCoordinatorError)
        assert.equal(error.code, 'A1_SINGLE_APPROVAL_RECONTAINMENT_UNPROVEN')
        assert.equal(error.message.includes('synthetic containment failure'), false)
        return true
      },
    )
  })

  for (const [name, mutate] of [
    ['channel kill', (state: A1SingleApprovalControlState) => Object.assign(state, { channel_kills: 6 })],
    ['CRM outbox', (state: A1SingleApprovalControlState) => Object.assign(state, { crm_outbox: 1 })],
    ['external action', (state: A1SingleApprovalControlState) => Object.assign(state, { external_actions: 1 })],
    ['active timer', (state: A1SingleApprovalControlState) => Object.assign(state, { timer_active: true })],
  ] as const) {
    it(`fails closed on ${name} drift`, async () => {
      const data = artifacts()
      const adapter = new FakeAdapter()
      const inspect = adapter.inspect.bind(adapter)
      adapter.inspect = async () => {
        const state = await inspect()
        if (adapter.completed === 1) mutate(state)
        return state
      }
      await assert.rejects(
        runA1SingleApprovalCoordinator({ ...data, authorizationBytes: data.bytes, adapter, now: NOW }),
        (error) => error instanceof A1SingleApprovalCoordinatorError &&
          error.code === 'A1_SINGLE_APPROVAL_RECONTAINMENT_UNPROVEN',
      )
      assert.equal(adapter.window, false)
    })
  }
})
