import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  A1SingleApprovalBrokerApplicationPort,
  A1SingleApprovalBrokerApplicationPortError,
  type A1SingleApprovalControlCapability,
} from '../src/a1-single-approval-broker-application-port.js'
import type { ApplicationRequest, ApplicationResponse } from '../src/application.js'
import type {
  A1SingleApprovalBrokerDispatchInput,
  A1SingleApprovalBrokerMaterializeInput,
  A1SingleApprovalBrokerParentInput,
  A1SingleApprovalBrokerRecontainInput,
  A1SingleApprovalBrokerSubgateInput,
} from '../src/a1-single-approval-broker-adapter.js'
import type { A1SingleApprovalControlState } from '../src/a1-single-approval-coordinator.js'
import type { MissionExecution } from '../src/dispatch-queue.js'
import type { AssignmentPlan } from '../src/assignment-plan.js'
import { A1_SINGLE_APPROVAL_PROFILES } from '../src/a1-single-approval-chain.js'

const MISSION = 'a3100000-0000-4310-8310-000000000001'
const AUTH = 'a'.repeat(64)
const RECEIPT = 'b'.repeat(64)
const TOKEN = 'capability-token-0123456789abcdef'
const IDS = Array.from({ length: 6 }, (_, index) =>
  `a3100000-0000-4310-8310-${String(index + 10).padStart(12, '0')}`)

function assignmentPlan(): AssignmentPlan {
  return {
    mission_id: MISSION,
    trace_id: 'a3100000-0000-4310-8310-000000000002',
    plan_version: 'a1-r310',
    assignments: IDS.map((assignmentId, index) => ({
      assignment_id: assignmentId,
      idempotency_key: `a1-r310-${index}`,
      profile_id: A1_SINGLE_APPROVAL_PROFILES[index],
      instruction: `Synthetic task ${index}`,
      evidence: 'Synthetic evidence.',
      depends_on: index === 0 ? [] : [IDS[index - 1]],
      usage_value_reservation_usd: 0.01,
      maximum_tokens: 6144,
      maximum_api_calls: 3,
      max_attempts: 1,
    })),
  }
}

class FakeApplication {
  readonly requests: ApplicationRequest[] = []
  execution: MissionExecution = {
    mission_id: MISSION,
    status: 'queued',
    assignments: IDS.map((id, index) => ({
      assignment_id: id,
      profile_id: [
        'sales-orchestrator', 'market-account-intelligence', 'contact-data-steward',
        'qualification-prioritization', 'outreach-draft-manager', 'commercial-qa-compliance',
      ][index] as MissionExecution['assignments'][number]['profile_id'],
      status: 'queued',
      attempts: 0,
      max_attempts: 1,
      artifact_sha256: null,
      result_envelope: null,
      error: null,
    })),
  }

  async handle(request: ApplicationRequest): Promise<ApplicationResponse> {
    this.requests.push(structuredClone(request))
    if (request.path === `/v1/missions/${MISSION}/assignments`) {
      return {
        status: 202,
        body: { mission_id: MISSION, assignment_ids: [...IDS], status: 'queued' },
      }
    }
    if (request.path === `/internal/v1/missions/${MISSION}/execution`) {
      return { status: 200, body: structuredClone(this.execution) }
    }
    return { status: 200, body: {} }
  }
}

class FakeControl implements A1SingleApprovalControlCapability {
  calls: string[] = []
  completed = 0
  window = false
  parent = false
  dispatchResponse: Record<string, unknown> = {
    status: 'processed', processed: true, external_actions: 0, retry_attempted: false,
  }

  constructor(readonly application: FakeApplication) {}

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
      usage_value_consumed_usd: this.completed / 100,
    }
  }

  async consumeParentAuthorization(): Promise<unknown> {
    this.calls.push('consume')
    this.parent = true
    return { consumed: true }
  }

  async dispatchOnce(input: A1SingleApprovalBrokerDispatchInput): Promise<unknown> {
    this.calls.push(`tick-${input.tick}`)
    if (this.dispatchResponse.processed === true) {
      const assignment = this.application.execution.assignments[input.tick - 1]
      assignment.status = 'succeeded'
      assignment.attempts = 1
      assignment.artifact_sha256 = String(input.tick).repeat(64)
      assignment.result_envelope = { status: 'completed' }
      this.completed += 1
      this.application.execution.status = this.completed === 6 ? 'completed' : 'running'
    }
    return structuredClone(this.dispatchResponse)
  }

  async recontain(_input: A1SingleApprovalBrokerRecontainInput): Promise<unknown> {
    this.calls.push('recontain')
    this.window = false
    return { recontained: true }
  }
}

function create(options: {
  application?: FakeApplication
  control?: FakeControl
  shadow?: () => Promise<string>
  controlPlane?: () => Promise<string>
  internal?: () => Promise<string>
} = {}) {
  const application = options.application ?? new FakeApplication()
  const control = options.control ?? new FakeControl(application)
  return {
    application,
    control,
    port: new A1SingleApprovalBrokerApplicationPort({
      application,
      control,
      shadowReviewBearer: options.shadow ?? (async () => TOKEN),
      controlPlaneBearer: options.controlPlane ?? (async () => TOKEN),
      internalBearer: options.internal ?? (async () => TOKEN),
    }),
  }
}

