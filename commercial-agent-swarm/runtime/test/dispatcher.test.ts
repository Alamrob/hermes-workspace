import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DeterministicDispatcher } from '../src/dispatch-queue.js'
import {
  ExecutorTransportError,
  UnixExecutorClient,
} from '../src/unix-executor-client.js'
import { UnixExecutorServer } from '../src/unix-executor-server.js'
import { ExecutorExecutionError } from '../src/hermes-executor.js'
import type { ClaimedJob } from '../src/dispatch-queue.js'
import type { ExecutorEnvelope } from '../src/hermes-executor.js'

const claimed: ClaimedJob = {
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
    missionCommittedBeforeMicroCents: 0,
    totalCommittedBeforeMicroCents: 0,
    version: 1,
  },
  attempts: 1,
  max_attempts: 3,
}

class FakeQueue {
  completed: Array<Array<unknown>> = []
  failed: Array<Array<unknown>> = []
  async recover() {}
  async claim() {
    return claimed
  }
  async complete(...args: Array<unknown>) {
    this.completed.push(args)
  }
  async fail(...args: Array<unknown>) {
    this.failed.push(args)
  }
}

function envelope(status: 'completed' | 'failed'): ExecutorEnvelope {
  return {
    schema_version: '1.0',
    agent_result: {
      mission_id: claimed.mission_id,
      trace_id: claimed.trace_id,
      assignment_id: claimed.job_id,
      agent_id: claimed.profile_id,
      status,
      summary: 'safe',
      facts: [],
      inferences: [],
      actions_taken: [],
      external_changes: [],
      evidence: [],
      artifacts: [],
      metrics: {
        provider_usage_value_usd: 0.01,
        cash_cost_usd: 0,
        pricing_snapshot_id: 'opencode-go-2026-08-21-v2',
        pricing_source: 'official_docs_snapshot',
      },
      cost: {
        currency: 'USD',
        llm: 0,
        tools: 0,
        total: 0,
        input_tokens: 1,
        output_tokens: 2,
      },
      errors:
        status === 'failed'
          ? [
              {
                code: 'MODEL_REFUSAL',
                message: 'refused',
                recoverable: false,
                attempts: 1,
              },
            ]
          : [],
      risks: [],
      pending_approvals: [],
      recommended_next_actions: [],
      started_at: '2026-08-16T08:00:00Z',
      finished_at: '2026-08-16T08:00:01Z',
    },
    usage: {
      tokens: {
        input: 1,
        output: 2,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        total: 3,
      },
      api_calls: 1,
      model: 'deepseek-v4-flash',
      provider: 'custom:deepseek-v4-flash',
      completed: true,
      failed: false,
      cost: {
        status: 'known',
        usage_value_usd: 0.01,
        cash_cost_usd: 0,
        source: 'official_docs_snapshot',
        pricing_snapshot_id: 'opencode-go-2026-08-21-v2',
      },
    },
  }
}

const usageGate = {
  serviceAccountId: 'service-account-proptimiza',
  usageProbe: {
    measure: async (input: any) => ({
      usage: await input.probe(),
      usageRecordId: 'usage-test-record',
      runUsageValueMicroCents: 1_000_000,
      missionUsageValueMicroCents: 1_000_000,
      totalUsageValueMicroCents: 1_000_000,
      incrementalCashCostMicroCents: 0 as const,
    }),
  },
}

