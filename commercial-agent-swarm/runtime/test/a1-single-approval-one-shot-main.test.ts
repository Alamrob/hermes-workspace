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
import { deriveA1SingleApprovalSubgates } from '../src/a1-single-approval-subgate-derivation.js'
import { hashAction } from '../src/canonical.js'
import type { ApplicationRequest, ApplicationResponse } from '../src/application.js'
import type { BrokerApplicationRuntime } from '../src/broker-main.js'
import type { MissionExecution } from '../src/dispatch-queue.js'

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

  it('composes the sealed inputs, function-only database control, in-process broker port and six exact ticks once', async () => {
    const req = request()
    const envelope = authorization(req)
    const authorizationBytes = requiredA1SingleApprovalAuthorizationBytes(req)
    const bundle = deriveA1SingleApprovalSubgates(req, envelope, authorizationBytes, NOW)
    const state = {
      parent: false,
      window: false,
      completed: 0,
      usage: 0,
      ended: 0,
      runtimeClosed: 0,
      timerReads: 0,
      dispatchCalls: 0,
    }
    const execution: MissionExecution = {
      mission_id: MISSION,
      status: 'queued',
      assignments: [],
    }
    const requests: ApplicationRequest[] = []
    const application = {
      handle: async (input: ApplicationRequest): Promise<ApplicationResponse> => {
        requests.push(structuredClone(input))
        if (input.path === `/v1/missions/${MISSION}/assignments`) {
          execution.assignments = req.assignment_ids.map((assignmentId, index) => ({
            assignment_id: assignmentId,
            profile_id: A1_SINGLE_APPROVAL_PROFILES[index]!,
            status: 'queued',
            attempts: 0,
            max_attempts: 1,
            artifact_sha256: null,
            result_envelope: null,
            error: null,
          }))
          return {
            status: 202,
            body: { mission_id: MISSION, assignment_ids: [...req.assignment_ids], status: 'queued' },
          }
        }
        if (input.path === `/internal/v1/missions/${MISSION}/execution`)
          return { status: 200, body: structuredClone(execution) }
        const observedAt = NOW.toISOString()
        if (input.path === `/internal/v1/a1-dispatch-authorizations/${MISSION}`) {
          const item = bundle.validated.dispatchAuthorization
          return { status: 200, body: {
            authorizationId: bundle.identifiers.dispatchAuthorizationId,
            missionId: MISSION,
            traceId: req.trace_id,
            planVersion: req.plan_version,
            decision: item.decision,
            rationale: item.rationale,
            reviewerId: item.reviewerId,
            reviewerEmail: item.reviewerEmail,
            reviewedAt: item.reviewedAt,
            expiresAt: item.expiresAt,
            missionSha256: item.expectedMissionSha256,
            assignmentPlanSha256: req.assignment_plan_sha256,
            userAuthorizationSha256: item.userAuthorizationSha256,
            attestations: item.attestations,
            idempotencyKey: item.idempotencyKey,
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
            provenance: { source: 'control-broker', sourceId: `a1-dispatch-authorization:${bundle.identifiers.dispatchAuthorizationId}`, observedAt, synthetic: false },
          } }
        }
        if (input.path === `/internal/v1/a1-assignment-enqueue-authorizations/${MISSION}`) {
          const item = bundle.validated.enqueueAuthorization
          return { status: 200, body: {
            authorizationId: bundle.identifiers.enqueueAuthorizationId,
            missionId: MISSION,
            traceId: req.trace_id,
            planVersion: req.plan_version,
            dispatchAuthorizationId: bundle.identifiers.dispatchAuthorizationId,
            decision: item.decision,
            rationale: item.rationale,
            reviewerId: item.reviewerId,
            reviewerEmail: item.reviewerEmail,
            reviewedAt: item.reviewedAt,
            expiresAt: item.expiresAt,
            missionSha256: item.expectedMissionSha256,
            assignmentPlanSha256: item.expectedAssignmentPlanSha256,
            userAuthorizationSha256: item.userAuthorizationSha256,
            attestations: item.attestations,
            idempotencyKey: item.idempotencyKey,
            enqueueAuthorizationRecorded: true,
            assignmentEnqueuePermitted: true,
            assignmentsEnqueued: false,
            executionAuthorized: false,
            dispatchClaimingPermitted: false,
            internetAccessAllowed: false,
            providerCreditSpendAllowed: false,
            contactPermitted: false,
            crmWriteAllowed: false,
            maximumExternalActions: 0,
            globalKillSwitchRequired: true,
            productionGate: 'blocked',
            nextRequiredGate: 'enqueue_exact_assignment_plan_separately',
            provenance: { source: 'control-broker', sourceId: `a1-assignment-enqueue-authorization:${bundle.identifiers.enqueueAuthorizationId}`, observedAt, synthetic: false },
          } }
        }
        if (input.path === `/internal/v1/a1-assignment-execution-authorizations/${MISSION}`) {
          const item = bundle.validated.executionAuthorization
          return { status: 200, body: {
            authorizationId: bundle.identifiers.executionAuthorizationId,
            missionId: MISSION,
            traceId: req.trace_id,
            planVersion: req.plan_version,
            enqueueAuthorizationId: bundle.identifiers.enqueueAuthorizationId,
            decision: item.decision,
            rationale: item.rationale,
            reviewerId: item.reviewerId,
            reviewerEmail: item.reviewerEmail,
            reviewedAt: item.reviewedAt,
            expiresAt: item.expiresAt,
            missionSha256: item.expectedMissionSha256,
            assignmentPlanSha256: item.expectedAssignmentPlanSha256,
            jobSetSha256: item.expectedJobSetSha256,
            assignmentIds: [...req.assignment_ids],
            maximumProviderCreditSpendUsd: item.maximumProviderCreditSpendUsd,
            userAuthorizationSha256: item.userAuthorizationSha256,
            attestations: item.attestations,
            idempotencyKey: item.idempotencyKey,
            executionAuthorizationRecorded: true,
            dispatchExecutionEligible: true,
            executionArmCreated: false,
            dispatchClaimingPermitted: false,
            jobsClaimed: false,
            executionStarted: false,
            internetAccessAllowed: false,
            providerCreditSpendAllowed: false,
            contactPermitted: false,
            crmWriteAllowed: false,
            maximumExternalActions: 0,
            globalKillSwitchRequired: true,
            productionGate: 'blocked',
            nextRequiredGate: 'arm_single_mission_execution_separately',
            provenance: { source: 'control-broker', sourceId: `a1-assignment-execution-authorization:${bundle.identifiers.executionAuthorizationId}`, observedAt, synthetic: false },
          } }
        }
        if (input.path === `/internal/v1/a1-dispatch-execution-arms/${MISSION}`) {
          const item = bundle.validated.executionArm
          return { status: 200, body: {
            armId: bundle.identifiers.armId,
            authorizationId: bundle.identifiers.armAuthorizationId,
            missionId: MISSION,
            traceId: req.trace_id,
            planVersion: req.plan_version,
            executionAuthorizationId: bundle.identifiers.executionAuthorizationId,
            decision: item.decision,
            rationale: item.rationale,
            reviewerId: item.reviewerId,
            reviewerEmail: item.reviewerEmail,
            reviewedAt: item.reviewedAt,
            startsAt: item.startsAt,
            expiresAt: item.expiresAt,
            missionSha256: item.expectedMissionSha256,
            assignmentPlanSha256: item.expectedAssignmentPlanSha256,
            jobSetSha256: item.expectedJobSetSha256,
            assignmentIds: [...req.assignment_ids],
            workerId: item.workerId,
            maximumClaims: item.maximumClaims,
            maximumProviderCreditSpendUsd: item.maximumProviderCreditSpendUsd,
            userAuthorizationSha256: item.userAuthorizationSha256,
            attestations: item.attestations,
            idempotencyKey: item.idempotencyKey,
            armAuthorizationRecorded: true,
            executionArmCreated: true,
            claimsUsed: 0,
            executionWindowEnabled: false,
            dispatchClaimingPermitted: false,
            jobsClaimed: false,
            executionStarted: false,
            internetAccessAllowed: false,
            providerCreditSpendAllowed: false,
            contactPermitted: false,
            crmWriteAllowed: false,
            maximumExternalActions: 0,
            globalKillSwitchActive: true,
            externalChannelsBlocked: true,
            dispatcherTimerDisabled: true,
            productionGate: 'blocked',
            nextRequiredGate: 'open_single_mission_execution_window_separately',
            provenance: { source: 'control-broker', sourceId: `a1-dispatch-execution-arm:${bundle.identifiers.armId}`, observedAt, synthetic: false },
          } }
        }
        if (input.path === `/internal/v1/a1-dispatch-execution-windows/${MISSION}`) {
          const item = bundle.validated.executionWindow
          state.window = true
          return { status: 200, body: {
            windowAuthorizationId: bundle.identifiers.windowAuthorizationId,
            missionId: MISSION,
            decision: item.decision,
            rationale: item.rationale,
            reviewerId: item.reviewerId,
            reviewerEmail: item.reviewerEmail,
            reviewedAt: item.reviewedAt,
            opensAt: item.opensAt,
            expiresAt: item.expiresAt,
            expectedArmId: item.expectedArmId,
            expectedArmAuthorizationId: item.expectedArmAuthorizationId,
            expectedExecutionAuthorizationId: item.expectedExecutionAuthorizationId,
            expectedMissionSha256: item.expectedMissionSha256,
            expectedAssignmentPlanSha256: item.expectedAssignmentPlanSha256,
            expectedJobSetSha256: item.expectedJobSetSha256,
            workerId: item.workerId,
            maximumClaims: item.maximumClaims,
            maximumProviderCreditSpendUsd: item.maximumProviderCreditSpendUsd,
            userAuthorizationSha256: item.userAuthorizationSha256,
            attestations: item.attestations,
            idempotencyKey: item.idempotencyKey,
            executionWindowAuthorizationRecorded: true,
            executionWindowEnabled: true,
            dispatchClaimingPermitted: true,
            claimsUsed: 0,
            jobsClaimed: false,
            executionStarted: false,
            providerCreditSpendAllowed: true,
            contactPermitted: false,
            crmWriteAllowed: false,
            maximumExternalActions: 0,
            globalKillSwitchActive: false,
            externalChannelsBlocked: true,
            automaticRecontainmentArmed: true,
            productionGate: 'single_mission_internal_execution',
            nextRequiredGate: 'automatic_recontainment_after_terminal_or_expiry',
            provenance: { source: 'control-broker', sourceId: `a1-dispatch-execution-window:${bundle.identifiers.windowAuthorizationId}`, observedAt, synthetic: false },
          } }
        }
        throw new Error(`UNEXPECTED_APPLICATION_PATH:${input.path}`)
      },
    }
    const files = new Map([
      ['/run/a1-single-approval/request.json', Buffer.from(JSON.stringify(req))],
      ['/run/a1-single-approval/envelope.json', Buffer.from(JSON.stringify(envelope))],
      ['/run/a1-single-approval/authorization.txt', authorizationBytes],
      ['/run/a1-single-approval/timer.json', Buffer.from(JSON.stringify({
        schema_version: 1,
        type: 'a1_host_timer_attestation_v1',
        request_id: req.request_id,
        mission_id: req.mission_id,
        authorization_digest_sha256: req.authorization_digest_sha256,
        unit: 'proptimiza-commercial-automation.timer',
        source: 'systemctl-host-masked-probe',
        enabled_state: 'masked',
        active_state: 'inactive',
        generated_at: NOW.toISOString(),
        expires_at: req.expires_at,
        nonce: 'a3900000-0000-4390-8390-000000000099',
      }))],
    ])
    const database = {
      query: async (query: { text: string; values?: unknown[] }) => {
        if (query.text.includes('FROM pg_roles r WHERE r.rolname=current_user'))
          return row({
            current_user: 'proptimiza_a1_chain_runner_login',
            rolcanlogin: true,
            unsafe: false,
            memberships: ['commercial_a1_chain_runner'],
            unexpected_functions: [],
            missing_functions: [],
            unsafe_effective: false,
          })
        if (query.text.includes('get_a1_single_approval_chain_state'))
          return row({ value: {
            mission_id: MISSION,
            channel_kills: 7,
            external_actions_blocked: true,
            external_actions: 0,
            crm_writes: 0,
            crm_outbox: 0,
            global_kill: !state.window,
            execution_window_open: state.window,
            dispatch_claiming_permitted: state.window,
            active_or_uncertain_jobs: 0,
            parent_authorization_consumed: state.parent,
            completed_jobs: state.completed,
            usage_value_consumed_usd: state.usage,
          } })
        if (query.text.includes('consume_a1_single_approval_parent')) {
          state.parent = true
          return row({ value: { consumed: true } })
        }
        if (query.text.includes('recontain_a1_single_approval_chain')) {
          state.window = false
          return row({ value: { recontained: true } })
        }
        throw new Error('UNEXPECTED_DATABASE_QUERY')
      },
      end: async () => { state.ended += 1 },
    }
    const runtime: BrokerApplicationRuntime = {
      application: application as never,
      dispatcher: {
        runOnce: async () => {
          state.dispatchCalls += 1
          const next = execution.assignments[state.completed]
          assert.ok(next)
          next.status = 'succeeded'
          next.attempts = 1
          next.artifact_sha256 = String(state.completed + 1).repeat(64)
          next.result_envelope = { status: 'completed' }
          state.completed += 1
          state.usage = state.completed / 100
          execution.status = state.completed === 6 ? 'completed' : 'running'
          return true
        },
      },
      bearers: {
        shadowReview: async () => 'capability-shadow-review-0123456789',
        controlPlane: async () => 'capability-control-plane-0123456789',
        internal: async () => 'capability-internal-0123456789',
      },
      close: async () => { state.runtimeClosed += 1 },
    }
    const result = await runA1SingleApprovalOneShot(environment(), {
      readSealed: async (path) => {
        if (path.endsWith('/timer.json')) state.timerReads += 1
        const value = files.get(path)
        if (!value) throw new Error('MISSING_TEST_FILE')
        return value
      },
      readDatabaseUrl: async () => 'postgresql://sealed-capability@runtime/control',
      createDatabase: () => database as never,
      createRuntime: async () => runtime,
      now: () => NOW,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.completed_jobs, 6)
    assert.equal(result.dispatch_ticks, 6)
    assert.equal(result.external_actions, 0)
    assert.equal(result.crm_writes, 0)
    assert.equal(result.recontained, true)
    assert.equal(state.dispatchCalls, 6)
    assert.equal(state.window, false)
    assert.equal(state.timerReads >= 15, true)
    assert.equal(state.ended, 1)
    assert.equal(state.runtimeClosed, 1)
    assert.deepEqual(requests.slice(0, 6).map((item) => item.path), [
      `/internal/v1/a1-dispatch-authorizations/${MISSION}`,
      `/internal/v1/a1-assignment-enqueue-authorizations/${MISSION}`,
      `/v1/missions/${MISSION}/assignments`,
      `/internal/v1/a1-assignment-execution-authorizations/${MISSION}`,
      `/internal/v1/a1-dispatch-execution-arms/${MISSION}`,
      `/internal/v1/a1-dispatch-execution-windows/${MISSION}`,
    ])
    assert.equal(requests.slice(6).length, 13)
    assert.equal(requests.slice(6).every((item) =>
      item.path === `/internal/v1/missions/${MISSION}/execution`), true)
  })
})

function row(value: Record<string, unknown>) {
  return { rowCount: 1, rows: [value], command: 'SELECT', oid: 0, fields: [] }
}

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
