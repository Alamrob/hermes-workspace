import { createServer } from 'node:net'
import { lstat, unlink } from 'node:fs/promises'
import { validateExecuteRequest } from './executor-contract.js'
import { encodeFrame, readSingleFrame } from './unix-frame.js'
import type { Server, Socket } from 'node:net'
import { ExecutorExecutionError, type ExecutorPort } from './hermes-executor.js'
import type { SocketSecurityPort } from './socket-security.js'
import {cancelledEnvelope,validateCancelRequest} from './executor-cancellation.js'
import {ExecutionLeaseChallenges,RunningExecutionLease,validateLeaseCommand,validateLeaseGrant,type ExecutionLeaseGrant} from './execution-lease.js'
import type {ExecutorGuardianPort} from './executor-guardian-client.js'

export interface UnixExecutorServerOptions {
  socketPath: string
  executor: ExecutorPort
  frameTimeoutMs: number
  security?: SocketSecurityPort
  requireExecutionLease?:boolean
  guardian?:ExecutorGuardianPort
}

export class UnixExecutorServer {
  private server: Server | undefined
  private busy = false
  private accepting = false
  private stopping:Promise<void>|undefined
  private activeFinished:Promise<void>|undefined
  private pending = new Set<Socket>()
  private cancellations = new Map<string,number>()
  private cancellationSaturationUntil = 0
  private challenges=new ExecutionLeaseChallenges()
  private closingLeases=new Set<string>()
  private leaseOperations=new Set<Promise<unknown>>()
  private active:{requestId:string;missionId:string;assignmentId:string;controller:AbortController;lease?:RunningExecutionLease}|undefined

  constructor(private readonly options: UnixExecutorServerOptions) {
    if(options.guardian&&!options.requireExecutionLease)throw Error('EXECUTOR_LEASE_REQUIRED')
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
      this.pending.add(socket)
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
      this.accepting = true
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
    if(this.stopping)return this.stopping
    const server = this.server
    if (!server) return
    this.accepting = false
    const draining=this.activeFinished
    this.active?.controller.abort()
    this.options.guardian?.close()
    this.challenges.clear()
    // A connected but incomplete request must not start after shutdown begins.
    for(const socket of this.pending)socket.destroy()
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    this.stopping=Promise.all([closed,draining]).then(()=>undefined).finally(()=>{this.server=undefined;this.stopping=undefined})
    return this.stopping
  }

