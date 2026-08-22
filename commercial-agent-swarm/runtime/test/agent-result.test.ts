import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  AGENT_RESULT_TOP_LEVEL_KEYS,
  reconcileAgentResult,
} from '../src/agent-result.js'

const identity = {
  mission_id: '123e4567-e89b-42d3-a456-426614174000',
  trace_id: '223e4567-e89b-42d3-a456-426614174000',
  assignment_id: '323e4567-e89b-42d3-a456-426614174000',
  profile_id: 'market-account-intelligence' as const,
}
const usage = {
  tokens: {
    input: 10,
    output: 5,
    cache_read: 0,
    cache_write: 0,
    reasoning: 2,
    total: 15,
  },
  api_calls: 1,
  model: 'deepseek-v4-flash' as const,
  provider: 'opencode-go' as const,
  completed: true as const,
  failed: false as const,
  cost: {
    status: 'known' as const,
    usage_value_usd: 0.004,
    cash_cost_usd: 0 as const,
    source: 'official_docs_snapshot' as const,
    pricing_snapshot_id: 'opencode-go-2026-08-21-v2',
  },
}
const raw = {
  mission_id: identity.mission_id,
  trace_id: identity.trace_id,
  assignment_id: identity.assignment_id,
  agent_id: identity.profile_id,
  status: 'completed',
  summary: 'Safe result',
  facts: [],
  inferences: [],
  actions_taken: [],
  external_changes: [],
  evidence: [],
  artifacts: [],
  metrics: {},
  cost: {
    currency: 'CLP',
    llm: 999,
    tools: 999,
    total: 1998,
    input_tokens: 999,
    output_tokens: 999,
  },
  errors: [],
  risks: [],
  pending_approvals: [],
  recommended_next_actions: [],
  started_at: '1999-01-01T00:00:00Z',
  finished_at: '2099-01-01T00:00:00Z',
}

describe('canonical AgentResult reconciliation', () => {
  it('conforms its closed top-level contract and statuses to the canonical JSON Schema', async () => {
    const schema = JSON.parse(
      await readFile(
        new URL('../../contracts/agent-result.schema.json', import.meta.url),
        'utf8',
      ),
    )
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.required, AGENT_RESULT_TOP_LEVEL_KEYS)
    assert.deepEqual(schema.properties.status.enum, [
      'completed',
      'partial',
      'blocked',
      'failed',
      'approval_required',
    ])
    assert.deepEqual(schema.properties.cost.required, [
      'currency',
      'llm',
      'tools',
      'total',
      'input_tokens',
      'output_tokens',
    ])
  })
  it('validates the closed canonical shape and overwrites authoritative identity, time, tokens, and trusted cost', () => {
    const result = reconcileAgentResult(
      raw,
      identity,
      usage,
      { currency: 'USD', amount: 0.02 },
      '2026-08-16T08:00:00.000Z',
      '2026-08-16T08:00:01.000Z',
    )
    assert.equal(result.trace_id, identity.trace_id)
    assert.deepEqual(result.cost, {
      currency: 'USD',
      llm: 0,
      tools: 0,
      total: 0,
      input_tokens: 10,
      output_tokens: 5,
    })
    assert.deepEqual(result.metrics, {
      provider_usage_value_usd: 0.004,
      cash_cost_usd: 0,
      pricing_snapshot_id: 'opencode-go-2026-08-21-v2',
      pricing_source: 'official_docs_snapshot',
    })
    assert.equal(result.started_at, '2026-08-16T08:00:00.000Z')
    assert.equal(result.finished_at, '2026-08-16T08:00:01.000Z')
  })

  it('normalizes identity and rejects unknown fields, external changes, and external actions in simulation', () => {
    const normalized = reconcileAgentResult(
      {
        ...raw,
        mission_id: crypto.randomUUID(),
        trace_id: crypto.randomUUID(),
        assignment_id: crypto.randomUUID(),
        agent_id: 'commercial-qa-compliance',
      },
      identity,
      usage,
      { currency: 'USD', amount: 0.02 },
      '2026-08-16T08:00:00Z',
      '2026-08-16T08:00:01Z',
    )
    assert.equal(normalized.mission_id, identity.mission_id)
    assert.equal(normalized.trace_id, identity.trace_id)
    assert.equal(normalized.assignment_id, identity.assignment_id)
    assert.equal(normalized.agent_id, identity.profile_id)
    assert.throws(
      () =>
        reconcileAgentResult(
          { ...raw, override: true },
          identity,
          usage,
          { currency: 'USD', amount: 0.02 },
          '2026-08-16T08:00:00Z',
          '2026-08-16T08:00:01Z',
        ),
      /INVALID_AGENT_RESULT/,
    )
    assert.throws(
      () =>
        reconcileAgentResult(
          { ...raw, external_changes: [{}] },
          identity,
          usage,
          { currency: 'USD', amount: 0.02 },
          '2026-08-16T08:00:00Z',
          '2026-08-16T08:00:01Z',
        ),
      /SIMULATION_EXTERNAL_CHANGE/,
    )
    assert.throws(
      () =>
        reconcileAgentResult(
          {
            ...raw,
            actions_taken: [
              {
                action_id: 'a',
                action_type: 'send',
                tool: 'mail',
                started_at: '2026-08-16T08:00:00Z',
                finished_at: '2026-08-16T08:00:01Z',
                outcome: 'success',
                idempotency_key: '12345678',
                external: true,
              },
            ],
          },
          identity,
          usage,
          { currency: 'USD', amount: 0.02 },
          '2026-08-16T08:00:00Z',
          '2026-08-16T08:00:01Z',
        ),
      /SIMULATION_EXTERNAL_ACTION/,
    )
  })

  it('never turns unknown native cost into zero or the reserved ceiling', () => {
    assert.throws(
      () =>
        reconcileAgentResult(
          raw,
          identity,
          {
            ...usage,
            cost: {
              status: 'unknown',
              usage_value_usd: null,
              cash_cost_usd: null,
              source: 'none',
              pricing_snapshot_id: null,
            },
          },
          { currency: 'USD', amount: 0.02 },
          '2026-08-16T08:00:00Z',
          '2026-08-16T08:00:01Z',
        ),
      /HERMES_COST_UNKNOWN/,
    )
  })
})
