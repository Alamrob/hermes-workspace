import type { TrustedUsage } from './executor-contract.js'

export const OPENCODE_USAGE_EXPORT_URL =
  'https://console.opencode.ai/api/v1/usage/export'
export const OPENCODE_GO_MODEL = 'deepseek-v4-flash'
export const OPENCODE_MAX_OUTPUT_TOKENS_PER_CALL = 4_096
export const OPENCODE_MAX_API_CALLS_PER_RUN = 6
export const MAX_RUN_USAGE_VALUE_MICRO_CENTS = 10_000_000
export const MAX_MISSION_USAGE_VALUE_MICRO_CENTS = 50_000_000
export const MAX_TOTAL_USAGE_VALUE_MICRO_CENTS = 1_000_000_000
const MAX_CSV_BYTES = 1_048_576
const MAX_CSV_ROWS = 10_000

const CSV_COLUMNS = [
  'id',
  'user_email',
  'service_account_name',
  'app',
  'provider',
  'model',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cache_read_tokens',
  'cache_write_5m_tokens',
  'cache_write_1h_tokens',
  'reasoning_effort',
  'reasoning_mode',
  'reasoning_budget_tokens',
  'reasoning_source',
  'billing_source',
  'cost_micro_cents',
  'created_at',
] as const

export interface OpenCodeUsageRow {
  id: string
  userEmail: string
  serviceAccountName: string
  app: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  reasoningEffort: string
  reasoningMode: string
  reasoningBudgetTokens: number
  reasoningSource: string
  billingSource: string
  usageValueMicroCents: number
  createdAt: string
}

export interface OpenCodeUsageExportReadPort {
  getCsvExport(request: {
    url: typeof OPENCODE_USAGE_EXPORT_URL
    bearerToken: string
    scope: 'service_account'
    range: '24h' | '7d' | '30d'
    serviceAccountId: string
  }): Promise<string>
}

interface ExportQuery {
  scope: 'service_account'
  range: '24h' | '7d' | '30d'
  serviceAccountId: string
}

export class OpenCodeUsageExportClient {
  constructor(
    private readonly options: {
      reader: OpenCodeUsageExportReadPort
      readToken: () => Promise<string>
    },
  ) {}

  async export(query: ExportQuery): Promise<OpenCodeUsageRow[]> {
    validateQuery(query)
    const bearerToken = (await this.options.readToken()).trim()
    if (!bearerToken || Buffer.byteLength(bearerToken) > 8_192)
      throw new Error('OPENCODE_USAGE_READ_TOKEN_INVALID')
    const csv = await this.options.reader.getCsvExport({
      url: OPENCODE_USAGE_EXPORT_URL,
      bearerToken,
      ...query,
    })
    return parseOpenCodeUsageCsv(csv)
  }
}

export class OpenCodeUsageProbe {
  private busy = false
  private readonly now: () => Date

