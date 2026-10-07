import type { ConversationTrustedUsage } from './executor-contract.js'

const PICODOLLARS_PER_USD = 1_000_000_000_000n
const PICODOLLARS_PER_MICRODOLLAR = 1_000_000n

export const OPENCODE_GO_CONVERSATION_PRICING_SNAPSHOT = Object.freeze({
  id: 'opencode-go-glm-5.3-flash-2026-10-07-v1',
  source: 'https://opencode.ai/docs/go/',
  captured_at: '2026-10-07T00:26:23Z',
  refresh_due_at: '2026-10-30T00:00:00Z',
  revalidate_after: '2026-11-06T00:00:00Z',
  model: 'glm-5.3-flash',
  provider: 'opencode-go',
  picodollars_per_token: Object.freeze({
    input: 150_000n,
    output: 500_000n,
    cache_read: 30_000n,
    cache_write: null,
  }),
})

export function conversationPricingSnapshotState(now: Date): 'current' | 'refresh_due' | 'expired' {
  const time = now.getTime()
  if (!Number.isFinite(time) || time >= Date.parse(OPENCODE_GO_CONVERSATION_PRICING_SNAPSHOT.revalidate_after))
    return 'expired'
  return time >= Date.parse(OPENCODE_GO_CONVERSATION_PRICING_SNAPSHOT.refresh_due_at)
    ? 'refresh_due' : 'current'
}

function assertSnapshotCurrent(now: Date): void {
  if (conversationPricingSnapshotState(now) === 'expired')
    throw new Error('OPENCODE_GO_CONVERSATION_PRICING_REVALIDATION_REQUIRED')
}

export function assertConversationPricingPreflight(
  reservation: {
    maximum_tokens: number
    budget_reservation: { currency: 'USD'; amount: number }
  },
  now: Date,
): void {
  assertSnapshotCurrent(now)
  if (!Number.isSafeInteger(reservation.maximum_tokens) || reservation.maximum_tokens < 1 ||
      reservation.budget_reservation.currency !== 'USD' ||
      !Number.isFinite(reservation.budget_reservation.amount) || reservation.budget_reservation.amount < 0)
    throw new Error('OPENCODE_GO_CONVERSATION_RESERVATION_INVALID')
  const worstCasePicodollars = BigInt(reservation.maximum_tokens) *
    OPENCODE_GO_CONVERSATION_PRICING_SNAPSHOT.picodollars_per_token.output
  const requiredMicrodollars = (worstCasePicodollars + PICODOLLARS_PER_MICRODOLLAR - 1n) /
    PICODOLLARS_PER_MICRODOLLAR
  const reservedMicrodollars = BigInt(Math.round(reservation.budget_reservation.amount * 1_000_000))
  if (reservedMicrodollars < requiredMicrodollars)
    throw new Error('OPENCODE_GO_CONVERSATION_RESERVATION_TOO_LOW')
}

export function priceConversationUsage(
  usage: ConversationTrustedUsage,
  now: Date,
): ConversationTrustedUsage {
  assertSnapshotCurrent(now)
  const snapshot = OPENCODE_GO_CONVERSATION_PRICING_SNAPSHOT
  if (usage.model !== snapshot.model || usage.provider !== snapshot.provider)
    throw new Error('OPENCODE_GO_CONVERSATION_MODEL_MISMATCH')
  if (usage.tokens.cache_write > 0)
    throw new Error('OPENCODE_GO_CONVERSATION_CACHE_WRITE_PRICE_UNKNOWN')
  const rates = snapshot.picodollars_per_token
  const totalPicodollars =
    BigInt(usage.tokens.input) * rates.input +
    BigInt(usage.tokens.output) * rates.output +
    BigInt(usage.tokens.cache_read) * rates.cache_read
  const amountUsd = Number(totalPicodollars) / Number(PICODOLLARS_PER_USD)
  if (!Number.isFinite(amountUsd) || amountUsd < 0)
    throw new Error('OPENCODE_GO_CONVERSATION_PRICE_OVERFLOW')
  return {
    ...usage,
    model: snapshot.model,
    provider: snapshot.provider,
    cost: {
      status: 'known',
      usage_value_usd: amountUsd,
      cash_cost_usd: 0,
      source: 'official_docs_snapshot',
      pricing_snapshot_id: snapshot.id,
    },
  }
}
