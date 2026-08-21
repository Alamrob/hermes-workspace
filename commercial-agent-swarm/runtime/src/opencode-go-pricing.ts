import type { TrustedUsage } from './executor-contract.js'

const PICODOLLARS_PER_USD = 1_000_000_000_000n
const PICODOLLARS_PER_MICRODOLLAR = 1_000_000n

export const OPENCODE_GO_PRICING_SNAPSHOT = Object.freeze({
  id: 'opencode-go-2026-08-21-v2',
  source: 'https://opencode.ai/docs/go/',
  captured_at: '2026-08-21T00:00:00Z',
  revalidate_after: '2026-08-31T23:59:59Z',
  model: 'deepseek-v4-flash',
  provider: 'custom:deepseek-v4-flash',
  peak_hours_utc: Object.freeze([[1, 4], [6, 10]] as const),
  off_peak_picodollars_per_token: Object.freeze({
    input: 220_000n,
    output: 660_000n,
    cache_read: 7_000n,
    cache_write: null,
  }),
  peak_picodollars_per_token: Object.freeze({
    input: 440_000n,
    output: 1_320_000n,
    cache_read: 14_000n,
    cache_write: null,
  }),
})

export function priceOpenCodeGoUsage(
  usage: Omit<TrustedUsage, 'model' | 'provider'> & {
    model: string
    provider: string
  },
  now: Date,
): TrustedUsage {
  assertSnapshotCurrent(now)
  if (
    usage.model !== OPENCODE_GO_PRICING_SNAPSHOT.model ||
    usage.provider !== OPENCODE_GO_PRICING_SNAPSHOT.provider
  ) {
    throw new Error('OPENCODE_GO_PRICING_IDENTITY_MISMATCH')
  }
  if (usage.tokens.cache_write > 0) {
    throw new Error('OPENCODE_GO_CACHE_WRITE_PRICE_UNKNOWN')
  }

  const rates = ratesAt(now)
  const totalPicodollars =
    BigInt(usage.tokens.input) * rates.input +
    BigInt(usage.tokens.output) * rates.output +
    BigInt(usage.tokens.cache_read) * rates.cache_read
  const amountUsd = Number(totalPicodollars) / Number(PICODOLLARS_PER_USD)

  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new Error('OPENCODE_GO_PRICE_OVERFLOW')
  }

  return {
    ...usage,
    model: OPENCODE_GO_PRICING_SNAPSHOT.model,
    provider: OPENCODE_GO_PRICING_SNAPSHOT.provider,
    cost: {
      status: 'known',
      usage_value_usd: amountUsd,
      cash_cost_usd: 0,
      source: 'official_docs_snapshot',
      pricing_snapshot_id: OPENCODE_GO_PRICING_SNAPSHOT.id,
    },
  }
}

export function assertOpenCodeGoExecutionPreflight(
  reservation: {
    maximum_tokens: number
    budget_reservation: { currency: 'USD'; amount: number }
  },
  now: Date,
): void {
  assertSnapshotCurrent(now)
  const worstCasePicodollars =
    BigInt(reservation.maximum_tokens) *
    OPENCODE_GO_PRICING_SNAPSHOT.peak_picodollars_per_token.output
  const requiredMicrodollars =
    (worstCasePicodollars + PICODOLLARS_PER_MICRODOLLAR - 1n) /
    PICODOLLARS_PER_MICRODOLLAR
  const reservedMicrodollars = BigInt(
    Math.round(reservation.budget_reservation.amount * 1_000_000),
  )
  if (reservedMicrodollars < requiredMicrodollars) {
    throw new Error('OPENCODE_GO_RESERVATION_TOO_LOW')
  }
}

function ratesAt(now: Date) {
  const hour = now.getUTCHours()
  const peak = OPENCODE_GO_PRICING_SNAPSHOT.peak_hours_utc.some(
    ([start, end]) => hour >= start && hour < end,
  )
  return peak
    ? OPENCODE_GO_PRICING_SNAPSHOT.peak_picodollars_per_token
    : OPENCODE_GO_PRICING_SNAPSHOT.off_peak_picodollars_per_token
}

function assertSnapshotCurrent(now: Date): void {
  if (
    !Number.isFinite(now.getTime()) ||
    now.getTime() > Date.parse(OPENCODE_GO_PRICING_SNAPSHOT.revalidate_after)
  ) {
    throw new Error('OPENCODE_GO_SNAPSHOT_REVALIDATION_REQUIRED')
  }
}
