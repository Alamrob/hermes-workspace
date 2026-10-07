import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateHermesUsage } from '../src/executor-contract.js'
import {
  OPENCODE_GO_CONVERSATION_PRICING_SNAPSHOT,
  assertConversationPricingPreflight,
  conversationPricingSnapshotState,
  priceConversationUsage,
} from '../src/opencode-go-conversation-pricing.js'

const current = new Date('2026-10-07T01:00:00Z')
const native = {
  input_tokens: 100_000, output_tokens: 100_000, cache_read_tokens: 100_000,
  cache_write_tokens: 0, reasoning_tokens: 0, total_tokens: 300_000,
  api_calls: 1, model: 'glm-5.3-flash', provider: 'opencode-go', completed: true,
  failed: false, estimated_cost_usd: null, cost_status: 'unknown', cost_source: 'none',
  session_id: null, service_tier: null,
}
const reservation = { maximum_tokens: 500_000, maximum_api_calls: 1 }

test('conversation model has its own current official price, independent of the legacy executor', () => {
  assert.equal(OPENCODE_GO_CONVERSATION_PRICING_SNAPSHOT.model, 'glm-5.3-flash')
  assert.equal(conversationPricingSnapshotState(current), 'current')
  assert.throws(() => validateHermesUsage(native, reservation), /HERMES_USAGE_MODEL_MISMATCH/)
  const trusted = validateHermesUsage(native, reservation, 'glm-5.3-flash')
  const priced = priceConversationUsage(trusted, current)
  assert.deepEqual(priced.cost, {
    status: 'known', usage_value_usd: 0.068, cash_cost_usd: 0,
    source: 'official_docs_snapshot',
    pricing_snapshot_id: OPENCODE_GO_CONVERSATION_PRICING_SNAPSHOT.id,
  })
})

test('reserves against the published GLM output rate and rejects unknown cached-write pricing', () => {
  assert.doesNotThrow(() => assertConversationPricingPreflight({ maximum_tokens: 8192,
    budget_reservation: { currency: 'USD', amount: 0.05 } }, current))
  assert.throws(() => assertConversationPricingPreflight({ maximum_tokens: 8192,
    budget_reservation: { currency: 'USD', amount: 0.004095 } }, current),
  /OPENCODE_GO_CONVERSATION_RESERVATION_TOO_LOW/)
  const trusted = validateHermesUsage({ ...native, cache_write_tokens: 1, total_tokens: 300_001 },
    reservation, 'glm-5.3-flash')
  assert.throws(() => priceConversationUsage(trusted, current),
    /OPENCODE_GO_CONVERSATION_CACHE_WRITE_PRICE_UNKNOWN/)
})

test('exposes refresh due and fails closed after the renewed snapshot expires', () => {
  assert.equal(conversationPricingSnapshotState(new Date('2026-10-30T00:00:00Z')), 'refresh_due')
  assert.equal(conversationPricingSnapshotState(new Date('2026-11-06T00:00:00Z')), 'expired')
  assert.equal(conversationPricingSnapshotState(new Date('2026-11-06T00:00:00.001Z')), 'expired')
  assert.throws(() => assertConversationPricingPreflight({ maximum_tokens: 8192,
    budget_reservation: { currency: 'USD', amount: 0.05 } },
  new Date('2026-11-06T00:00:00.001Z')),
  /OPENCODE_GO_CONVERSATION_PRICING_REVALIDATION_REQUIRED/)
})
