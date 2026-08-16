import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import type { ExecuteInput } from './executor-contract.js'
import type { ExecutorEnvelope, ExecutorPort } from './hermes-executor.js'
import { reconcileAgentResult } from './agent-result.js'
import { encodeFrame, readSingleFrame } from './unix-frame.js'

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
}

export class UnixExecutorClient implements ExecutorPort {
  constructor(private readonly options: UnixExecutorClientOptions) {
    if (!options.socketPath) throw new Error('EXECUTOR_SOCKET_PATH_REQUIRED')
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('EXECUTOR_CLIENT_TIMEOUT_REQUIRED')
  }

  async execute(input: ExecuteInput): Promise<ExecutorEnvelope> {
    const requestId = randomUUID()
    const socket = createConnection({ path: this.options.socketPath, allowHalfOpen: true })
    const strictEof = process.platform !== 'win32'
    const responsePromise = readSingleFrame(socket, undefined, this.options.timeoutMs, strictEof)
    socket.once('connect', () => strictEof ? socket.end(encodeFrame({ request_id: requestId, type: 'execute', ...input })) : socket.write(encodeFrame({ request_id: requestId, type: 'execute', ...input })))
    try {
      const response = validateResponse(await responsePromise, requestId, input)
      socket.end()
      if (!response.ok) throw new ExecutorTransportError(response.error.code, response.error.recoverable, response.error.execution_state)
      return response.envelope
    } catch (error) {
      socket.destroy()
      if (error instanceof ExecutorTransportError) throw error
      const code = error instanceof Error && error.message === 'IPC_FRAME_TIMEOUT' ? 'EXECUTOR_IPC_TIMEOUT' : 'EXECUTOR_IPC_LOST'
      throw new ExecutorTransportError(code, true, 'unknown')
    }
  }
}

type SuccessResponse = { request_id: string; type: 'result'; ok: true; envelope: ExecutorEnvelope }
type ErrorResponse = { request_id: string; type: 'result'; ok: false; error: { code: string; recoverable: boolean; execution_state: ExecutionState } }

function validateResponse(value: unknown, requestId: string,input:ExecuteInput): SuccessResponse | ErrorResponse {
  if (!isRecord(value) || !onlyKeys(value, value.ok === true ? ['request_id','type','ok','envelope'] : ['request_id','type','ok','error']) || value.request_id !== requestId || value.type !== 'result') throw new Error('INVALID_EXECUTOR_RESPONSE')
  if (value.ok === true) {validateEnvelope(value.envelope,input);return value as unknown as SuccessResponse}
  const error = value.error
  if (value.ok !== false || !isRecord(error) || !onlyKeys(error,['code','recoverable','execution_state']) || typeof error.code !== 'string' || !allowedError(error.code) || typeof error.recoverable !== 'boolean' || !['not_started','unknown','finished'].includes(String(error.execution_state))) throw new Error('INVALID_EXECUTOR_RESPONSE')
  return value as unknown as ErrorResponse
}

function validateEnvelope(value:unknown,input:ExecuteInput):void{if(!isRecord(value)||!onlyKeys(value,['schema_version','agent_result','usage'])||value.schema_version!=='1.0'||!isRecord(value.usage))throw new Error('INVALID_EXECUTOR_RESPONSE');const usage=value.usage;if(!onlyKeys(usage,['tokens','api_calls','model','provider','completed','failed','cost'])||!isRecord(usage.tokens)||!onlyKeys(usage.tokens,['input','output','cache_read','cache_write','reasoning','total'])||!isRecord(usage.cost)||!onlyKeys(usage.cost,['status','amount_usd','source'])||usage.completed!==true||usage.failed!==false||usage.model!=='deepseek-v4-flash'||usage.provider!=='custom:deepseek-v4-flash'||usage.cost.status!=='known'||typeof usage.cost.amount_usd!=='number'||!Number.isFinite(usage.cost.amount_usd)||usage.cost.amount_usd<0||usage.cost.amount_usd>input.reservation.budget_reservation.amount)throw new Error('INVALID_EXECUTOR_RESPONSE');const counts=[usage.tokens.input,usage.tokens.output,usage.tokens.cache_read,usage.tokens.cache_write,usage.tokens.reasoning,usage.tokens.total,usage.api_calls];if(!counts.every(v=>Number.isSafeInteger(v)&&Number(v)>=0)||Number(usage.tokens.total)!==Number(usage.tokens.input)+Number(usage.tokens.output)+Number(usage.tokens.cache_read)+Number(usage.tokens.cache_write)||Number(usage.tokens.total)>input.reservation.maximum_tokens||Number(usage.api_calls)<1||Number(usage.api_calls)>input.reservation.maximum_api_calls)throw new Error('INVALID_EXECUTOR_RESPONSE');const result=reconcileAgentResult(value.agent_result,input,usage as never,input.reservation.budget_reservation,String((value.agent_result as Record<string,unknown>)?.started_at),String((value.agent_result as Record<string,unknown>)?.finished_at));if(JSON.stringify(result)!==JSON.stringify(value.agent_result))throw new Error('INVALID_EXECUTOR_RESPONSE')}
function allowedError(code:string):boolean{return['EXECUTOR_BUSY','INVALID_EXECUTOR_REQUEST','IPC_FRAME_LENGTH','IPC_FRAME_TOO_LARGE','IPC_FRAME_TRUNCATED','IPC_FRAME_TRAILING','IPC_FRAME_JSON','IPC_FRAME_TIMEOUT','UNKNOWN_PROFILE','HERMES_TIMEOUT','INVALID_EXECUTOR_ENVELOPE','INVALID_AGENT_RESULT','HERMES_USAGE_FAILED','HERMES_USAGE_UNKNOWN','HERMES_COST_UNKNOWN','EXECUTOR_FAILURE'].includes(code)||/^HERMES_EXIT_[0-9]+$/.test(code)}

function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)}
function onlyKeys(value:Record<string,unknown>,keys:string[]):boolean{return Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))}
