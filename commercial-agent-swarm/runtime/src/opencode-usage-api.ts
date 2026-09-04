import type { TrustedUsage } from './executor-contract.js'
import { readBoundedHttpBody } from './bounded-http-body.js'

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
  'reasoning_mode',
  'reasoning_effort',
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

export type UsageExecutionPhase =
  | 'usage_baseline_start'
  | 'usage_baseline_complete'
  | 'executor_start'
  | 'executor_complete'
  | 'usage_export_start'
  | 'usage_export_complete'

export class OpenCodeUsageProbeError extends Error {
  constructor(
    message: string,
    readonly executionState: 'not_started' | 'usage_unknown',
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'OpenCodeUsageProbeError'
  }
}

export class FetchOpenCodeUsageExportReader
  implements OpenCodeUsageExportReadPort
{
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number

  constructor(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetcher = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 5_000
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 30_000
    )
      throw new Error('OPENCODE_USAGE_EXPORT_TIMEOUT_INVALID')
  }

  async getCsvExport(
    request: Parameters<OpenCodeUsageExportReadPort['getCsvExport']>[0],
  ): Promise<string> {
    validateQuery(request)
    if (
      request.url !== OPENCODE_USAGE_EXPORT_URL ||
      !request.bearerToken.trim() ||
      Buffer.byteLength(request.bearerToken) > 8_192
    )
      throw new Error('OPENCODE_USAGE_EXPORT_REQUEST_INVALID')
    const url = new URL(OPENCODE_USAGE_EXPORT_URL)
    url.searchParams.set('scope', request.scope)
    url.searchParams.set('range', request.range)
    url.searchParams.set('service_account_id', request.serviceAccountId)
    let response: Response
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        headers: {
          accept: 'text/csv',
          authorization: `Bearer ${request.bearerToken}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new Error('OPENCODE_USAGE_EXPORT_FAILED', { cause: error })
    }
    if (
      !response.ok ||
      !response.headers.get('content-type')?.toLowerCase().startsWith('text/csv')
    )
      throw new Error('OPENCODE_USAGE_EXPORT_FAILED')
    return (
      await readBoundedHttpBody(
        response,
        MAX_CSV_BYTES,
        'OPENCODE_USAGE_CSV_TOO_LARGE',
      )
    ).toString('utf8')
  }
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
    onPhase?: (phase: UsageExecutionPhase) => void
  }): Promise<{
    usage: TrustedUsage
    usageRecordId: string
    runUsageValueMicroCents: number
    missionUsageValueMicroCents: number
    totalUsageValueMicroCents: number
    incrementalCashCostMicroCents: 0
    budgetExceeded?: true
  }> {
    if (this.busy)
      throw new OpenCodeUsageProbeError(
        'OPENCODE_USAGE_PROBE_BUSY',
        'not_started',
      )
    try {
      assertBudgetAvailable(
        input.missionCommittedUsageValueMicroCents,
        input.totalCommittedUsageValueMicroCents,
      )
    } catch (error) {
      throw classifyProbeError(error, 'not_started')
    }
    this.busy = true
    try {
      const query: ExportQuery = {
        scope: 'service_account',
        range: '24h',
        serviceAccountId: input.serviceAccountId,
      }
      let before: OpenCodeUsageRow[]
      try {
        emitPhase(input.onPhase, 'usage_baseline_start')
        before = await this.options.client.export(query)
        emitPhase(input.onPhase, 'usage_baseline_complete')
      } catch (error) {
        throw classifyProbeError(error, 'not_started')
      }
      emitPhase(input.onPhase, 'executor_start')
      const usage = await input.probe()
      emitPhase(input.onPhase, 'executor_complete')
      try {
        emitPhase(input.onPhase, 'usage_export_start')
        const after = await this.options.client.export(query)
        emitPhase(input.onPhase, 'usage_export_complete')
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
        const budgetExceeded =
          run > MAX_RUN_USAGE_VALUE_MICRO_CENTS ||
          input.missionCommittedUsageValueMicroCents + run >
            MAX_MISSION_USAGE_VALUE_MICRO_CENTS ||
          input.totalCommittedUsageValueMicroCents + run >
            MAX_TOTAL_USAGE_VALUE_MICRO_CENTS
        // This is an observed charge, not permission for another call. Keep
        // the exact reconciled record so settlement can charge and contain it.
        // Pre-execution reservation checks above remain fail-closed.
        return {
          usage,
          usageRecordId: row.id,
          runUsageValueMicroCents: run,
          missionUsageValueMicroCents:
            input.missionCommittedUsageValueMicroCents + run,
          totalUsageValueMicroCents:
            input.totalCommittedUsageValueMicroCents + run,
          incrementalCashCostMicroCents: 0,
          ...(budgetExceeded ? { budgetExceeded: true as const } : {}),
        }
      } catch (error) {
        throw classifyProbeError(error, 'usage_unknown')
      }
    } finally {
      this.busy = false
    }
  }
}

function emitPhase(
  observer: ((phase: UsageExecutionPhase) => void) | undefined,
  phase: UsageExecutionPhase,
): void {
  try {
    observer?.(phase)
  } catch {
    // Observability must never change the commercial execution state.
  }
}

function classifyProbeError(
  error: unknown,
  executionState: 'not_started' | 'usage_unknown',
): OpenCodeUsageProbeError {
  if (error instanceof OpenCodeUsageProbeError) return error
  const message =
    error instanceof Error && /^[A-Z0-9_:-]{1,128}$/.test(error.message)
      ? error.message
      : 'OPENCODE_USAGE_PROBE_FAILED'
  return new OpenCodeUsageProbeError(message, executionState, { cause: error })
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
    reasoningEffort: cells[13],
    reasoningMode: cells[12],
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
    usage.provider !== 'opencode-go' ||
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
