import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DeterministicDispatcher, type ClaimedJob } from '../src/dispatch-queue.js'
import type { ExecutorEnvelope } from '../src/hermes-executor.js'

const claimed: ClaimedJob = {
  job_id: 'job-1', mission_id: 'mission-1', profile_id: 'market-account-intelligence',
  prompt: 'external text', attempts: 1, max_attempts: 3
}

class FakeQueue {
  completed: unknown[][] = []
  failed: unknown[][] = []
  async recover() {}
  async claim() { return claimed }
  async complete(...args: unknown[]) { this.completed.push(args) }
  async fail(...args: unknown[]) { this.failed.push(args) }
}

function envelope(status: 'completed'|'failed'): ExecutorEnvelope {
  return { schema_version: '1.0', mission_id: claimed.mission_id, assignment_id: claimed.job_id,
    profile_id: claimed.profile_id, status,
    result: status === 'completed' ? { artifact_id: 'artifact-1', content: 'safe' } : null,
    evidence: [], token_cost: { input_tokens: 1, output_tokens: 2, currency: 'USD', amount: 0.01 },
    error: status === 'failed' ? 'MODEL_REFUSAL' : null }
}

describe('deterministic dispatcher', () => {
  it('allows only one in-process executor assignment at a time', async () => {
    const queue = new FakeQueue()
    let release!: () => void
    let calls = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const executor = { execute: async () => { if (++calls === 1) await gate;return envelope('completed') } }
    const dispatcher = new DeterministicDispatcher({ queue: queue as never, executor: executor as never,
      workerId: 'worker-1', now: () => new Date('2026-08-16T08:00:00Z'), leaseSeconds: 60 })
    const first = dispatcher.runOnce()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(await dispatcher.runOnce(), false)
    release()
    assert.equal(await first, true)
    assert.equal(calls, 1)
  })

  it('hashes and completes only the validated executor artifact', async () => {
    const queue = new FakeQueue()
    const executor = { execute: async () => envelope('completed') }
    const dispatcher = new DeterministicDispatcher({ queue: queue as never, executor: executor as never,
      workerId: 'worker-1', now: () => new Date('2026-08-16T08:00:00Z'), leaseSeconds: 60 })
    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(queue.failed.length, 0)
    assert.equal(queue.completed.length, 1)
    assert.match(String(queue.completed[0]![3]), /^[0-9a-f]{64}$/)
  })

  it('does not persist an executor-reported failure as a completed artifact', async () => {
    const queue = new FakeQueue()
    const executor = { execute: async () => envelope('failed') }
    const dispatcher = new DeterministicDispatcher({ queue: queue as never, executor: executor as never,
      workerId: 'worker-1', now: () => new Date('2026-08-16T08:00:00Z'), leaseSeconds: 60 })
    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(queue.completed.length, 0)
    assert.equal(queue.failed.length, 1)
    assert.equal(queue.failed[0]![2], 'MODEL_REFUSAL')
    assert.equal(queue.failed[0]![3], false)
  })

  it('classifies executor timeouts as recoverable for bounded retry', async () => {
    const queue = new FakeQueue()
    const executor = { execute: async () => { throw new Error('HERMES_TIMEOUT') } }
    const dispatcher = new DeterministicDispatcher({ queue: queue as never, executor: executor as never,
      workerId: 'worker-1', now: () => new Date('2026-08-16T08:00:00Z'), leaseSeconds: 60 })
    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(queue.completed.length, 0)
    assert.equal(queue.failed[0]![3], true)
  })
})