describe('A1 BrokerApplication concrete port', () => {
  it('consumes the parent through the narrow control capability', async () => {
    const { port, control, application } = create()
    const input: A1SingleApprovalBrokerParentInput = {
      request_id: MISSION,
      mission_id: MISSION,
      authorization_digest_sha256: AUTH,
      user_authorization_sha256: AUTH,
      stage_receipt_key: RECEIPT,
      idempotency_key: RECEIPT,
    }
    assert.deepEqual(await port.consumeParentAuthorization(input), {
      status: 'completed', mission_id: MISSION, stage_receipt_key: RECEIPT,
      external_actions: 0, crm_writes: 0, consumed: true,
    })
    assert.deepEqual(control.calls, ['consume'])
    assert.equal(application.requests.length, 0)
  })

  it('materializes only the exact assignment route with the control-plane capability', async () => {
    const { port, application } = create()
    const plan = assignmentPlan()
    const input: A1SingleApprovalBrokerMaterializeInput = {
      mission_id: MISSION,
      stage_receipt_key: RECEIPT,
      user_authorization_sha256: AUTH,
      assignment_plan: plan,
    }
    const result = await port.materializeExactJobSet(input)
    assert.deepEqual(result, {
      status: 'completed', mission_id: MISSION, stage_receipt_key: RECEIPT,
      external_actions: 0, crm_writes: 0, assignment_ids: IDS, queued: true,
    })
    assert.equal(application.requests.length, 1)
    assert.equal(application.requests[0].path, `/v1/missions/${MISSION}/assignments`)
    assert.equal(application.requests[0].headers?.authorization, `Bearer ${TOKEN}`)
    assert.deepEqual(application.requests[0].body, plan)
  })

  it('dispatches one exact queued job per tick and proves terminal containment', async () => {
    const { port, control, application } = create()
    control.parent = true
    control.window = true
    for (let tick = 1; tick <= 6; tick += 1) {
      const result = await port.dispatchOnce({
        mission_id: MISSION,
        worker_id: 'broker-dispatcher-1',
        tick,
        stage_receipt_key: RECEIPT,
        user_authorization_sha256: AUTH,
      })
      assert.equal((result as Record<string, unknown>).job_id, IDS[tick - 1])
    }
    await port.recontain({
      mission_id: MISSION,
      reason: 'A1_SINGLE_APPROVAL_CHAIN_COMPLETED',
      stage_receipt_key: RECEIPT,
      user_authorization_sha256: AUTH,
    })
    const result = await port.auditTerminal({
      mission_id: MISSION,
      assignment_ids: [...IDS],
      maximum_provider_credit_spend_usd: 0.06,
      stage_receipt_key: RECEIPT,
      user_authorization_sha256: AUTH,
    })
    assert.deepEqual(result, {
      status: 'completed', mission_id: MISSION, stage_receipt_key: RECEIPT,
      external_actions: 0, crm_writes: 0, verdict: 'pass', completed_jobs: 6,
      usage_value_consumed_usd: 0.06,
    })
    assert.deepEqual(control.calls, [
      'tick-1', 'tick-2', 'tick-3', 'tick-4', 'tick-5', 'tick-6', 'recontain',
    ])
    assert.equal(application.execution.status, 'completed')
  })

  it('does not retry an uncertain dispatcher response', async () => {
    const application = new FakeApplication()
    const control = new FakeControl(application)
    control.window = true
    control.dispatchResponse = {
      status: 'idle', processed: false, external_actions: 0, retry_attempted: false,
    }
    const { port } = create({ application, control })
    await assert.rejects(
      port.dispatchOnce({
        mission_id: MISSION, worker_id: 'broker-dispatcher-1', tick: 1,
        stage_receipt_key: RECEIPT, user_authorization_sha256: AUTH,
      }),
      /A1_APPLICATION_PORT_DISPATCH_UNCERTAIN/,
    )
    assert.deepEqual(control.calls, ['tick-1'])
  })

  it('uses only the five fixed subgate routes and rejects malformed broker states', async () => {
    const { port, application } = create()
    const input: A1SingleApprovalBrokerSubgateInput = {
      mission_id: MISSION,
      stage_receipt_key: RECEIPT,
      user_authorization_sha256: AUTH,
      body: { approved: true },
    }
    const calls = [
      () => port.recordDispatchAuthorization(input),
      () => port.recordEnqueueAuthorization(input),
      () => port.recordExecutionAuthorization(input),
      () => port.recordExecutionArm(input),
      () => port.activateExecutionWindow(input),
    ]
    for (const call of calls) await assert.rejects(call)
    assert.deepEqual(application.requests.map((request) => request.path), [
      `/internal/v1/a1-dispatch-authorizations/${MISSION}`,
      `/internal/v1/a1-assignment-enqueue-authorizations/${MISSION}`,
      `/internal/v1/a1-assignment-execution-authorizations/${MISSION}`,
      `/internal/v1/a1-dispatch-execution-arms/${MISSION}`,
      `/internal/v1/a1-dispatch-execution-windows/${MISSION}`,
    ])
    assert.equal(application.requests.every((request) =>
      request.headers?.authorization === `Bearer ${TOKEN}`), true)
  })

  it('fails before BrokerApplication when a capability is unavailable or malformed', async () => {
    for (const loader of [
      async () => { throw new Error('secret value') },
      async () => 'short',
    ]) {
      const { port, application } = create({ controlPlane: loader })
      await assert.rejects(
        port.materializeExactJobSet({
          mission_id: MISSION,
          stage_receipt_key: RECEIPT,
          user_authorization_sha256: AUTH,
          assignment_plan: assignmentPlan(),
        }),
        (error) => {
          assert.ok(error instanceof A1SingleApprovalBrokerApplicationPortError)
          assert.equal(error.message.includes('secret value'), false)
          return true
        },
      )
      assert.equal(application.requests.length, 0)
    }
  })
})
