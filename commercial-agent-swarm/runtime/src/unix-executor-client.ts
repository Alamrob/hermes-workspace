import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { reconcileAgentResult } from './agent-result.js'
import { OPENCODE_GO_PRICING_SNAPSHOT } from './opencode-go-pricing.js'
import { encodeFrame, readSingleFrame } from './unix-frame.js'
import type { ExecutorEnvelope, ExecutorPort } from './hermes-executor.js'
import type { ExecuteInput } from './executor-contract.js'

export type ExecutionState = 'not_started' | 'unknown' | 'finished'

export class ExecutorTransportError extends Error {
  constructor(
    readonly code: string,
    readonly recoverable: boolean,
    readonly executionState: ExecutionState,
  ) {
    super(code)
  }
}

export interface UnixExecutorClientOptions {
  socketPath: string
  timeoutMs: number
  connectTimeoutMs?: number
  onPhase?: (phase: ExecutorIpcPhase, input: ExecuteInput) => void
}

export type ExecutorIpcPhase =
  | 'executor_ipc_client_start'
  | 'executor_ipc_socket_created'
  | 'executor_ipc_connected'
  | 'executor_ipc_request_sent'
  | 'executor_ipc_response_received'

export class UnixExecutorClient implements ExecutorPort {
  constructor(private readonly options: UnixExecutorClientOptions) {
    if (!options.socketPath) throw new Error('EXECUTOR_SOCKET_PATH_REQUIRED')
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
      throw new Error('EXECUTOR_CLIENT_TIMEOUT_REQUIRED')
    const connectTimeoutMs = options.connectTimeoutMs ?? Math.min(5_000, options.timeoutMs)
    if (
      !Number.isSafeInteger(connectTimeoutMs) ||
      connectTimeoutMs < 10 ||
      connectTimeoutMs > options.timeoutMs
    )
      throw new Error('EXECUTOR_CONNECT_TIMEOUT_INVALID')
  }

  async execute(input: ExecuteInput): Promise<ExecutorEnvelope> {
    this.emitPhase('executor_ipc_client_start', input)
    const requestId = randomUUID()
    const frame = encodeFrame({ request_id: requestId, type: 'execute', ...input })
    let connected = false
    const socket = createConnection({
      path: this.options.socketPath,
      allowHalfOpen: true,
    })
    this.emitPhase('executor_ipc_socket_created', input)
    const strictEof = process.platform !== 'win32'
    const responsePromise = readSingleFrame(
      socket,
      undefined,
      this.options.timeoutMs,
      strictEof,
    )
    const connectTimer = setTimeout(() => {
      socket.destroy(new Error('EXECUTOR_IPC_CONNECT_TIMEOUT'))
    }, this.options.connectTimeoutMs ?? Math.min(5_000, this.options.timeoutMs))
    socket.once('connect', () => {
      connected = true
      clearTimeout(connectTimer)
      this.emitPhase('executor_ipc_connected', input)
      if (strictEof) socket.end(frame)
      else socket.write(frame)
      this.emitPhase('executor_ipc_request_sent', input)
    })
    try {
      const value = await responsePromise
      this.emitPhase('executor_ipc_response_received', input)
      const response = validateResponse(value, requestId, input)
      socket.end()
      if (!response.ok)
        throw new ExecutorTransportError(
          response.error.code,
          response.error.recoverable,
          response.error.execution_state,
        )
      return response.envelope
    } catch (error) {
      clearTimeout(connectTimer)
      socket.destroy()
      if (error instanceof ExecutorTransportError) throw error
      if (!connected)
        throw new ExecutorTransportError(
          error instanceof Error && error.message === 'EXECUTOR_IPC_CONNECT_TIMEOUT'
            ? 'EXECUTOR_IPC_CONNECT_TIMEOUT'
            : 'EXECUTOR_IPC_CONNECT_FAILED',
          true,
          'not_started',
        )
      const code =
        error instanceof Error && error.message === 'IPC_FRAME_TIMEOUT'
          ? 'EXECUTOR_IPC_TIMEOUT'
          : 'EXECUTOR_IPC_LOST'
      throw new ExecutorTransportError(code, true, 'unknown')
    }
  }

  private emitPhase(phase: ExecutorIpcPhase, input: ExecuteInput): void {
    try {
      this.options.onPhase?.(phase, input)
    } catch {
      // Observability must never change the executor transport state.
    }
  }
}

type SuccessResponse = {
  request_id: string
  type: 'result'
  ok: true
  envelope: ExecutorEnvelope
}
type ErrorResponse = {
  request_id: string
  type: 'result'
  ok: false
  error: { code: string; recoverable: boolean; execution_state: ExecutionState }
}

function validateResponse(
  value: unknown,
  requestId: string,
  input: ExecuteInput,
): SuccessResponse | ErrorResponse {
  if (
    !isRecord(value) ||
    !onlyKeys(
      value,
      value.ok === true
        ? ['request_id', 'type', 'ok', 'envelope']
        : ['request_id', 'type', 'ok', 'error'],
    ) ||
    value.request_id !== requestId ||
    value.type !== 'result'
  )
    throw new Error('INVALID_EXECUTOR_RESPONSE')
  if (value.ok === true) {
    validateEnvelope(value.envelope, input)
    return value as unknown as SuccessResponse
  }
  const error = value.error
  if (
    value.ok !== false ||
    !isRecord(error) ||
    !onlyKeys(error, ['code', 'recoverable', 'execution_state']) ||
    typeof error.code !== 'string' ||
    !allowedError(error.code) ||
    typeof error.recoverable !== 'boolean' ||
    !['not_started', 'unknown', 'finished'].includes(
      String(error.execution_state),
    )
  )
    throw new Error('INVALID_EXECUTOR_RESPONSE')
  return value as unknown as ErrorResponse
}

