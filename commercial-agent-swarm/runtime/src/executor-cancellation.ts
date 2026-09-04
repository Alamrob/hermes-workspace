import {reconcileAgentResult} from './agent-result.js'
import type {ExecuteInput} from './executor-contract.js'
import type {ExecutorEnvelope} from './hermes-executor.js'

// Separate one-frame IPC connection. Never append to the execute connection,
// whose write-side EOF is part of the production protocol.
export interface CancelRequest {
  request_id:string
  type:'cancel'
  target_request_id:string
  mission_id:string
  assignment_id:string
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function validateCancelRequest(value:unknown):CancelRequest {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_EXECUTOR_CANCEL')
  const v=value as Record<string,unknown>
  if(Object.keys(v).sort().join(',')!=='assignment_id,mission_id,request_id,target_request_id,type'||v.type!=='cancel'||
    ['request_id','target_request_id','mission_id','assignment_id'].some(k=>typeof v[k]!=='string'||!uuid.test(v[k] as string))||
    v.request_id===v.target_request_id)throw Error('INVALID_EXECUTOR_CANCEL')
  return v as unknown as CancelRequest
}
export function validateCancelResponse(value:unknown,id:string):'accepted'|'not_running' {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_EXECUTOR_CANCEL_RESPONSE')
  const v=value as Record<string,unknown>
  if(Object.keys(v).sort().join(',')!=='request_id,status,type'||v.request_id!==id||v.type!=='cancel_result'||
    (v.status!=='accepted'&&v.status!=='not_running'))throw Error('INVALID_EXECUTOR_CANCEL_RESPONSE')
  return v.status
}

// Cancellation wins until the caller's synchronous result-acceptance boundary.
// Do not discard trusted usage or turn an already incurred charge into zero.
export function cancelledEnvelope(envelope:ExecutorEnvelope,input:ExecuteInput):ExecutorEnvelope {
  const started=envelope.agent_result.started_at,finished=envelope.agent_result.finished_at
  const result={
    mission_id:input.mission_id,trace_id:input.trace_id,assignment_id:input.assignment_id,agent_id:input.profile_id,
    status:'failed',summary:'Execution result discarded after cancellation. Known provider usage is retained for settlement.',
    facts:[],inferences:[],actions_taken:[],external_changes:[],evidence:[],artifacts:[],
    metrics:{runtime_output_accepted:false,cancellation_requested:true},
    cost:{currency:'USD',llm:0,tools:0,total:0,input_tokens:0,output_tokens:0},
    errors:[{code:'HERMES_CANCELLED',message:'Result was cancelled before acceptance.',recoverable:false,attempts:1,next_safe_step:'Reconcile retained usage; do not retry automatically.'}],
    risks:[],pending_approvals:[],recommended_next_actions:['Reconcile retained usage; do not retry automatically.'],
    started_at:started,finished_at:finished,
  }
  return{schema_version:'1.0',usage:envelope.usage,agent_result:reconcileAgentResult(result,input,envelope.usage,input.reservation.budget_reservation,started,finished)}
}
