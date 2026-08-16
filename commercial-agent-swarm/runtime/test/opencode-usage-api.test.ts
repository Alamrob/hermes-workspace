import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_MISSION_COST_MICRO_CENTS,
  MAX_RUN_COST_MICRO_CENTS,
  MAX_TOTAL_COST_MICRO_CENTS,
  OpenCodeUsageClient,
  assertOpenCodeBudgetAvailable,
  reconcileOpenCodeRunUsage,
} from '../src/opencode-usage-api.js'
import type { TrustedUsage } from '../src/executor-contract.js'

const localUsage: TrustedUsage = {
  tokens: {
    input: 100,
    output: 50,
    cache_read: 5,
    cache_write: 0,
    reasoning: 0,
    total: 155,
  },
  api_calls: 2,
  model: 'deepseek-v4-flash',
  provider: 'custom:deepseek-v4-flash',
  completed: true,
  failed: false,
  cost: {
    status: 'unknown',
    usage_value_usd: null,
    cash_cost_usd: null,
    source: 'none',
    pricing_snapshot_id: null,
  },
}

const remoteUsage = {
  run_id: 'run-12345678',
  model: 'deepseek-v4-flash',
  base_url: 'https://opencode.ai/zen/go/v1',
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 5,
  cache_write_tokens: 0,
  api_calls: 2,
  cost_micro_cents: 1_234_567,
}

describe('read-only OpenCode Usage API gate', () => {
  it('uses only the fixed Go endpoint and a read-only port', async () => {
    const requests: unknown[] = []
    const client = new OpenCodeUsageClient({
      readToken: async () => 'read-only-token',
      reader: {
        getRunUsage: async (request) => {
          requests.push(request)
          return remoteUsage
        },
      },
    })
    assert.deepEqual(await client.getRunUsage('run-12345678'), remoteUsage)
    assert.deepEqual(requests, [
      {
        baseUrl: 'https://opencode.ai/zen/go/v1',
        runId: 'run-12345678',
        bearerToken: 'read-only-token',
      },
    ])
  })

  it('reconciles exact token telemetry and authoritative cost_micro_cents', () => {
    assert.deepEqual(
      reconcileOpenCodeRunUsage({
        runId: 'run-12345678',
        localUsage,
        remoteUsage,
        missionCommittedMicroCents: 10_000_000,
        totalCommittedMicroCents: 20_000_000,
      }),
      {
        runCostMicroCents: 1_234_567,
        missionCostMicroCents: 11_234_567,
        totalCostMicroCents: 21_234_567,
      },
    )
  })

  it('fails closed on missing usage, identity mismatch, or telemetry mismatch', () => {
    for (const changed of [
      null,
      { ...remoteUsage, model: 'other-model' },
      { ...remoteUsage, output_tokens: 49 },
      { ...remoteUsage, api_calls: 7 },
      { ...remoteUsage, cost_micro_cents: undefined },
    ])
      assert.throws(
        () =>
          reconcileOpenCodeRunUsage({
            runId: 'run-12345678',
            localUsage,
            remoteUsage: changed,
            missionCommittedMicroCents: 0,
            totalCommittedMicroCents: 0,
          }),
        /OPENCODE_USAGE_RECONCILIATION_FAILED/,
      )
  })

  it('enforces exact 0.10/run, 0.50/mission, and 10.00 total ceilings', () => {
    assert.equal(MAX_RUN_COST_MICRO_CENTS, 10_000_000)
    assert.equal(MAX_MISSION_COST_MICRO_CENTS, 50_000_000)
    assert.equal(MAX_TOTAL_COST_MICRO_CENTS, 1_000_000_000)
    assert.doesNotThrow(() =>
      assertOpenCodeBudgetAvailable({
        missionCommittedMicroCents: 40_000_000,
        totalCommittedMicroCents: 990_000_000,
      }),
    )
    for (const budget of [
      {
        missionCommittedMicroCents: 40_000_001,
        totalCommittedMicroCents: 0,
      },
      {
        missionCommittedMicroCents: 0,
        totalCommittedMicroCents: 990_000_001,
      },
    ])
      assert.throws(
        () => assertOpenCodeBudgetAvailable(budget),
        /OPENCODE_BUDGET_EXCEEDED/,
      )
    assert.throws(
      () =>
        reconcileOpenCodeRunUsage({
          runId: 'run-12345678',
          localUsage,
          remoteUsage: {
            ...remoteUsage,
            cost_micro_cents: 10_000_001,
          },
          missionCommittedMicroCents: 0,
          totalCommittedMicroCents: 0,
        }),
      /OPENCODE_BUDGET_EXCEEDED/,
    )
  })
})
