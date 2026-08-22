import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_MISSION_USAGE_VALUE_MICRO_CENTS,
  MAX_RUN_USAGE_VALUE_MICRO_CENTS,
  MAX_TOTAL_USAGE_VALUE_MICRO_CENTS,
  OpenCodeUsageExportClient,
  FetchOpenCodeUsageExportReader,
  OpenCodeUsageProbe,
  OpenCodeUsageProbeError,
  parseOpenCodeUsageCsv,
} from '../src/opencode-usage-api.js'
import type { TrustedUsage } from '../src/executor-contract.js'

const HEADER =
  'id,user_email,service_account_name,app,provider,model,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,reasoning_mode,reasoning_effort,reasoning_budget_tokens,reasoning_source,billing_source,cost_micro_cents,created_at'
const BASELINE = `${HEADER}\nusage-1,,svc-proptimiza,hermes,opencode,deepseek-v4-flash,10,5,0,1,0,0,disabled,none,0,none,go,100000,2026-08-16T11:59:00.000Z\n`
const AFTER = `${BASELINE}usage-2,,svc-proptimiza,hermes,opencode,deepseek-v4-flash,100,50,0,5,0,0,disabled,none,0,none,go,1234567,2026-08-16T12:00:01.000Z\n`

const localUsage: TrustedUsage = {
  tokens: {
    input: 100,
    output: 50,
    reasoning: 0,
    cache_read: 5,
    cache_write: 0,
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

describe('read-only OpenCode Usage Export gate', () => {
  it('streams and cancels an oversized chunked Usage export body', async () => {
    let cancelled = false
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    const chunk = new Uint8Array(600_000)
    const reader = new FetchOpenCodeUsageExportReader({
      fetch: async (url, init) => {
        requestedUrl = String(url)
        requestedInit = init
        return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk)
          controller.enqueue(chunk)
        },
        cancel() { cancelled = true },
        }), { status: 200, headers: { 'content-type': 'text/csv' } })
      },
    })
    await assert.rejects(
      reader.getCsvExport({
        url: 'https://console.opencode.ai/api/v1/usage/export',
        bearerToken: 'token', scope: 'service_account', range: '24h',
        serviceAccountId: 'svc-12345678',
      }),
      /OPENCODE_USAGE_CSV_TOO_LARGE/,
    )
    assert.equal(cancelled, true)
    const url = new URL(requestedUrl)
    assert.equal(url.origin + url.pathname, 'https://console.opencode.ai/api/v1/usage/export')
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      scope: 'service_account', range: '24h', service_account_id: 'svc-12345678',
    })
    assert.equal(requestedInit?.redirect, 'error')
  })

  it('uses only the official CSV export endpoint with an explicit service-account scope/range', async () => {
    const requests: unknown[] = []
    const client = new OpenCodeUsageExportClient({
      readToken: async () => 'read-only-token',
      reader: {
        getCsvExport: async (request) => {
          requests.push(request)
          return BASELINE
        },
      },
    })
    assert.equal(
      (await client.export({
        scope: 'service_account',
        range: '24h',
        serviceAccountId: 'svc-12345678',
      })).length,
      1,
    )
    assert.deepEqual(requests, [
      {
        url: 'https://console.opencode.ai/api/v1/usage/export',
        bearerToken: 'read-only-token',
        scope: 'service_account',
        range: '24h',
        serviceAccountId: 'svc-12345678',
      },
    ])
  })

  it('parses the closed bounded CSV and rejects headers, formulas, or oversized input', () => {
    assert.equal(parseOpenCodeUsageCsv(AFTER).length, 2)
    assert.deepEqual(parseOpenCodeUsageCsv(AFTER)[1], {
      id: 'usage-2',
      userEmail: '',
      serviceAccountName: 'svc-proptimiza',
      app: 'hermes',
      provider: 'opencode',
      model: 'deepseek-v4-flash',
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      cacheReadTokens: 5,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningEffort: 'none',
      reasoningMode: 'disabled',
      reasoningBudgetTokens: 0,
      reasoningSource: 'none',
      billingSource: 'go',
      usageValueMicroCents: 1_234_567,
      createdAt: '2026-08-16T12:00:01.000Z',
    })
    assert.throws(
      () => parseOpenCodeUsageCsv(AFTER.replace('id,user_email', 'run_id,user_email')),
      /OPENCODE_USAGE_CSV_INVALID/,
    )
    assert.throws(
      () => parseOpenCodeUsageCsv(AFTER.replace('svc-proptimiza', '=IMPORTXML(1)')),
      /OPENCODE_USAGE_CSV_UNSAFE_CELL/,
    )
    assert.throws(
      () => parseOpenCodeUsageCsv('x'.repeat(1_048_577)),
      /OPENCODE_USAGE_CSV_TOO_LARGE/,
    )
  })

  it('serializes baseline→probe→export and reconciles exactly one new row', async () => {
    let exports = 0
    let probes = 0
    const phases: string[] = []
    const gate = new OpenCodeUsageProbe({
      now: () => new Date('2026-08-16T12:05:00.000Z'),
      client: new OpenCodeUsageExportClient({
        readToken: async () => 'read-only-token',
        reader: {
          getCsvExport: async () => (++exports === 1 ? BASELINE : AFTER),
        },
      }),
    })
    const result = await gate.measure({
      serviceAccountId: 'svc-12345678',
      missionCommittedUsageValueMicroCents: 10_000_000,
      totalCommittedUsageValueMicroCents: 20_000_000,
      probe: async () => {
        probes += 1
        return localUsage
      },
      onPhase: (phase) => phases.push(phase),
    })
    assert.equal(probes, 1)
    assert.deepEqual(phases, [
      'usage_baseline_start',
      'usage_baseline_complete',
      'executor_start',
      'executor_complete',
      'usage_export_start',
      'usage_export_complete',
    ])
    assert.deepEqual(result, {
      usage: localUsage,
      usageRecordId: 'usage-2',
      runUsageValueMicroCents: 1_234_567,
      missionUsageValueMicroCents: 11_234_567,
      totalUsageValueMicroCents: 21_234_567,
      incrementalCashCostMicroCents: 0,
    })
  })

  it('distinguishes a failed baseline from a failure after provider execution', async () => {
    let probes = 0
    const baselineFailure = new OpenCodeUsageProbe({
      client: new OpenCodeUsageExportClient({
        readToken: async () => 'read-only-token',
        reader: {
          getCsvExport: async () => {
            throw new Error('OPENCODE_USAGE_EXPORT_FAILED')
          },
        },
      }),
    })
    await assert.rejects(
      baselineFailure.measure({
        serviceAccountId: 'svc-12345678',
        missionCommittedUsageValueMicroCents: 0,
        totalCommittedUsageValueMicroCents: 0,
        probe: async () => {
          probes += 1
          return localUsage
        },
      }),
      (error: unknown) =>
        error instanceof OpenCodeUsageProbeError &&
        error.executionState === 'not_started' &&
        error.message === 'OPENCODE_USAGE_EXPORT_FAILED',
    )
    assert.equal(probes, 0)

    let exports = 0
    const postFailure = new OpenCodeUsageProbe({
      client: new OpenCodeUsageExportClient({
        readToken: async () => 'read-only-token',
        reader: {
          getCsvExport: async () => {
            exports += 1
            if (exports === 1) return BASELINE
            throw new Error('OPENCODE_USAGE_EXPORT_FAILED')
          },
        },
      }),
    })
    await assert.rejects(
      postFailure.measure({
        serviceAccountId: 'svc-12345678',
        missionCommittedUsageValueMicroCents: 0,
        totalCommittedUsageValueMicroCents: 0,
        probe: async () => {
          probes += 1
          return localUsage
        },
      }),
      (error: unknown) =>
        error instanceof OpenCodeUsageProbeError &&
        error.executionState === 'usage_unknown',
    )
    assert.equal(probes, 1)
  })

  it('fails closed when the post-export diff has zero or multiple records', async () => {
    for (const after of [BASELINE, `${AFTER}usage-3,,svc-proptimiza,hermes,opencode,deepseek-v4-flash,100,50,0,5,0,0,disabled,none,0,none,go,1,2026-08-16T12:00:02.000Z\n`]) {
      let exports = 0
      const gate = new OpenCodeUsageProbe({
        now: () => new Date('2026-08-16T12:05:00.000Z'),
        client: new OpenCodeUsageExportClient({
          readToken: async () => 'read-only-token',
          reader: {
            getCsvExport: async () => (++exports === 1 ? BASELINE : after),
          },
        }),
      })
      await assert.rejects(
        gate.measure({
          serviceAccountId: 'svc-12345678',
          missionCommittedUsageValueMicroCents: 0,
          totalCommittedUsageValueMicroCents: 0,
          probe: async () => localUsage,
        }),
        /OPENCODE_USAGE_DIFF_AMBIGUOUS/,
      )
    }
  })

  it('fails closed outside the UTC-day 24h window or without dedicated service-account rows', async () => {
    for (const after of [
      AFTER.replace('2026-08-16T12:00:01.000Z', '2026-08-15T23:59:59.999Z'),
      AFTER.replace('usage-2,,svc-proptimiza', 'usage-2,user@example.com,'),
    ]) {
      let exports = 0
      const gate = new OpenCodeUsageProbe({
        now: () => new Date('2026-08-16T12:05:00.000Z'),
        client: new OpenCodeUsageExportClient({
          readToken: async () => 'read-only-token',
          reader: {
            getCsvExport: async () => (++exports === 1 ? BASELINE : after),
          },
        }),
      })
      await assert.rejects(
        gate.measure({
          serviceAccountId: 'svc-12345678',
          missionCommittedUsageValueMicroCents: 0,
          totalCommittedUsageValueMicroCents: 0,
          probe: async () => localUsage,
        }),
        /OPENCODE_USAGE_(?:WINDOW|SERVICE_ACCOUNT)_INVALID/,
      )
    }
  })

  it('enforces local 0.10/run, 0.50/mission, and 10.00 total usage-value ceilings', () => {
    assert.equal(MAX_RUN_USAGE_VALUE_MICRO_CENTS, 10_000_000)
    assert.equal(MAX_MISSION_USAGE_VALUE_MICRO_CENTS, 50_000_000)
    assert.equal(MAX_TOTAL_USAGE_VALUE_MICRO_CENTS, 1_000_000_000)
  })
})
