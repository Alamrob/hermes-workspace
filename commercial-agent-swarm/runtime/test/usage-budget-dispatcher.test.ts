import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DeterministicDispatcher } from '../src/dispatch-queue.js'
import type { ExecutorEnvelope } from '../src/hermes-executor.js'
import { OpenCodeUsageProbeError } from '../src/opencode-usage-api.js'

const claimed = {
  job_id: '323e4567-e89b-42d3-a456-426614174000',
  mission_id: '123e4567-e89b-42d3-a456-426614174000',
  trace_id: '223e4567-e89b-42d3-a456-426614174000',
  profile_id: 'market-account-intelligence',
  instruction: 'Analyze evidence.',
  evidence: { trust: 'untrusted_data', content: 'external text' },
  reservation: {
    maximum_tokens: 100,
    maximum_api_calls: 2,
    budget_reservation: { currency: 'USD', amount: 0.02 },
  },
  usageBudget: {
    reservationMicroCents: 10_000_000,
    missionCommittedBeforeMicroCents: 7_000_000,
    totalCommittedBeforeMicroCents: 23_000_000,
    version: 4,
  },
  attempts: 1,
  max_attempts: 3,
} as const

class Queue {
  completed: unknown[][] = []
  failed: unknown[][] = []
  async recover() {}
  async claim() { return claimed }
  async complete(...args: unknown[]) { this.completed.push(args) }
  async fail(...args: unknown[]) { this.failed.push(args) }
}

function envelope(): ExecutorEnvelope {
  return {
    schema_version: '1.0',
    agent_result: {
      mission_id: claimed.mission_id, trace_id: claimed.trace_id,
      assignment_id: claimed.job_id, agent_id: claimed.profile_id,
      status: 'completed', summary: 'safe', facts: [], inferences: [],
      actions_taken: [], external_changes: [], evidence: [], artifacts: [],
      metrics: {
        provider_usage_value_usd: 0.01, cash_cost_usd: 0,
        pricing_snapshot_id: 'opencode-go-2026-08-21-v2',
        pricing_source: 'official_docs_snapshot',
      },
      cost: { currency: 'USD', llm: 0, tools: 0, total: 0, input_tokens: 1, output_tokens: 2 },
      errors: [], risks: [], pending_approvals: [], recommended_next_actions: [],
      started_at: '2026-08-16T08:00:00Z', finished_at: '2026-08-16T08:00:01Z',
    },
    usage: {
      tokens: { input: 1, output: 2, cache_read: 0, cache_write: 0, reasoning: 0, total: 3 },
      api_calls: 1, model: 'deepseek-v4-flash', provider: 'opencode-go',
      completed: true, failed: false,
      cost: {
        status: 'known', usage_value_usd: 0.01, cash_cost_usd: 0,
        source: 'official_docs_snapshot', pricing_snapshot_id: 'opencode-go-2026-08-21-v2',
      },
    },
  }
}

