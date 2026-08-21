import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OPENCODE_GO_PRICING_SNAPSHOT,
  assertOpenCodeGoExecutionPreflight,
  priceOpenCodeGoUsage,
} from '../src/opencode-go-pricing.js'
import type { TrustedUsage } from '../src/executor-contract.js'

function usage(overrides: Partial<TrustedUsage['tokens']> = {}): TrustedUsage {
  const tokens = {
    input: 1_000_000,
    output: 1_000_000,
    cache_read: 1_000_000,
    cache_write: 0,
    reasoning: 0,
    total: 3_000_000,
    ...overrides,
  }
  tokens.total =
    tokens.input + tokens.output + tokens.cache_read + tokens.cache_write
  return {
    tokens,
    api_calls: 1,
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
}

describe('versioned OpenCode Go pricing', () => {
  it('prices trusted token telemetry exactly in integer picodollars', () => {
    const priced = priceOpenCodeGoUsage(
      usage(),
      new Date('2026-08-16T12:00:00Z'),
    )

    assert.equal(OPENCODE_GO_PRICING_SNAPSHOT.id, 'opencode-go-2026-08-21-v2')
    assert.deepEqual(priced.cost, {
      status: 'known',
      usage_value_usd: 0.887,
      cash_cost_usd: 0,
      source: 'official_docs_snapshot',
      pricing_snapshot_id: 'opencode-go-2026-08-21-v2',
    })
  })

  it('fails closed when the official table has no cached-write price', () => {
    assert.throws(
      () =>
        priceOpenCodeGoUsage(
          usage({ cache_write: 1 }),
          new Date('2026-08-16T12:00:00Z'),
        ),
      /OPENCODE_GO_CACHE_WRITE_PRICE_UNKNOWN/,
    )
  })

  it('requires revalidation after the dated pricing and privacy snapshot', () => {
    assert.throws(
      () => priceOpenCodeGoUsage(usage(), new Date('2026-09-01T00:00:00Z')),
      /OPENCODE_GO_SNAPSHOT_REVALIDATION_REQUIRED/,
    )
  })

  it('reserves against peak output pricing while retaining post-run cache-write protection', () => {
    assert.doesNotThrow(() =>
      assertOpenCodeGoExecutionPreflight(
        {
          maximum_tokens: 24_576,
          budget_reservation: { currency: 'USD', amount: 0.032441 },
        },
        new Date('2026-08-21T12:00:00Z'),
      ),
    )
    assert.throws(
      () =>
        assertOpenCodeGoExecutionPreflight(
          {
            maximum_tokens: 24_576,
            budget_reservation: { currency: 'USD', amount: 0.03244 },
          },
          new Date('2026-08-16T12:00:00Z'),
        ),
      /OPENCODE_GO_RESERVATION_TOO_LOW/,
    )
  })

  it('uses the published peak window in UTC', () => {
    const priced = priceOpenCodeGoUsage(usage(), new Date('2026-08-21T07:00:00Z'))
    assert.equal(priced.cost.usage_value_usd, 1.774)
  })
})