describe('deterministic dispatcher', () => {
  it('allows only one in-process executor assignment at a time', async () => {
    const queue = new FakeQueue()
    let release!: () => void
    let calls = 0
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const executor = {
      execute: async () => {
        if (++calls === 1) await gate
        return envelope('completed')
      },
    }
    const dispatcher = new DeterministicDispatcher({
      queue: queue as never,
      executor: executor as never,
      workerId: 'worker-1',
      leaseSeconds: 60,
      childTimeoutSeconds: 30,
      hermesTimeoutMs: 30_000,
      ...usageGate,
    })
    const first = dispatcher.runOnce()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await dispatcher.runOnce(), false)
    release()
    assert.equal(await first, true)
    assert.equal(calls, 1)
  })

  it('hashes and completes only the validated executor artifact', async () => {
    const queue = new FakeQueue()
    const executor = { execute: async () => envelope('completed') }
    const dispatcher = new DeterministicDispatcher({
      queue: queue as never,
      executor: executor as never,
      workerId: 'worker-1',
      leaseSeconds: 60,
      childTimeoutSeconds: 30,
      hermesTimeoutMs: 30_000,
      ...usageGate,
    })
    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(queue.failed.length, 0)
    assert.equal(queue.completed.length, 1)
    assert.match(String(queue.completed[0][3]), /^[0-9a-f]{64}$/)
  })

  it('persists a validated executor-reported failure so its trusted usage is accounted', async () => {
    const queue = new FakeQueue()
    const executor = { execute: async () => envelope('failed') }
    const dispatcher = new DeterministicDispatcher({
      queue: queue as never,
      executor: executor as never,
      workerId: 'worker-1',
      leaseSeconds: 60,
      childTimeoutSeconds: 30,
      hermesTimeoutMs: 30_000,
      ...usageGate,
    })
    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(queue.completed.length, 1)
    assert.equal(queue.failed.length, 0)
    assert.equal(
      (queue.completed[0][2] as ExecutorEnvelope).agent_result.status,
      'failed',
    )
  })

  it('classifies executor timeouts as terminal usage-unknown even after cleanup', async () => {
    const queue = new FakeQueue()
    const executor = {
      execute: async () => {
        throw new Error('HERMES_TIMEOUT')
      },
    }
    const dispatcher = new DeterministicDispatcher({
      queue: queue as never,
      executor: executor as never,
      workerId: 'worker-1',
      leaseSeconds: 60,
      childTimeoutSeconds: 30,
      hermesTimeoutMs: 30_000,
      ...usageGate,
    })
    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(queue.completed.length, 0)
    assert.equal(queue.failed[0][3], false)
    assert.equal(queue.failed[0][4], 'usage_unknown')
  })

  it('releases a reservation only when execution is proven not to have started', async () => {
    const queue = new FakeQueue()
    const executor = {
      execute: async () => {
        throw new Error('OPENCODE_GO_RESERVATION_TOO_LOW')
      },
    }
    const dispatcher = new DeterministicDispatcher({
      queue: queue as never,
      executor: executor as never,
      workerId: 'worker-1',
      leaseSeconds: 60,
      childTimeoutSeconds: 30,
      hermesTimeoutMs: 30_000,
      ...usageGate,
    })
    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(queue.failed[0][4], 'not_started')
  })

  it('refunds a pre-spawn failure after it crosses the real Unix executor protocol', async () => {
    const queue = new FakeQueue()
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\dispatcher-refund-${randomUUID()}`
        : join(tmpdir(), `dispatcher-refund-${randomUUID()}.sock`)
    const server = new UnixExecutorServer({
      socketPath,
      executor: {
        execute: async () => {
          throw new ExecutorExecutionError(
            'OPENCODE_GO_CACHE_WRITE_PRICE_UNKNOWN',
            'not_started',
          )
        },
      },
      frameTimeoutMs: 500,
    })
    await server.start()
    try {
      const dispatcher = new DeterministicDispatcher({
        queue: queue as never,
        executor: new UnixExecutorClient({ socketPath, timeoutMs: 1_000 }),
        workerId: 'worker-1',
        leaseSeconds: 60,
        childTimeoutSeconds: 30,
        hermesTimeoutMs: 30_000,
        ...usageGate,
      })
      assert.equal(await dispatcher.runOnce(), true)
      assert.equal(queue.failed[0][2], 'OPENCODE_GO_CACHE_WRITE_PRICE_UNKNOWN')
      assert.equal(queue.failed[0][4], 'not_started')
    } finally {
      await server.stop()
    }
  })

  it('leaves the lease untouched when IPC outcome is uncertain', async () => {
    const queue = new FakeQueue()
    const executor = {
      execute: async () => {
        throw new ExecutorTransportError(
          'EXECUTOR_IPC_TIMEOUT',
          true,
          'unknown',
        )
      },
    }
    const dispatcher = new DeterministicDispatcher({
      queue: queue as never,
      executor: executor as never,
      workerId: 'worker-1',
      leaseSeconds: 60,
      childTimeoutSeconds: 30,
      hermesTimeoutMs: 30_000,
      ...usageGate,
    })
    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(queue.completed.length, 0)
    assert.equal(queue.failed.length, 0)
  })
})