describe('authoritative Usage budget dispatch wiring', () => {
  it('wraps the real executor in baseline/export reconciliation and settles the reserved CAS version', async () => {
    const queue = new Queue()
    const calls: string[] = []
    const observed: Array<{ phase: string; jobId: string; missionId: string; profileId: string }> = []
    const usageProbe = {
      measure: async (input: any) => {
        input.onPhase('usage_baseline_start')
        calls.push('baseline')
        input.onPhase('usage_baseline_complete')
        assert.equal(input.serviceAccountId, 'service-account-proptimiza')
        assert.equal(input.missionCommittedUsageValueMicroCents, 7_000_000)
        assert.equal(input.totalCommittedUsageValueMicroCents, 23_000_000)
        input.onPhase('executor_start')
        const usage = await input.probe()
        input.onPhase('executor_complete')
        input.onPhase('usage_export_start')
        calls.push('export')
        input.onPhase('usage_export_complete')
        return {
          usage, usageRecordId: 'usage-record-1', runUsageValueMicroCents: 3_000_000,
          missionUsageValueMicroCents: 10_000_000,
          totalUsageValueMicroCents: 26_000_000,
          incrementalCashCostMicroCents: 0,
        }
      },
    }
    const dispatcher = new DeterministicDispatcher({
      queue: queue as never,
      executor: { execute: async () => { calls.push('executor'); return envelope() } },
      usageProbe,
      serviceAccountId: 'service-account-proptimiza',
      workerId: 'worker-1', leaseSeconds: 60, childTimeoutSeconds: 30,
      hermesTimeoutMs: 30_000,
      onPhase: (event: typeof observed[number]) => observed.push(event),
    } as never)
    assert.equal(await dispatcher.runOnce(), true)
    assert.deepEqual(calls, ['baseline', 'executor', 'export'])
    assert.deepEqual(observed.map((event) => event.phase), [
      'claimed',
      'usage_baseline_start',
      'usage_baseline_complete',
      'executor_start',
      'executor_complete',
      'usage_export_start',
      'usage_export_complete',
      'completed',
    ])
    assert.ok(observed.every((event) =>
      event.jobId === claimed.job_id &&
      event.missionId === claimed.mission_id &&
      event.profileId === claimed.profile_id,
    ))
    assert.equal(queue.failed.length, 0)
    assert.deepEqual(queue.completed[0][4], {
      usageValueMicroCents: 3_000_000,
      usageRecordId: 'usage-record-1',
      budgetVersion: 4,
      total_tokens: 3,
      api_calls: 1,
    })
  })

  it('fails before executor invocation when reconciliation is disabled', async () => {
    const queue = new Queue()
    let executorCalls = 0
    const dispatcher = new DeterministicDispatcher({
      queue: queue as never,
      executor: { execute: async () => { executorCalls += 1; return envelope() } },
      workerId: 'worker-1', leaseSeconds: 60, childTimeoutSeconds: 30,
      hermesTimeoutMs: 30_000,
    })
    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(executorCalls, 0)
    assert.equal(queue.completed.length, 0)
    assert.equal(queue.failed[0][4], 'not_started')
  })

  it('releases the reservation when the authoritative baseline fails before executor invocation', async () => {
    const queue = new Queue()
    let executorCalls = 0
    const dispatcher = new DeterministicDispatcher({
      queue: queue as never,
      executor: {
        execute: async () => {
          executorCalls += 1
          return envelope()
        },
      },
      usageProbe: {
        measure: async () => {
          throw new OpenCodeUsageProbeError(
            'OPENCODE_USAGE_EXPORT_FAILED',
            'not_started',
          )
        },
      },
      serviceAccountId: 'service-account-proptimiza',
      workerId: 'worker-1', leaseSeconds: 60, childTimeoutSeconds: 30,
      hermesTimeoutMs: 30_000,
    } as never)
    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(executorCalls, 0)
    assert.equal(queue.completed.length, 0)
    assert.equal(queue.failed[0][2], 'OPENCODE_USAGE_EXPORT_FAILED')
    assert.equal(queue.failed[0][4], 'not_started')
  })

  it('holds the reservation as usage-unknown when the post-export diff is ambiguous', async () => {
    const queue = new Queue()
    const dispatcher = new DeterministicDispatcher({
      queue: queue as never,
      executor: { execute: async () => envelope() },
      usageProbe: {
        measure: async (input: any) => {
          await input.probe()
          throw new Error('OPENCODE_USAGE_DIFF_AMBIGUOUS')
        },
      },
      serviceAccountId: 'service-account-proptimiza',
      workerId: 'worker-1', leaseSeconds: 60, childTimeoutSeconds: 30,
      hermesTimeoutMs: 30_000,
    } as never)
    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(queue.completed.length, 0)
    assert.equal(queue.failed[0][4], 'usage_unknown')
  })
})
