import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  A0_BEHAVIOR_PROFILES,
  type A0BatchRunnerPort,
  type A0CompiledBatch,
  type A0SealedArtifactSnapshot,
} from '../src/a0-behavior-batch-admission.js'
import {
  A0_EXECUTOR_CREDENTIAL_HANDLE,
  A0_MANUAL_RUNNER_WORKER_ID,
  ProtectedA0BehaviorBatchRunner,
  type A0TaskResultObservation,
} from '../src/a0-behavior-manual-runner.js'
import type { ExecutionPermit } from '../src/execution-lease.js'
import type { ExecutorEnvelope, ExecutorPort } from '../src/hermes-executor.js'
import type { TrustedUsage } from '../src/executor-contract.js'

const RUN_ID = '123e4567-e89b-42d3-a456-426614174000'
const BUNDLE_SHA = 'b'.repeat(64)
const WINDOW_ID = '223e4567-e89b-42d3-a456-426614174000'
const EPOCH_ID = '323e4567-e89b-42d3-a456-426614174000'

function taskUuid(index: number): string {
  return `423e4567-e89b-42d3-a456-${String(index + 1).padStart(12, '0')}`
}

function fixtureUuid(index: number): string {
  return `523e4567-e89b-42d3-a456-${String(index + 1).padStart(12, '0')}`
}

function batch(): A0CompiledBatch {
  const body = {
    sequence: 1,
    batch_id: `a0:${RUN_ID}:t01`,
    source_plan_sha256: 'a'.repeat(64),
    test_case: 'T01',
    tasks: A0_BEHAVIOR_PROFILES.map((agent_id, index) => ({
      sequence: index + 1,
      task_id: taskUuid(index),
      fixture_id: fixtureUuid(index),
      fixture_path: `${agent_id}/T01.json`,
      fixture_sha256: String(index + 1).repeat(64).slice(0, 64),
      fixture_bytes: 20 + index,
      fixture_handle: `a0-sealed:fixture-${String(index + 1).padStart(2, '0')}-0000000000000000`,
      agent_id,
      test_case: 'T01',
      critical: false,
      expected_status: 'completed' as const,
      maximum_tokens: 4096 as const,
      maximum_model_calls: 1 as const,
      maximum_attempts: 1 as const,
      reservation_micro_cents: 1_000_000 as const,
    })),
    reservation_micro_cents: 6_000_000 as const,
  }
  return { ...body, batch_sha256: 'c'.repeat(64) }
}

function snapshot(profileBundleSha256 = BUNDLE_SHA): A0SealedArtifactSnapshot {
  return {
    schema_version: 1,
    type: 'commercial_swarm_a0_sealed_artifact_snapshot/v1',
    status: 'sealed',
    fixture_manifest_sha256: 'd'.repeat(64),
    profile_bundle_sha256: profileBundleSha256,
    fixture_artifacts: [],
    profile_artifacts: [],
    snapshot_handle: 'a0-sealed:snapshot-0000000000000000',
    snapshot_sha256: 'e'.repeat(64),
  }
}

function trustedUsage(): TrustedUsage {
  return {
    tokens: {
      input: 10,
      output: 20,
      cache_read: 0,
      cache_write: 0,
      reasoning: 0,
      total: 30,
    },
    api_calls: 1,
    model: 'deepseek-v4-flash',
    provider: 'opencode-go',
    completed: true,
    failed: false,
    cost: {
      status: 'known',
      usage_value_usd: 0.001,
      cash_cost_usd: null,
      source: 'provider_cost_api',
      pricing_snapshot_id: null,
    },
  }
}

function envelope(): ExecutorEnvelope {
  return {
    schema_version: '1.0',
    agent_result: { status: 'completed' } as ExecutorEnvelope['agent_result'],
    usage: trustedUsage(),
  }
}

function spawnInput(
  profileBundleSha256 = BUNDLE_SHA,
): Parameters<A0BatchRunnerPort['spawn']>[0] {
  return {
    run_id: RUN_ID,
    batch: batch(),
    reservation_version: 1,
    execution_contract: {
      autonomy_level: 'A0',
      provider_id: 'opencode-go',
      model_id: 'deepseek-v4-flash',
      maximum_tokens_per_task: 4096,
      maximum_model_calls_per_task: 1,
      maximum_attempts_per_task: 1,
      simulation_tool_policy: 'deny_all_runtime_tools',
      approved_tools: [],
      real_connectors_allowed: false,
      memory_enabled: false,
    },
    sealed_artifact_snapshot: snapshot(profileBundleSha256),
    credential: { opaque_handle: A0_EXECUTOR_CREDENTIAL_HANDLE },
  }
}