  private async handle(socket: Socket): Promise<void> {
    socket.on('error', () => {})
    let requestId = 'invalid-request'
    let requestValidated = false
    let guardianEngaged = false
    try {
      const frame = await readSingleFrame(
        socket,
        undefined,
        this.options.frameTimeoutMs,
        process.platform !== 'win32',
      )
      this.pending.delete(socket)
      requestId = requestIdFromFrame(frame) ?? requestId
      if(!this.accepting){
        socket.end(encodeFrame(errorResponse(requestId,'EXECUTOR_STOPPING',false,'not_started')))
        return
      }
      const frameType=frame&&typeof frame==='object'?(frame as Record<string,unknown>).type:undefined
      if(frameType==='lease_challenge'||frameType==='lease_renew'){
        const command=validateLeaseCommand(frame,frameType),active=this.active
        const key=`${command.target_request_id}:${command.mission_id}:${command.assignment_id}`
        if(this.closingLeases.has(key)){
          socket.end(encodeFrame({request_id:command.request_id,type:'lease_closing_result'}));return
        }
        const operation=(async()=>{
        const matched=active&&command.target_request_id===active.requestId&&command.mission_id===active.missionId&&command.assignment_id===active.assignmentId
        if(active&&!matched)throw Error('EXECUTOR_LEASE_DENIED')
        if(frameType==='lease_challenge'){
          if(active?.lease&&!active.lease.live())throw Error('EXECUTOR_LEASE_EXPIRED')
          const issued=performance.now()
          const guardianId=await this.options.guardian?.challenge({target_request_id:command.target_request_id,mission_id:command.mission_id,assignment_id:command.assignment_id})
          if(!this.accepting||this.active!==active)throw Error('EXECUTOR_LEASE_DENIED')
          const challenge_id=this.challenges.issue(command,guardianId,issued)
          socket.end(encodeFrame({request_id:command.request_id,type:'lease_challenge_result',challenge_id}));return
        }
        if(!matched||!active.lease)throw Error('EXECUTOR_LEASE_DENIED')
        try{const grant=command.execution_lease!,deadline=this.challenges.consume(command,grant)
          await this.options.guardian?.renew({target_request_id:command.target_request_id,mission_id:command.mission_id,assignment_id:command.assignment_id},grant)
          active.lease.renew(grant,deadline)}
        catch(error){active.controller.abort();throw error}
        socket.end(encodeFrame({request_id:command.request_id,type:'lease_renew_result',renewed:true}));return
        })()
        this.leaseOperations.add(operation)
        try{await operation}finally{this.leaseOperations.delete(operation)}
        return
      }
      if(frameType==='cancel'){
        const cancel=validateCancelRequest(frame),active=this.active
        // Different IPC connections can be scheduled out of order. Remember an
        // exact cancellation for the maximum lifetime of an incomplete frame.
        // This bounded cache is not persistent execution idempotency/authority.
        this.rememberCancellation(cancel.target_request_id,cancel.mission_id,cancel.assignment_id)
        const matched=!!active&&cancel.target_request_id===active.requestId&&cancel.mission_id===active.missionId&&cancel.assignment_id===active.assignmentId
        if(matched)active.controller.abort()
        socket.end(encodeFrame({request_id:cancel.request_id,type:'cancel_result',status:matched?'accepted':'not_running'}))
        return
      }
      let executeFrame=frame,grant:ExecutionLeaseGrant|undefined
      if(frame&&typeof frame==='object'&&Object.hasOwn(frame,'execution_lease')){
        const {execution_lease,...rest}=frame as Record<string,unknown>
        grant=validateLeaseGrant(execution_lease);executeFrame=rest
      }
      if(this.options.requireExecutionLease&&!grant)throw Error('EXECUTOR_LEASE_REQUIRED')
      const request = validateExecuteRequest(executeFrame)
      requestId = request.request_id
      if(this.cancelled(requestId,request.mission_id,request.assignment_id)){
        socket.end(encodeFrame(errorResponse(requestId,'HERMES_CANCELLED',false,'not_started')))
        return
      }
      if (this.busy) {
        socket.end(
          encodeFrame(
            errorResponse(requestId, 'EXECUTOR_BUSY', true, 'not_started'),
          ),
        )
        return
      }
      if(this.options.guardian&&this.closingLeases.size>=1024)throw Error('EXECUTOR_LEASE_CAPACITY')
      const controller=new AbortController()
      const binding={target_request_id:requestId,mission_id:request.mission_id,assignment_id:request.assignment_id}
      const lease=grant?new RunningExecutionLease(grant,this.challenges.consume(binding,grant),controller):undefined
      if(lease&&!lease.live()){lease.close();throw Error('EXECUTOR_LEASE_EXPIRED')}
      this.busy = true
      let finished!:()=>void
      this.activeFinished=new Promise<void>(resolve=>{finished=resolve})
      this.active={requestId,missionId:request.mission_id,assignmentId:request.assignment_id,controller,lease}
      // `end` is ordinary request EOF, not cancellation. Only a separate bound
      // cancel message, server stop or transport error aborts the computation.
      const transportFailed=()=>controller.abort()
      socket.once('error',transportFailed)
      try {
        if(grant&&this.options.guardian){guardianEngaged=true;await this.options.guardian.begin(binding,grant)}
        if(lease&&!lease.live())throw Error('EXECUTOR_LEASE_EXPIRED')
        const { request_id: _requestId, type: _type, ...input } = request
        requestValidated = true
        const completed = await this.options.executor.execute(input,{signal:controller.signal,leaseLive:lease?()=>lease.live():undefined})
        if(grant){
          // Admission closes synchronously; drain already accepted renewals
          // before cleanup. No RPC may touch the guardian after its finish ACK.
          this.closingLeases.add(`${requestId}:${request.mission_id}:${request.assignment_id}`)
          await Promise.all(this.leaseOperations)
          await this.options.guardian?.finish(binding)
        }
        lease?.live()
        const envelope = controller.signal.aborted ? cancelledEnvelope(completed,input) : completed
        socket.end(
          encodeFrame({
            request_id: requestId,
            type: 'result',
            ok: true,
            envelope,
          }),
        )
      } finally {
        lease?.close()
        this.challenges.discard(binding)
        socket.off('error',transportFailed)
        this.active=undefined
        this.busy = false
        this.activeFinished=undefined
        finished()
      }
    } catch (error) {
      // Without cleanup acknowledgement the guardian must terminate the
      // namespace; no next assignment or positive result may be admitted.
      if(guardianEngaged&&this.options.guardian){this.accepting=false;this.options.guardian.close()}
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
    }finally{
      this.pending.delete(socket)
    }
  }

