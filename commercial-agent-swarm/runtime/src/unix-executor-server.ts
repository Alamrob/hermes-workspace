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
    try {
      const request = validateExecuteRequest(
        await readSingleFrame(
          socket,
          undefined,
          this.options.frameTimeoutMs,
          process.platform !== 'win32',
        ),
      )
      requestId = request.request_id
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
            : requestId === 'invalid-request'
              ? 'not_started'
              : 'unknown'
        socket.end(
          encodeFrame(errorResponse(requestId, code, false, executionState)),
        )
      }
    }
  }
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
    ].includes(code)
  )
    return code
  if (/^HERMES_EXIT_[0-9]+$/.test(code)) return code
  return 'EXECUTOR_FAILURE'
}