  constructor(
    private readonly options: {
      client: OpenCodeUsageExportClient
      now?: () => Date
    },
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async measure(input: {
    serviceAccountId: string
    missionCommittedUsageValueMicroCents: number
    totalCommittedUsageValueMicroCents: number
    probe: () => Promise<TrustedUsage>
  }): Promise<{
    usage: TrustedUsage
    usageRecordId: string
    runUsageValueMicroCents: number
    missionUsageValueMicroCents: number
    totalUsageValueMicroCents: number
    incrementalCashCostMicroCents: 0
  }> {
    if (this.busy) throw new Error('OPENCODE_USAGE_PROBE_BUSY')
    assertBudgetAvailable(
      input.missionCommittedUsageValueMicroCents,
      input.totalCommittedUsageValueMicroCents,
    )
    this.busy = true
    try {
      const query: ExportQuery = {
        scope: 'service_account',
        range: '24h',
        serviceAccountId: input.serviceAccountId,
      }
      const before = await this.options.client.export(query)
      const usage = await input.probe()
      const after = await this.options.client.export(query)
      const beforeIds = new Set(before.map((row) => row.id))
      if (
        beforeIds.size !== before.length ||
        before.some((row) => !after.some((candidate) => candidate.id === row.id))
      )
        throw new Error('OPENCODE_USAGE_DIFF_AMBIGUOUS')
      const added = after.filter((row) => !beforeIds.has(row.id))
      if (added.length !== 1) throw new Error('OPENCODE_USAGE_DIFF_AMBIGUOUS')
      const row = added[0]
      validateDedicatedServiceAccountRow(row)
      if (row.createdAt.slice(0, 10) !== this.now().toISOString().slice(0, 10))
        throw new Error('OPENCODE_USAGE_WINDOW_INVALID')
      reconcileTelemetry(usage, row)
      const run = row.usageValueMicroCents
      if (
        run > MAX_RUN_USAGE_VALUE_MICRO_CENTS ||
        input.missionCommittedUsageValueMicroCents + run >
          MAX_MISSION_USAGE_VALUE_MICRO_CENTS ||
        input.totalCommittedUsageValueMicroCents + run >
          MAX_TOTAL_USAGE_VALUE_MICRO_CENTS
      )
        throw new Error('OPENCODE_USAGE_VALUE_BUDGET_EXCEEDED')
      return {
        usage,
        usageRecordId: row.id,
        runUsageValueMicroCents: run,
        missionUsageValueMicroCents:
          input.missionCommittedUsageValueMicroCents + run,
        totalUsageValueMicroCents:
          input.totalCommittedUsageValueMicroCents + run,
        incrementalCashCostMicroCents: 0,
      }
    } finally {
      this.busy = false
    }
  }
}

export function parseOpenCodeUsageCsv(csv: string): OpenCodeUsageRow[] {
  if (Buffer.byteLength(csv) > MAX_CSV_BYTES)
    throw new Error('OPENCODE_USAGE_CSV_TOO_LARGE')
  if (csv.includes('\u0000')) throw new Error('OPENCODE_USAGE_CSV_INVALID')
  const matrix = parseCsvMatrix(csv)
  const header = matrix.shift()
  if (!header || header.length !== CSV_COLUMNS.length)
    throw new Error('OPENCODE_USAGE_CSV_INVALID')
  if (header.some((value, index) => value !== CSV_COLUMNS[index]))
    throw new Error('OPENCODE_USAGE_CSV_INVALID')
  if (matrix.length > MAX_CSV_ROWS)
    throw new Error('OPENCODE_USAGE_CSV_TOO_LARGE')
  const rows = matrix.map(parseRow)
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error('OPENCODE_USAGE_CSV_INVALID')
  return rows
}

function parseRow(cells: string[]): OpenCodeUsageRow {
  if (cells.length !== CSV_COLUMNS.length || cells.some((cell) => cell.length > 4_096))
    throw new Error('OPENCODE_USAGE_CSV_INVALID')
  for (const index of [0, 1, 2, 3, 4, 5, 12, 13, 15, 16, 18])
    if (/^[\t ]*[=+\-@]/.test(cells[index]))
      throw new Error('OPENCODE_USAGE_CSV_UNSAFE_CELL')
  const numbers = [6, 7, 8, 9, 10, 11, 14, 17].map((index) => {
    if (!/^[0-9]+$/.test(cells[index]))
      throw new Error('OPENCODE_USAGE_CSV_INVALID')
    const value = Number(cells[index])
    if (!Number.isSafeInteger(value)) throw new Error('OPENCODE_USAGE_CSV_INVALID')
    return value
  })
  if (
    !bounded(cells[0], 256) ||
    (!cells[1] && !cells[2]) ||
    !bounded(cells[3], 256) ||
    !bounded(cells[4], 128) ||
    !bounded(cells[5], 256) ||
    !bounded(cells[12], 128) ||
    !bounded(cells[13], 128) ||
    !bounded(cells[15], 128) ||
    !bounded(cells[16], 128) ||
    !Number.isFinite(Date.parse(cells[18]))
  )
    throw new Error('OPENCODE_USAGE_CSV_INVALID')
  return {
    id: cells[0],
    userEmail: cells[1],
    serviceAccountName: cells[2],
    app: cells[3],
    provider: cells[4],
    model: cells[5],
    inputTokens: numbers[0],
    outputTokens: numbers[1],
    reasoningTokens: numbers[2],
    cacheReadTokens: numbers[3],
    cacheWrite5mTokens: numbers[4],
    cacheWrite1hTokens: numbers[5],
    reasoningEffort: cells[12],
    reasoningMode: cells[13],
    reasoningBudgetTokens: numbers[6],
    reasoningSource: cells[15],
    billingSource: cells[16],
    usageValueMicroCents: numbers[7],
    createdAt: new Date(cells[18]).toISOString(),
  }
}

function parseCsvMatrix(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let closedQuote = false
  const pushField = () => {
    row.push(field)
    field = ''
    closedQuote = false
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]
    if (quoted) {
      if (char === '"') {
        if (csv[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
          closedQuote = true
        }
      } else field += char
      continue
    }
    if (closedQuote && char !== ',' && char !== '\r' && char !== '\n')
      throw new Error('OPENCODE_USAGE_CSV_INVALID')
    if (char === '"') {
      if (field) throw new Error('OPENCODE_USAGE_CSV_INVALID')
      quoted = true
    } else if (char === ',') pushField()
    else if (char === '\n') pushRow()
    else if (char !== '\r') field += char
  }
  if (quoted) throw new Error('OPENCODE_USAGE_CSV_INVALID')
  if (field || row.length) pushRow()
  return rows
}

function reconcileTelemetry(usage: TrustedUsage, row: OpenCodeUsageRow): void {
  if (
    usage.model !== OPENCODE_GO_MODEL ||
    usage.provider !== 'custom:deepseek-v4-flash' ||
    usage.completed !== true ||
    usage.failed !== false ||
    usage.api_calls < 1 ||
    usage.api_calls > OPENCODE_MAX_API_CALLS_PER_RUN ||
    usage.tokens.output >
      OPENCODE_MAX_OUTPUT_TOKENS_PER_CALL * OPENCODE_MAX_API_CALLS_PER_RUN ||
    row.provider !== 'opencode' ||
    row.model !== OPENCODE_GO_MODEL ||
    row.inputTokens !== usage.tokens.input ||
    row.outputTokens !== usage.tokens.output ||
    row.reasoningTokens !== usage.tokens.reasoning ||
    row.cacheReadTokens !== usage.tokens.cache_read ||
    row.cacheWrite5mTokens + row.cacheWrite1hTokens !== usage.tokens.cache_write
  )
    throw new Error('OPENCODE_USAGE_RECONCILIATION_FAILED')
}

function assertBudgetAvailable(mission: number, total: number): void {
  if (
    !Number.isSafeInteger(mission) ||
    mission < 0 ||
    !Number.isSafeInteger(total) ||
    total < 0
  )
    throw new Error('OPENCODE_USAGE_VALUE_BUDGET_STATE_INVALID')
  if (
    mission + MAX_RUN_USAGE_VALUE_MICRO_CENTS >
      MAX_MISSION_USAGE_VALUE_MICRO_CENTS ||
    total + MAX_RUN_USAGE_VALUE_MICRO_CENTS >
      MAX_TOTAL_USAGE_VALUE_MICRO_CENTS
  )
    throw new Error('OPENCODE_USAGE_VALUE_BUDGET_EXCEEDED')
}

function validateQuery(query: ExportQuery): void {
  if (
    query.scope !== 'service_account' ||
    !['24h', '7d', '30d'].includes(query.range) ||
    !/^[A-Za-z0-9._:-]{8,256}$/.test(query.serviceAccountId)
  )
    throw new Error('OPENCODE_USAGE_EXPORT_QUERY_INVALID')
}

function validateDedicatedServiceAccountRow(row: OpenCodeUsageRow): void {
  if (row.userEmail !== '' || !bounded(row.serviceAccountName, 256))
    throw new Error('OPENCODE_USAGE_SERVICE_ACCOUNT_INVALID')
}

function bounded(value: string, maximum: number): boolean {
  return value.trim().length > 0 && Buffer.byteLength(value) <= maximum
}