  private rememberCancellation(request:string,mission:string,assignment:string):void {
    const now=performance.now()
    for(const [key,expiry] of this.cancellations)if(expiry<=now)this.cancellations.delete(key)
    const key=`${request}:${mission}:${assignment}`
    if(this.cancellations.has(key)||this.cancellations.size<1024)this.cancellations.set(key,now+this.options.frameTimeoutMs)
    // Never evict a live cancellation to make room. On saturation deny all
    // starts for a frame lifetime, so an unrecorded cancellation cannot be lost.
    else this.cancellationSaturationUntil=now+this.options.frameTimeoutMs
  }

  private cancelled(request:string,mission:string,assignment:string):boolean {
    const now=performance.now()
    return this.cancellationSaturationUntil>now||(this.cancellations.get(`${request}:${mission}:${assignment}`)??0)>now
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
      'EXECUTOR_LEASE_REQUIRED',
      'EXECUTOR_LEASE_EXPIRED',
      'EXECUTOR_LEASE_INVALID',
      'EXECUTOR_LEASE_CAPACITY',
      'EXECUTOR_LEASE_DENIED',
      'EXECUTOR_GUARDIAN_REQUIRED',
      'EXECUTOR_GUARDIAN_UNAVAILABLE',
      'EXECUTOR_GUARDIAN_FRAME',
      'IPC_FRAME_LENGTH',
      'IPC_FRAME_TOO_LARGE',
      'IPC_FRAME_TRUNCATED',
      'IPC_FRAME_TRAILING',
      'IPC_FRAME_JSON',
      'IPC_FRAME_TIMEOUT',
      'UNKNOWN_PROFILE',
      'INVALID_EXECUTOR_CANCEL',
      'HERMES_CANCELLED',
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
      'HERMES_USAGE_SHAPE_INVALID',
      'HERMES_USAGE_KEYS_INVALID',
      'HERMES_USAGE_COUNTS_INVALID',
      'HERMES_USAGE_TOTAL_MISMATCH',
      'HERMES_USAGE_BUDGET_EXCEEDED',
      'HERMES_USAGE_MODEL_MISMATCH',
      'HERMES_USAGE_PROVIDER_MISMATCH',
      'HERMES_USAGE_COST_SOURCE_INVALID',
      'HERMES_USAGE_SESSION_ID_INVALID',
      'HERMES_USAGE_SERVICE_TIER_INVALID',
      'HERMES_USAGE_COST_INVALID',
      'INVALID_USAGE_RESERVATION',
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