function permit(taskId: string): ExecutionPermit {
  return {
    allowed: true,
    job_id: taskId,
    mission_id: RUN_ID,
    worker_id: A0_MANUAL_RUNNER_WORKER_ID,
    window_id: WINDOW_ID,
    epoch_id: EPOCH_ID,
    budget_version: 1,
    valid_for_ms: 5_000,
  }
}

describe('protected A0 manual behavior runner', () => {
  it('executes exactly six sequential tool-free calls with six unique receipts', async () => {
    const events: string[] = []
    const observations: A0TaskResultObservation[] = []
    const executionInputs: Parameters<ExecutorPort['execute']>[0][] = []
    const permitInputs: Array<{ task_id: string; profile_id: string }> = []
    let usageIndex = 0
    let active = false
    const executor: ExecutorPort = {
      execute: async (input, context) => {
        assert.equal(active, true)
        executionInputs.push(structuredClone(input))
        events.push(`execute:${input.profile_id}`)
        const granted = await context?.readExecutionPermit?.()
        assert.equal(granted?.job_id, input.assignment_id)
        return envelope()
      },
    }
    const runner = new ProtectedA0BehaviorBatchRunner({
      executor,
      usageServiceAccountId: 'svcacct_a0_behavior',
      usageProbe: {
        measure: async (input) => {
          assert.equal(active, false)
          active = true
          assert.equal(input.maximumRunUsageValueMicroCents, 1_000_000)
          events.push(`usage-before:${usageIndex + 1}`)
          const usage = await input.probe()
          events.push(`usage-after:${usageIndex + 1}`)
          active = false
          usageIndex += 1
          return {
            usage,
            usageRecordId: `usage-${usageIndex}`,
            runUsageValueMicroCents: 100_000,
            missionUsageValueMicroCents: usageIndex * 100_000,
            totalUsageValueMicroCents: usageIndex * 100_000,
            incrementalCashCostMicroCents: 0,
          }
        },
      },
      executionAuthority: {
        readUsageBudgetState: async () => ({
          total_committed_excluding_batch_micro_cents: 0,
        }),
        readTaskExecutionPermit: async (input) => {
          permitInputs.push({ task_id: input.task_id, profile_id: input.profile_id })
          return permit(input.task_id)
        },
      },
      fixtureReader: {
        read: async (input) => {
          events.push(`fixture:${input.sealed_handle}`)
          return '{"synthetic":true}'
        },
      },
      executionTimeoutMs: 1_000,
      expectedProfileBundleSha256: BUNDLE_SHA,
      onTaskResult: (value) => observations.push(value),
    })

    const result = await runner.spawn(spawnInput())

    assert.equal(result.status, 'known')
    if (result.status !== 'known') return
    assert.equal(result.model_calls, 6)
    assert.equal(result.usage_records.length, 6)
    assert.equal(new Set(result.usage_records.map((row) => row.usage_record_id)).size, 6)
    assert.equal(result.usage_value_micro_cents, 600_000)
    assert.equal(executionInputs.length, 6)
    assert.equal(permitInputs.length, 6)
    assert.equal(observations.length, 6)
    assert.deepEqual(
      executionInputs.map((value) => value.profile_id),
      [...A0_BEHAVIOR_PROFILES],
    )
    for (const value of executionInputs) {
      assert.equal(value.provider_credential_handle, A0_EXECUTOR_CREDENTIAL_HANDLE)
      assert.deepEqual(value.execution_policy, {
        autonomy_level: 'A0',
        allowed_actions: ['analysis.internal'],
        approved_channels: ['internal'],
        approved_tools: [],
      })
      assert.equal(value.reservation.maximum_tokens, 4096)
      assert.equal(value.reservation.maximum_api_calls, 1)
    }
    assert.equal(events.filter((value) => value.startsWith('execute:')).length, 6)
    assert.equal(active, false)
  })

  it('rejects bundle drift before reading fixtures, leases, usage or executor', async () => {
    let calls = 0
    const runner = new ProtectedA0BehaviorBatchRunner({
      executor: { execute: async () => { calls += 1; return envelope() } },
      usageServiceAccountId: 'svcacct_a0_behavior',
      usageProbe: { measure: async () => { calls += 1; throw new Error('unexpected') } },
      executionAuthority: {
        readUsageBudgetState: async () => { calls += 1; return { total_committed_excluding_batch_micro_cents: 0 } },
        readTaskExecutionPermit: async (input) => { calls += 1; return permit(input.task_id) },
      },
      fixtureReader: { read: async () => { calls += 1; return '{}' } },
      executionTimeoutMs: 1_000,
      expectedProfileBundleSha256: BUNDLE_SHA,
    })

    assert.deepEqual(await runner.spawn(spawnInput('f'.repeat(64))), {
      status: 'unknown',
      reason: 'process_outcome_unknown',
    })
    assert.equal(calls, 0)
  })

  it('never retries a failed task lease or provider execution', async () => {
    let executorCalls = 0
    let permitCalls = 0
    let probeCalls = 0
    const runner = new ProtectedA0BehaviorBatchRunner({
      executor: {
        execute: async (_input, context) => {
          executorCalls += 1
          await context?.readExecutionPermit?.()
          return envelope()
        },
      },
      usageServiceAccountId: 'svcacct_a0_behavior',
      usageProbe: {
        measure: async (input) => {
          probeCalls += 1
          return {
            usage: await input.probe(),
            usageRecordId: 'usage-never-returned',
            runUsageValueMicroCents: 1,
            missionUsageValueMicroCents: 1,
            totalUsageValueMicroCents: 1,
            incrementalCashCostMicroCents: 0,
          }
        },
      },
      executionAuthority: {
        readUsageBudgetState: async () => ({ total_committed_excluding_batch_micro_cents: 0 }),
        readTaskExecutionPermit: async () => {
          permitCalls += 1
          throw new Error('lease denied')
        },
      },
      fixtureReader: { read: async () => '{}' },
      executionTimeoutMs: 1_000,
      expectedProfileBundleSha256: BUNDLE_SHA,
    })

    assert.deepEqual(await runner.spawn(spawnInput()), {
      status: 'unknown',
      reason: 'process_outcome_unknown',
    })
    assert.equal(executorCalls, 1)
    assert.equal(permitCalls, 1)
    assert.equal(probeCalls, 1)
  })

  it('contains a duplicate Usage receipt after six calls without a seventh call', async () => {
    let executorCalls = 0
    const runner = new ProtectedA0BehaviorBatchRunner({
      executor: { execute: async () => { executorCalls += 1; return envelope() } },
      usageServiceAccountId: 'svcacct_a0_behavior',
      usageProbe: {
        measure: async (input) => ({
          usage: await input.probe(),
          usageRecordId: 'duplicate-usage',
          runUsageValueMicroCents: 1,
          missionUsageValueMicroCents: 1,
          totalUsageValueMicroCents: 1,
          incrementalCashCostMicroCents: 0,
        }),
      },
      executionAuthority: {
        readUsageBudgetState: async () => ({ total_committed_excluding_batch_micro_cents: 0 }),
        readTaskExecutionPermit: async (input) => permit(input.task_id),
      },
      fixtureReader: { read: async () => '{}' },
      executionTimeoutMs: 1_000,
      expectedProfileBundleSha256: BUNDLE_SHA,
    })

    assert.deepEqual(await runner.spawn(spawnInput()), {
      status: 'unknown',
      reason: 'provider_usage_unknown',
    })
    assert.equal(executorCalls, 6)
  })

  it('rejects a Usage receipt ID that the PostgreSQL settlement boundary cannot store', async () => {
    let executorCalls = 0
    const runner = new ProtectedA0BehaviorBatchRunner({
      executor: {
        execute: async () => {
          executorCalls += 1
          return envelope()
        },
      },
      usageServiceAccountId: 'svcacct_a0_behavior',
      usageProbe: {
        measure: async (input) => ({
          usage: await input.probe(),
          usageRecordId: 'u'.repeat(201),
          runUsageValueMicroCents: 1,
          missionUsageValueMicroCents: 1,
          totalUsageValueMicroCents: 1,
          incrementalCashCostMicroCents: 0,
        }),
      },
      executionAuthority: {
        readUsageBudgetState: async () => ({
          total_committed_excluding_batch_micro_cents: 0,
        }),
        readTaskExecutionPermit: async (input) => permit(input.task_id),
      },
      fixtureReader: { read: async () => '{}' },
      executionTimeoutMs: 1_000,
      expectedProfileBundleSha256: BUNDLE_SHA,
    })

    assert.deepEqual(await runner.spawn(spawnInput()), {
      status: 'unknown',
      reason: 'provider_usage_unknown',
    })
    assert.equal(executorCalls, 1)
  })
})
