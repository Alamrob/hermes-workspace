import type { TrustedUsage } from './executor-contract.js'

export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const OPENCODE_GO_MODEL = 'deepseek-v4-flash'
export const OPENCODE_MAX_OUTPUT_TOKENS_PER_CALL = 4_096
export const OPENCODE_MAX_API_CALLS_PER_RUN = 6
export const MAX_RUN_COST_MICRO_CENTS = 10_000_000
export const MAX_MISSION_COST_MICRO_CENTS = 50_000_000
export const MAX_TOTAL_COST_MICRO_CENTS = 1_000_000_000

export interface OpenCodeRunUsage {
  run_id: string
  model: 'deepseek-v4-flash'
  base_url: 'https://opencode.ai/zen/go/v1'
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  api_calls: number
  cost_micro_cents: number
}

export interface OpenCodeUsageReadPort {
  getRunUsage(request: {
    baseUrl: typeof OPENCODE_GO_BASE_URL
    runId: string
    bearerToken: string
  }): Promise<unknown>
}

export class OpenCodeUsageClient {
  constructor(
    private readonly options: {
      reader: OpenCodeUsageReadPort
      readToken: () => Promise<string>
    },
  ) {}

  async getRunUsage(runId: string): Promise<OpenCodeRunUsage> {
    if (!validRunId(runId)) throw new Error('OPENCODE_USAGE_RUN_ID_INVALID')
    const bearerToken = (await this.options.readToken()).trim()
    if (!bearerToken || Buffer.byteLength(bearerToken) > 8_192)
      throw new Error('OPENCODE_USAGE_READ_TOKEN_INVALID')
    const response = await this.options.reader.getRunUsage({
      baseUrl: OPENCODE_GO_BASE_URL,
      runId,
      bearerToken,
    })
    return parseRunUsage(response, runId)
  }
}

export function assertOpenCodeBudgetAvailable(input: {
  missionCommittedMicroCents: number
  totalCommittedMicroCents: number
}): void {
  validateCommitted(input.missionCommittedMicroCents)
  validateCommitted(input.totalCommittedMicroCents)
  if (
    input.missionCommittedMicroCents + MAX_RUN_COST_MICRO_CENTS >
      MAX_MISSION_COST_MICRO_CENTS ||
    input.totalCommittedMicroCents + MAX_RUN_COST_MICRO_CENTS >
      MAX_TOTAL_COST_MICRO_CENTS
  )
    throw new Error('OPENCODE_BUDGET_EXCEEDED')
}

export function reconcileOpenCodeRunUsage(input: {
  runId: string
  localUsage: TrustedUsage
  remoteUsage: unknown
  missionCommittedMicroCents: number
  totalCommittedMicroCents: number
}): {
  runCostMicroCents: number
  missionCostMicroCents: number
  totalCostMicroCents: number
} {
  validateCommitted(input.missionCommittedMicroCents)
  validateCommitted(input.totalCommittedMicroCents)
  let remote: OpenCodeRunUsage
  try {
    remote = parseRunUsage(input.remoteUsage, input.runId)
    if (
      input.localUsage.model !== OPENCODE_GO_MODEL ||
      input.localUsage.provider !== 'custom:deepseek-v4-flash' ||
      input.localUsage.completed !== true ||
      input.localUsage.failed !== false ||
      remote.input_tokens !== input.localUsage.tokens.input ||
      remote.output_tokens !== input.localUsage.tokens.output ||
      remote.cache_read_tokens !== input.localUsage.tokens.cache_read ||
      remote.cache_write_tokens !== input.localUsage.tokens.cache_write ||
      remote.api_calls !== input.localUsage.api_calls
    )
      throw new Error('telemetry mismatch')
  } catch (error) {
    throw new Error('OPENCODE_USAGE_RECONCILIATION_FAILED', { cause: error })
  }
  if (
    remote.cost_micro_cents > MAX_RUN_COST_MICRO_CENTS ||
    input.missionCommittedMicroCents + remote.cost_micro_cents >
      MAX_MISSION_COST_MICRO_CENTS ||
    input.totalCommittedMicroCents + remote.cost_micro_cents >
      MAX_TOTAL_COST_MICRO_CENTS
  )
    throw new Error('OPENCODE_BUDGET_EXCEEDED')
  return {
    runCostMicroCents: remote.cost_micro_cents,
    missionCostMicroCents:
      input.missionCommittedMicroCents + remote.cost_micro_cents,
    totalCostMicroCents:
      input.totalCommittedMicroCents + remote.cost_micro_cents,
  }
}

function parseRunUsage(value: unknown, expectedRunId: string): OpenCodeRunUsage {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'run_id',
      'model',
      'base_url',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'api_calls',
      'cost_micro_cents',
    ]) ||
    value.run_id !== expectedRunId ||
    value.model !== OPENCODE_GO_MODEL ||
    value.base_url !== OPENCODE_GO_BASE_URL ||
    !validCount(value.input_tokens) ||
    !validCount(value.output_tokens) ||
    Number(value.output_tokens) >
      OPENCODE_MAX_OUTPUT_TOKENS_PER_CALL * OPENCODE_MAX_API_CALLS_PER_RUN ||
    !validCount(value.cache_read_tokens) ||
    !validCount(value.cache_write_tokens) ||
    !Number.isSafeInteger(value.api_calls) ||
    Number(value.api_calls) < 1 ||
    Number(value.api_calls) > OPENCODE_MAX_API_CALLS_PER_RUN ||
    !Number.isSafeInteger(value.cost_micro_cents) ||
    Number(value.cost_micro_cents) < 0
  )
    throw new Error('OPENCODE_USAGE_RESPONSE_INVALID')
  return value as unknown as OpenCodeRunUsage
}

function validCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validRunId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value)
}

function validateCommitted(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('OPENCODE_BUDGET_STATE_INVALID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
