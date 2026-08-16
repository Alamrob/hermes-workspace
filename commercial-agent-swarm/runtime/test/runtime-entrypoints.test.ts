import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createBrokerDispatcher } from '../src/runtime-entrypoints.js'
import type {
  ClaimedJob,
  CompletionCost,
  DispatchQueuePort,
} from '../src/dispatch-queue.js'
import type { ExecutorEnvelope } from '../src/hermes-executor.js'

const HEADER =
  'id,user_email,service_account_name,app,provider,model,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,reasoning_effort,reasoning_mode,reasoning_budget_tokens,reasoning_source,billing_source,cost_micro_cents,created_at'

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
    budget_reservation: { currency: 'USD', amount: 0.1 },
  },
  usageBudget: {
    reservationMicroCents: 10_000_000,
    missionCommittedBeforeMicroCents: 0,
    totalCommittedBeforeMicroCents: 0,
    version: 7,
  },
  attempts: 1,
  max_attempts: 3,
}

class Queue implements DispatchQueuePort {
  completed: CompletionCost[] = []
  failed: Array<{ state: string; error: string }> = []
  async enqueue() { return claimed.job_id }
  async recover() {}
  async claim() { return claimed }
  async complete(
    _id: string,
    _worker: string,
    _envelope: unknown,
    _artifactHash: string,
    cost: CompletionCost,
  ) { this.completed.push(cost) }
  async fail(
    _id: string,
    _worker: string,
    error: string,
    _recoverable: boolean,
    state: 'not_started' | 'usage_unknown',
  ) { this.failed.push({ state, error }) }
}

function envelope(): ExecutorEnvelope {
  return {
    schema_version: '1.0',
    agent_result: {
      mission_id: claimed.mission_id,
      trace_id: claimed.trace_id,
      assignment_id: claimed.job_id,
      agent_id: claimed.profile_id,
      status: 'completed',
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
        pricing_snapshot_id: 'opencode-go-2026-08-16-v1',
        pricing_source: 'official_docs_snapshot',
      },
      cost: {
        currency: 'USD', llm: 0, tools: 0, total: 0,
        input_tokens: 1, output_tokens: 2,
      },
      errors: [],
      risks: [],
      pending_approvals: [],
      recommended_next_actions: [],
      started_at: '2026-08-16T08:00:00Z',
      finished_at: '2026-08-16T08:00:01Z',
    },
    usage: {
      tokens: {
        input: 1, output: 2, cache_read: 0, cache_write: 0,
        reasoning: 0, total: 3,
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
        pricing_snapshot_id: 'opencode-go-2026-08-16-v1',
      },
    },
  }
}

function environment(enabled: boolean): Record<string, string> {
  return {
    NODE_ENV: 'production',
    EXECUTOR_SOCKET_PATH: '/run/commercial-swarm/executor.sock',
    HERMES_TIMEOUT_MS: '30000',
    EXECUTOR_CLIENT_TIMEOUT_MS: '35000',
    DISPATCH_LEASE_SECONDS: '60',
    OPENCODE_USAGE_RECONCILIATION_ENABLED: String(enabled),
    OPENCODE_USAGE_SERVICE_ACCOUNT_ID: 'service-account-proptimiza',
    OPENCODE_USAGE_TOKEN_FILE: '/run/secrets/opencode-usage-token',
  }
}

describe('broker dispatcher factory', () => {
  it('passes the file-backed Usage factory into the actual dispatch flow', async () => {
    const queue = new Queue()
    const calls: string[] = []
    const today = new Date().toISOString()
    const baseline = `${HEADER}\nusage-old,,svc-proptimiza,hermes,opencode,deepseek-v4-flash,4,3,0,0,0,0,none,disabled,0,none,go,1000,${today}\n`
    const after = `${baseline}usage-new,,svc-proptimiza,hermes,opencode,deepseek-v4-flash,1,2,0,0,0,0,none,disabled,0,none,go,1000000,${today}\n`
    let exports = 0
    const dispatcher = createBrokerDispatcher(
      environment(true),
      {} as never,
      'broker-dispatcher-1',
      {
        queue,
        executor: {
          execute: async () => {
            calls.push('executor')
            return envelope()
          },
        },
        usage: {
          readToken: async (path, expectedGid) => {
            calls.push('token')
            assert.equal(path, '/run/secrets/opencode-usage-token')
            assert.equal(expectedGid, 10001)
            return 'dedicated-read-only-token'
          },
          reader: {
            getCsvExport: async () => {
              calls.push('export')
              return ++exports === 1 ? baseline : after
            },
          },
        },
      },
    )

    assert.equal(await dispatcher.runOnce(), true)
    assert.deepEqual(calls, ['token', 'export', 'executor', 'token', 'export'])
    assert.equal(queue.failed.length, 0)
    assert.deepEqual(queue.completed[0], {
      usageValueMicroCents: 1_000_000,
      usageRecordId: 'usage-new',
      budgetVersion: 7,
      total_tokens: 3,
      api_calls: 1,
    })
  })

  it('does not read the token, export Usage, or invoke the child while disabled', async () => {
    const queue = new Queue()
    let touched = false
    const dispatcher = createBrokerDispatcher(
      environment(false),
      {} as never,
      'broker-dispatcher-1',
      {
        queue,
        executor: {
          execute: async () => {
            touched = true
            return envelope()
          },
        },
        usage: {
          readToken: async () => { touched = true; return 'never' },
          reader: { getCsvExport: async () => { touched = true; return 'never' } },
        },
      },
    )

    assert.equal(await dispatcher.runOnce(), true)
    assert.equal(touched, false)
    assert.deepEqual(queue.failed, [{
      state: 'not_started',
      error: 'OPENCODE_USAGE_RECONCILIATION_REQUIRED',
    }])
  })
})