function validateEnvelope(value: unknown, input: ExecuteInput): void {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['schema_version', 'agent_result', 'usage']) ||
    value.schema_version !== '1.0' ||
    !isRecord(value.usage)
  )
    throw new Error('INVALID_EXECUTOR_RESPONSE')
  const usage = value.usage
  if (
    !onlyKeys(usage, [
      'tokens',
      'api_calls',
      'model',
      'provider',
      'completed',
      'failed',
      'cost',
    ]) ||
    !isRecord(usage.tokens) ||
    !onlyKeys(usage.tokens, [
      'input',
      'output',
      'cache_read',
      'cache_write',
      'reasoning',
      'total',
    ]) ||
    !isRecord(usage.cost) ||
    !onlyKeys(usage.cost, [
      'status',
      'usage_value_usd',
      'cash_cost_usd',
      'source',
      'pricing_snapshot_id',
    ]) ||
    usage.completed !== true ||
    usage.failed !== false ||
    usage.model !== 'deepseek-v4-flash' ||
    usage.provider !== 'opencode-go' ||
    usage.cost.status !== 'known' ||
    typeof usage.cost.usage_value_usd !== 'number' ||
    !Number.isFinite(usage.cost.usage_value_usd) ||
    usage.cost.usage_value_usd < 0 ||
    usage.cost.usage_value_usd > input.reservation.budget_reservation.amount ||
    usage.cost.cash_cost_usd !== 0 ||
    usage.cost.source !== 'official_docs_snapshot' ||
    usage.cost.pricing_snapshot_id !== OPENCODE_GO_PRICING_SNAPSHOT.id
  )
    throw new Error('INVALID_EXECUTOR_RESPONSE')
  const counts = [
    usage.tokens.input,
    usage.tokens.output,
    usage.tokens.cache_read,
    usage.tokens.cache_write,
    usage.tokens.reasoning,
    usage.tokens.total,
    usage.api_calls,
  ]
  if (
    !counts.every((v) => Number.isSafeInteger(v) && Number(v) >= 0) ||
    Number(usage.tokens.total) !==
      Number(usage.tokens.input) +
        Number(usage.tokens.output) +
        Number(usage.tokens.cache_read) +
        Number(usage.tokens.cache_write) ||
    Number(usage.tokens.total) > input.reservation.maximum_tokens ||
    Number(usage.api_calls) < 1 ||
    Number(usage.api_calls) > input.reservation.maximum_api_calls
  )
    throw new Error('INVALID_EXECUTOR_RESPONSE')
  const result = reconcileAgentResult(
    value.agent_result,
    input,
    usage as never,
    input.reservation.budget_reservation,
    String((value.agent_result as Record<string, unknown>).started_at),
    String((value.agent_result as Record<string, unknown>).finished_at),
  )
  if (JSON.stringify(result) !== JSON.stringify(value.agent_result))
    throw new Error('INVALID_EXECUTOR_RESPONSE')
}
function allowedError(code: string): boolean {
  return (
    [
      'EXECUTOR_BUSY',
      'INVALID_EXECUTOR_REQUEST',
      'IPC_FRAME_LENGTH',
      'IPC_FRAME_TOO_LARGE',
      'IPC_FRAME_TRUNCATED',
      'IPC_FRAME_TRAILING',
      'IPC_FRAME_JSON',
      'IPC_FRAME_TIMEOUT',
      'UNKNOWN_PROFILE',
      'HERMES_TIMEOUT',
      'HERMES_PROCESS_GROUP_NOT_REAPED',
      'HERMES_STDOUT_LIMIT',
      'HERMES_STDERR_LIMIT',
      'INVALID_EXECUTOR_ENVELOPE',
      'INVALID_AGENT_RESULT',
      'HERMES_USAGE_FAILED',
      'HERMES_USAGE_UNKNOWN',
      'HERMES_COST_UNKNOWN',
      'HERMES_PRICING_AUTHORITY_INVALID',
      'HERMES_TIMEOUT_HANDSHAKE_MISMATCH',
      'OPENCODE_GO_SNAPSHOT_REVALIDATION_REQUIRED',
      'OPENCODE_GO_CACHE_WRITE_PRICE_UNKNOWN',
      'OPENCODE_GO_PRICING_IDENTITY_MISMATCH',
      'OPENCODE_GO_PRICE_OVERFLOW',
      'OPENCODE_GO_RESERVATION_TOO_LOW',
      'EXECUTOR_FAILURE',
    ].includes(code) ||
    /^HERMES_EXIT_[0-9]+$/.test(code) ||
    /^HERMES_(?:PROVIDER_(?:AUTH_REJECTED|ACCESS_REJECTED|CAPACITY_REJECTED|MODEL_REJECTED|REQUEST_REJECTED|NETWORK_ERROR)|LOCAL_CONFIGURATION_ERROR)$/.test(
      code,
    ) ||
    /^EXECUTOR_LOCAL_E(?:ACCES|PERM|NOENT|INVAL|IO|BUSY|AGAIN|MFILE|NFILE|NOMEM|NOSPC|ROFS)$/.test(
      code,
    ) ||
    /^(?:PROFILE_|UNSAFE_|SECRET_|EXPECTED_CHILD_|EXECUTOR_EFFECTIVE_|POSIX_|SERVICE_PRIMARY_|HERMES_CWD_)[A-Z0-9_]*$/.test(
      code,
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function onlyKeys(
  value: Record<string, unknown>,
  keys: Array<string>,
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
