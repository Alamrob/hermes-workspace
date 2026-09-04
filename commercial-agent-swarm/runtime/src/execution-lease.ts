import {randomUUID} from 'node:crypto'

export const EXECUTION_LEASE_MAX_MS=5000
export interface ExecutionPermit {
  allowed:true
  job_id:string
  mission_id:string
  worker_id:string
  window_id:string
  epoch_id:string
  budget_version:number
  valid_for_ms:number
}
export type ExecutionPermitSource=()=>Promise<ExecutionPermit>
export interface ExecutionLeaseGrant extends ExecutionPermit {challenge_id:string}
export interface LeaseBinding {target_request_id:string;mission_id:string;assignment_id:string}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const permitKeys=['allowed','job_id','mission_id','worker_id','window_id','epoch_id','budget_version','valid_for_ms']
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('EXECUTOR_LEASE_INVALID')
  return value as Record<string,unknown>
}
function exact(value:Record<string,unknown>,keys:string[]){
  if(Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error('EXECUTOR_LEASE_INVALID')
}
export function validateExecutionPermit(value:unknown):ExecutionPermit{
  const v=object(value);exact(v,[...permitKeys])
  if(v.allowed!==true||['job_id','mission_id','window_id','epoch_id'].some(k=>typeof v[k]!=='string'||!uuid.test(v[k] as string))||typeof v.worker_id!=='string'||!/^[A-Za-z0-9._:-]{3,128}$/.test(v.worker_id)||
    !Number.isSafeInteger(v.budget_version)||Number(v.budget_version)<1||!Number.isSafeInteger(v.valid_for_ms)||Number(v.valid_for_ms)<1||Number(v.valid_for_ms)>EXECUTION_LEASE_MAX_MS)throw Error('EXECUTOR_LEASE_DENIED')
  return v as unknown as ExecutionPermit
}
export function validateLeaseGrant(value:unknown):ExecutionLeaseGrant{
  const v=object(value);exact(v,[...permitKeys,'challenge_id'])
  if(typeof v.challenge_id!=='string'||!uuid.test(v.challenge_id))throw Error('EXECUTOR_LEASE_INVALID')
  const {challenge_id,...permit}=v
  return{...validateExecutionPermit(permit),challenge_id}
}
export function validateLeaseCommand(value:unknown,type:'lease_challenge'|'lease_renew'):{request_id:string;type:string}&LeaseBinding&{execution_lease?:ExecutionLeaseGrant}{
  const v=object(value);exact(v,['request_id','type','target_request_id','mission_id','assignment_id',...(type==='lease_renew'?['execution_lease']:[])])
  if(v.type!==type||['request_id','target_request_id','mission_id','assignment_id'].some(k=>typeof v[k]!=='string'||!uuid.test(v[k] as string))||v.request_id===v.target_request_id)throw Error('EXECUTOR_LEASE_INVALID')
  if(type==='lease_renew')validateLeaseGrant(v.execution_lease)
  return v as unknown as {request_id:string;type:string}&LeaseBinding&{execution_lease?:ExecutionLeaseGrant}
}
export function validateLeaseReply(value:unknown,id:string,type:'lease_challenge_result'|'lease_renew_result'):string|undefined{
  const v=object(value);exact(v,['request_id','type',...(type==='lease_challenge_result'?['challenge_id']:['renewed'])])
  if(v.request_id!==id||v.type!==type)throw Error('EXECUTOR_LEASE_INVALID')
  if(type==='lease_renew_result'){if(v.renewed!==true)throw Error('EXECUTOR_LEASE_DENIED');return}
  if(typeof v.challenge_id!=='string'||!uuid.test(v.challenge_id))throw Error('EXECUTOR_LEASE_INVALID')
  return v.challenge_id
}
// Terminal transport notice, never an authority grant or a deadline extension.
export function isLeaseClosingReply(value:unknown,id:string):boolean{
  if(!value||typeof value!=='object'||(value as Record<string,unknown>).type!=='lease_closing_result')return false
  const v=object(value);exact(v,['request_id','type'])
  if(v.request_id!==id)throw Error('EXECUTOR_LEASE_INVALID')
  return true
}
export function sameLeaseIdentity(a:ExecutionPermit,b:ExecutionPermit):boolean{
  return a.job_id===b.job_id&&a.mission_id===b.mission_id&&a.worker_id===b.worker_id&&a.window_id===b.window_id&&a.epoch_id===b.epoch_id&&a.budget_version===b.budget_version
}
const key=(binding:LeaseBinding)=>`${binding.target_request_id}:${binding.mission_id}:${binding.assignment_id}`

// Server challenge precedes the authoritative SQL read. Anchor to its creation,
// never to delayed grant arrival; no synchronized clocks are required.
export class ExecutionLeaseChallenges {
  private challenges=new Map<string,{key:string;issued:number}>()
  constructor(private readonly now:()=>number=()=>performance.now()){}
  issue(binding:LeaseBinding,externalId?:string,issuedAt?:number):string{
    const now=this.now()
    for(const [id,c] of this.challenges)if(c.issued+EXECUTION_LEASE_MAX_MS<=now)this.challenges.delete(id)
    if(this.challenges.size>=64)throw Error('EXECUTOR_LEASE_CAPACITY')
    const id=externalId??randomUUID(),issued=issuedAt??now
    if(!uuid.test(id)||this.challenges.has(id)||!Number.isFinite(issued)||issued>now||issued+EXECUTION_LEASE_MAX_MS<=now)throw Error('EXECUTOR_LEASE_INVALID')
    this.challenges.set(id,{key:key(binding),issued});return id
  }
  consume(binding:LeaseBinding,grant:ExecutionLeaseGrant):number{
    const c=this.challenges.get(grant.challenge_id);this.challenges.delete(grant.challenge_id)
    if(!c||c.key!==key(binding)||grant.job_id!==binding.assignment_id||grant.mission_id!==binding.mission_id||c.issued+grant.valid_for_ms<=this.now())throw Error('EXECUTOR_LEASE_EXPIRED')
    return c.issued+grant.valid_for_ms
  }
  discard(binding:LeaseBinding){for(const [id,c] of this.challenges)if(c.key===key(binding))this.challenges.delete(id)}
  clear(){this.challenges.clear()}
}

export class RunningExecutionLease {
  private timer:ReturnType<typeof setTimeout>|undefined
  private closed=false
  constructor(readonly identity:ExecutionPermit,private deadline:number,private readonly controller:AbortController){this.arm()}
  live():boolean{
    if(this.closed||this.controller.signal.aborted)return false
    if(performance.now()>=this.deadline){this.controller.abort();return false}
    return true
  }
  renew(grant:ExecutionPermit,deadline:number):void{
    if(!this.live()||!sameLeaseIdentity(this.identity,grant)||deadline<=performance.now())throw Error('EXECUTOR_LEASE_EXPIRED')
    this.deadline=deadline;this.arm()
  }
  close():void{this.closed=true;if(this.timer)clearTimeout(this.timer)}
  private arm(){
    if(this.timer)clearTimeout(this.timer)
    if(!this.live())return
    this.timer=setTimeout(()=>{if(this.live())this.arm()},Math.max(1,this.deadline-performance.now()))
  }
}
