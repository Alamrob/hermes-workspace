import { createServer } from 'node:net'
import { lstat, unlink } from 'node:fs/promises'
import { validateExecuteRequest } from './executor-contract.js'
import { encodeFrame, readSingleFrame } from './unix-frame.js'
import type { Server, Socket } from 'node:net'
import { ExecutorExecutionError, type ExecutorPort } from './hermes-executor.js'
import type { SocketSecurityPort } from './socket-security.js'

export interface UnixExecutorServerOptions {
  socketPath: string
  executor: ExecutorPort
  frameTimeoutMs: number
  security?: SocketSecurityPort
}

export class UnixExecutorServer {
  private server: Server | undefined
  private busy = false

  constructor(private readonly options: UnixExecutorServerOptions) {
    if (!options.socketPath) throw new Error('EXECUTOR_SOCKET_PATH_REQUIRED')
    if (
      !Number.isSafeInteger(options.frameTimeoutMs) ||
      options.frameTimeoutMs <= 0 ||
      options.frameTimeoutMs > 60_000
    )
      throw new Error('EXECUTOR_FRAME_TIMEOUT_INVALID')
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('EXECUTOR_SERVER_ALREADY_STARTED')
    await this.options.security?.beforeListen(this.options.socketPath)
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      void this.handle(socket)
    })
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.options.socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
      await this.options.security?.afterListen(this.options.socketPath)
    } catch (error) {
      this.server = undefined
      const bound = server.listening
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()))
      if (bound) await removeBoundSocket(this.options.socketPath)
      throw error
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }

  private async handle(socket: Socket): Promise<void> {
    socket.on('error', () => {})
    let requestId = 'invalid-request'
    let requestValidated = false
    try {
      const frame = await readSingleFrame(
        socket,
        undefined,
        this.options.frameTimeoutMs,
        process.platform !== 'win32',
      )
      requestId = requestIdFromFrame(frame) ?? requestId
      const request = validateExecuteRequest(frame)
      requestId = request.request_id
      requestValidated = true
      if (this.busy) {
        socket.end(
          encodeFrame(
            errorResponse(requestId, 'EXECUTOR_BUSY', true, 'not_started'),
          ),
        )
        return
      }
      this.busy = true
      try {
        const { request_id: _requestId, type: _type, ...input } = request
        const envelope = await this.options.executor.execute(input)
        socket.end(
          encodeFrame({
            request_id: requestId,
            type: 'result',
            ok: true,
            envelope,
          }),
        )
      } finally {
        this.busy = false
      }
    } catch (error) {
      if (!socket.destroyed) {
        const code = mapExecutorError(error)
        const executionState =
          error instanceof ExecutorExecutionError
            ? error.executionState
            : !requestValidated
              ? 'not_started'
              : 'unknown'
        socket.end(
          encodeFrame(errorResponse(requestId, code, false, executionState)),
        )
      }
    }
  }
}

function requestIdFromFrame(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const requestId = (value as Record<string, unknown>).request_id
  return typeof requestId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestId,
    )
    ? requestId
    : undefined
}

async function removeBoundSocket(path: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const metadata = await lstat(path)
    if (!metadata.isSocket()) throw new Error('UNSAFE_EXECUTOR_SOCKET_CLEANUP')
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function errorResponse(
  requestId: string,
  code: string,
  recoverable: boolean,
  execution_state: 'not_started' | 'unknown' | 'finished',
) {
  return {
    request_id: requestId,
    type: 'result',
    ok: false,
    error: { code, recoverable, execution_state },
  }
}

function mapExecutorError(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (
    [
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
      'SIMULATION_EXTERNAL_CHANGE',
      'SIMULATION_EXTERNAL_ACTION',
      'APPROVED_EXECUTION_CHARGE_REQUIRED',
      'HERMES_COST_RESERVATION_EXCEEDED',
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
    ].includes(code)
  )
    return code
  if (/^HERMES_EXIT_[0-9]+$/.test(code)) return code
  if (
    /^HERMES_(?:PROVIDER_(?:AUTH_REJECTED|ACCESS_REJECTED|CAPACITY_REJECTED|MODEL_REJECTED|REQUEST_REJECTED|NETWORK_ERROR)|LOCAL_CONFIGURATION_ERROR)$/.test(
      code,
    )
  )
    return code
  if (
    /^HERMES_(?:(?:PROFILE_HOME|WORK_DIRECTORY|IMMUTABLE_SEED|TEMP_DIRECTORY|LOCAL)_PERMISSION_DENIED|LOCAL_READ_ONLY_FILESYSTEM|PROFILE_(?:YAML_INVALID|CONFIG_INVALID|RUNTIME_ERROR))$/.test(
      code,
    )
  )
    return code
  if (
    /^(?:PROFILE_|UNSAFE_|SECRET_|EXPECTED_CHILD_|EXECUTOR_EFFECTIVE_|POSIX_|SERVICE_PRIMARY_|HERMES_CWD_)[A-Z0-9_]*$/.test(
      code,
    )
  )
    return code
  const localErrno = code.match(
    /(?:^|[^A-Z0-9])(E(?:ACCES|PERM|NOENT|INVAL|IO|BUSY|AGAIN|MFILE|NFILE|NOMEM|NOSPC|ROFS))(?:[^A-Z0-9]|$)/,
  )?.[1]
  if (localErrno) return `EXECUTOR_LOCAL_${localErrno}`
  return 'EXECUTOR_FAILURE'
}
