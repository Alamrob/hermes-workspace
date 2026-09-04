import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createConnection} from 'node:net'
import type {Server,Socket} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {cancelledEnvelope,validateCancelRequest,validateCancelResponse} from '../src/executor-cancellation.js'
import {ExecutorExecutionError,NodeProcessRunner,type ExecutorPort} from '../src/hermes-executor.js'
import type {ExecutorEnvelope} from '../src/hermes-executor.js'
import {reconcileAgentResult} from '../src/agent-result.js'
import {OPENCODE_GO_PRICING_SNAPSHOT} from '../src/opencode-go-pricing.js'
import {UnixExecutorClient,ExecutorTransportError} from '../src/unix-executor-client.js'
import {UnixExecutorServer} from '../src/unix-executor-server.js'
import {encodeFrame,readSingleFrame} from '../src/unix-frame.js'
import type {ExecuteInput} from '../src/executor-contract.js'

const input:ExecuteInput={mission_id:randomUUID(),trace_id:randomUUID(),assignment_id:randomUUID(),profile_id:'sales-orchestrator',execution_timeout_ms:30000,instruction:'Synthetic local analysis only.',evidence:{trust:'untrusted_data',content:'Synthetic.'},execution_policy:{autonomy_level:'A1',allowed_actions:['analysis.internal'],approved_channels:['internal'],approved_tools:['hermes.analysis']},reservation:{maximum_tokens:100,maximum_api_calls:1,budget_reservation:{currency:'USD',amount:0.01}}}
const path=()=>process.platform==='win32'?`\\\\.\\pipe\\cancel-${randomUUID()}`:join(tmpdir(),`cancel-${randomUUID()}.sock`)
const cancel=(target:string)=>({request_id:randomUUID(),type:'cancel',target_request_id:target,mission_id:input.mission_id,assignment_id:input.assignment_id})
async function rpc(socketPath:string,frame:unknown){
  const socket=createConnection({path:socketPath,allowHalfOpen:true}),strict=process.platform!=='win32'
  const result=readSingleFrame(socket,undefined,3000,strict)
  socket.once('connect',()=>{if(strict)socket.end(encodeFrame(frame));else socket.write(encodeFrame(frame))})
  try{return await result as any}finally{socket.destroy()}
}
function cooperative(){
  let started!:()=>void,aborted=false,signal:AbortSignal|undefined
  const ready=new Promise<void>(resolve=>{started=resolve})
  const executor:ExecutorPort={execute:async(_input,ctx)=>{
    signal=ctx?.signal;assert.ok(signal);started()
    await new Promise<void>(resolve=>{if(signal!.aborted)resolve();else signal!.addEventListener('abort',()=>resolve(),{once:true})})
    // Stand-in only for a child that has already verified its group is gone.
    aborted=true;throw new ExecutorExecutionError('HERMES_CANCELLED','finished')
  }}
  return{executor,ready,get aborted(){return aborted},get signal(){return signal}}
}

function completedEnvelope():ExecutorEnvelope {
  const usage:ExecutorEnvelope['usage']={tokens:{input:1,output:2,cache_read:0,cache_write:0,reasoning:0,total:3},api_calls:1,model:'deepseek-v4-flash',provider:'opencode-go',completed:true,failed:false,cost:{status:'known',usage_value_usd:0.001,cash_cost_usd:0,source:'official_docs_snapshot',pricing_snapshot_id:OPENCODE_GO_PRICING_SNAPSHOT.id}}
  const at='2026-09-03T00:00:00Z'
  const agent_result=reconcileAgentResult({mission_id:input.mission_id,trace_id:input.trace_id,assignment_id:input.assignment_id,agent_id:input.profile_id,status:'completed',summary:'Synthetic result.',facts:[],inferences:[],actions_taken:[],external_changes:[],evidence:[],artifacts:[],metrics:{},cost:{currency:'USD',llm:0,tools:0,total:0,input_tokens:0,output_tokens:0},errors:[],risks:[],pending_approvals:[],recommended_next_actions:[],started_at:at,finished_at:at},input,usage,input.reservation.budget_reservation,at,at)
  return{schema_version:'1.0',agent_result,usage}
}

test('cancellation before the execute frame is complete prevents any invocation',async()=>{
  const socketPath=path();let calls=0
  const server=new UnixExecutorServer({socketPath,executor:{execute:async()=>{calls++;return completedEnvelope()}},frameTimeoutMs:3000})
  await server.start()
  const socket=createConnection({path:socketPath,allowHalfOpen:true}),id=randomUUID(),frame=encodeFrame({request_id:id,type:'execute',...input})
  socket.on('error',()=>{})
  const response=readSingleFrame(socket,undefined,3000,process.platform!=='win32')
  try{
    await new Promise<void>(resolve=>socket.once('connect',()=>{socket.write(frame.subarray(0,8),()=>resolve())}))
    assert.equal((await rpc(socketPath,cancel(id))).status,'not_running')
    if(process.platform==='win32')socket.write(frame.subarray(8));else socket.end(frame.subarray(8))
    const result=await response as any
    assert.equal(result.error.code,'HERMES_CANCELLED');assert.equal(result.error.execution_state,'not_started');assert.equal(calls,0)
  }finally{socket.destroy();await server.stop()}
})

test('stop discards connected incomplete requests and repeated stop cannot start work',async()=>{
  const socketPath=path();let calls=0
  const server=new UnixExecutorServer({socketPath,executor:{execute:async()=>{calls++;return completedEnvelope()}},frameTimeoutMs:3000})
  await server.start()
  const socket=createConnection({path:socketPath,allowHalfOpen:true});socket.on('error',()=>{})
  const frame=encodeFrame({request_id:randomUUID(),type:'execute',...input})
  const rejected=assert.rejects(readSingleFrame(socket,undefined,3000,process.platform!=='win32'))
  try{
    await new Promise<void>(resolve=>socket.once('connect',()=>socket.write(frame.subarray(0,8),()=>resolve())))
    // Server callback has run before this barrier connection is answered.
    await rpc(socketPath,cancel(randomUUID()))
    await Promise.all([server.stop(),server.stop()]);socket.end(frame.subarray(8));await rejected
    assert.equal(calls,0)
  }finally{socket.destroy();await server.stop()}
})

test('stop waits for active cleanup even after its server-side socket has disappeared',async()=>{
  const socketPath=path();let ready!:()=>void,release!:()=>void,peer:Socket|undefined,finished=false,stopped=false
  const entered=new Promise<void>(r=>{ready=r}),barrier=new Promise<void>(r=>{release=r})
  const server=new UnixExecutorServer({socketPath,executor:{execute:async(_input,ctx)=>{ready();await barrier;assert.equal(ctx?.signal?.aborted,true);finished=true;throw new ExecutorExecutionError('HERMES_CANCELLED','finished')}},frameTimeoutMs:3000})
  await server.start()
  // Test-only fault injection into the real accepted IPC socket, not a public API.
  ;(server as unknown as {server:Server}).server.once('connection',socket=>{peer=socket})
  const lost=assert.rejects(rpc(socketPath,{request_id:randomUUID(),type:'execute',...input}))
  try{
    await entered;assert.ok(peer);peer.destroy();await lost
    const stopping=server.stop().then(()=>{stopped=true})
    await delay(20);assert.equal(stopped,false);assert.equal(finished,false)
    release();await stopping;assert.equal(finished,true);assert.equal(stopped,true)
  }finally{release();await server.stop();await lost}
})

test('accepted cancellation during asynchronous cleanup keeps known usage but rejects success',async()=>{
  const socketPath=path();let ready!:()=>void,release!:()=>void
  const entered=new Promise<void>(r=>{ready=r}),barrier=new Promise<void>(r=>{release=r})
  const server=new UnixExecutorServer({socketPath,executor:{execute:async()=>{ready();await barrier;return completedEnvelope()}},frameTimeoutMs:3000})
  await server.start()
  try{
    const id=randomUUID(),result=rpc(socketPath,{request_id:id,type:'execute',...input});await entered
    assert.equal((await rpc(socketPath,cancel(id))).status,'accepted');release()
    const response=await result
    assert.equal(response.ok,true) // Transport delivered a failed business result.
    assert.equal(response.envelope.agent_result.status,'failed')
    assert.equal(response.envelope.agent_result.errors[0].code,'HERMES_CANCELLED')
    assert.deepEqual(response.envelope.usage,completedEnvelope().usage)
    assert.equal(response.envelope.agent_result.metrics.provider_usage_value_usd,0.001)
  }finally{release();await server.stop()}
})

test('local abort at response acceptance cannot return commercial success',async()=>{
  const socketPath=path(),controller=new AbortController()
  const server=new UnixExecutorServer({socketPath,executor:{execute:async()=>completedEnvelope()},frameTimeoutMs:3000})
  await server.start()
  try{
    const value=await new UnixExecutorClient({socketPath,timeoutMs:2500,onPhase:phase=>{if(phase==='executor_ipc_response_received')controller.abort()}}).execute(input,{signal:controller.signal})
    assert.equal(value.agent_result.status,'failed');assert.deepEqual(value.usage,completedEnvelope().usage)
  }finally{await server.stop()}
})

test('cancelled result is idempotent and retains only trusted usage, not model conclusions',()=>{
  const original=completedEnvelope(),cancelled=cancelledEnvelope(original,input)
  assert.deepEqual(cancelledEnvelope(cancelled,input),cancelled)
  assert.equal(original.agent_result.status,'completed');assert.deepEqual(cancelled.usage,original.usage)
  assert.deepEqual(cancelled.agent_result.facts,[]);assert.equal(cancelled.agent_result.metrics.runtime_output_accepted,false)
})

test('cancellation cache saturation fails closed without evicting a live cancellation',async()=>{
  const socketPath=path();let calls=0
  const server=new UnixExecutorServer({socketPath,executor:{execute:async()=>{calls++;return completedEnvelope()}},frameTimeoutMs:60000})
  await server.start()
  try{
    const first=randomUUID();await rpc(socketPath,cancel(first))
    for(let i=0;i<1024;i++)await rpc(socketPath,cancel(randomUUID()))
    for(const id of [first,randomUUID()]){
      const result=await rpc(socketPath,{request_id:id,type:'execute',...input})
      assert.equal(result.error.execution_state,'not_started');assert.equal(result.error.code,'HERMES_CANCELLED')
    }
    assert.equal(calls,0)
  }finally{await server.stop()}
})
test('closed cancellation contract rejects PID, extra authority, wrong binding and malformed IDs',()=>{
  const request=cancel(randomUUID());assert.deepEqual(validateCancelRequest(request),request)
  for(const value of [null,{...request,pid:12},{...request,mission_id:'*'},{...request,request_id:request.target_request_id},{...request,type:'execute'},{...request,approval_token:'forged'}])assert.throws(()=>validateCancelRequest(value),/INVALID_EXECUTOR_CANCEL/)
  assert.equal(validateCancelResponse({request_id:request.request_id,type:'cancel_result',status:'accepted'},request.request_id),'accepted')
  assert.throws(()=>validateCancelResponse({request_id:request.request_id,type:'cancel_result',status:'terminated'},request.request_id),/INVALID_EXECUTOR_CANCEL_RESPONSE/)
})
test('pre-aborted IPC starts no connection or executor',async()=>{
  const controller=new AbortController();controller.abort()
  await assert.rejects(new UnixExecutorClient({socketPath:path(),timeoutMs:100}).execute(input,{signal:controller.signal}),e=>e instanceof ExecutorTransportError&&e.executionState==='not_started'&&!e.recoverable)
})
test('normal execute EOF does not cancel; separate exact cancellation works while busy',async()=>{
  const socketPath=path(),work=cooperative(),server=new UnixExecutorServer({socketPath,executor:work.executor,frameTimeoutMs:1000})
  await server.start();const original=randomUUID()
  try{
    const result=rpc(socketPath,{request_id:original,type:'execute',...input})
    await work.ready;assert.equal(work.signal?.aborted,false)
    for(const wrong of [{target_request_id:randomUUID()},{mission_id:randomUUID()},{assignment_id:randomUUID()}]){
      const req={...cancel(original),...wrong};assert.equal((await rpc(socketPath,req)).status,'not_running');assert.equal(work.signal?.aborted,false)
    }
    const req=cancel(original);assert.equal((await rpc(socketPath,req)).status,'accepted')
    const final=await result;assert.equal(final.error.code,'HERMES_CANCELLED');assert.equal(final.error.execution_state,'finished');assert.equal(work.aborted,true)
    assert.equal((await rpc(socketPath,cancel(original))).status,'not_running')
  }finally{await server.stop()}
})
test('AbortSignal uses second connection and waits for terminal executor response',async()=>{
  const socketPath=path(),work=cooperative(),server=new UnixExecutorServer({socketPath,executor:work.executor,frameTimeoutMs:1000}),controller=new AbortController()
  await server.start()
  try{
    const result=new UnixExecutorClient({socketPath,timeoutMs:2500}).execute(input,{signal:controller.signal})
    const rejected=assert.rejects(result,e=>e instanceof ExecutorTransportError&&e.code==='HERMES_CANCELLED'&&e.executionState==='finished'&&!e.recoverable)
    await work.ready;controller.abort();await rejected;assert.equal(work.aborted,true)
  }finally{await server.stop()}
})
test('server shutdown aborts active computation before closing connections',async()=>{
  const socketPath=path(),work=cooperative(),server=new UnixExecutorServer({socketPath,executor:work.executor,frameTimeoutMs:1000})
  await server.start()
  const rejected=assert.rejects(new UnixExecutorClient({socketPath,timeoutMs:2500}).execute(input),e=>e instanceof ExecutorTransportError&&e.executionState==='finished')
  await work.ready;await server.stop();await rejected;assert.equal(work.aborted,true)
})
test('IPC timeout requests exact cancellation but does not claim acknowledgement proves usage',async()=>{
  const socketPath=path(),work=cooperative(),server=new UnixExecutorServer({socketPath,executor:work.executor,frameTimeoutMs:1000})
  await server.start()
  try{
    await assert.rejects(new UnixExecutorClient({socketPath,timeoutMs:100}).execute(input),e=>e instanceof ExecutorTransportError&&e.executionState==='unknown')
    for(let n=0;n<20&&!work.aborted;n++)await delay(10)
    assert.equal(work.aborted,true)
  }finally{await server.stop()}
})
test('late cancellation cannot stop a subsequent request with the same assignment',async()=>{
  const socketPath=path();let current=cooperative()
  const server=new UnixExecutorServer({socketPath,executor:{execute:(value,ctx)=>current.executor.execute(value,ctx)},frameTimeoutMs:1000})
  await server.start()
  try{
    const old=randomUUID(),first=rpc(socketPath,{request_id:old,type:'execute',...input});await current.ready
    await rpc(socketPath,cancel(old));await first
    current=cooperative();const next=randomUUID(),second=rpc(socketPath,{request_id:next,type:'execute',...input});await current.ready
    assert.equal((await rpc(socketPath,cancel(old))).status,'not_running');assert.equal(current.signal?.aborted,false)
    await rpc(socketPath,cancel(next));await second
  }finally{await server.stop()}
})
test('runner abort before spawn is proved not-started, even with a nonexistent command',async()=>{
  const controller=new AbortController();controller.abort()
  await assert.rejects(new NodeProcessRunner().run({command:'/does-not-exist',args:[],env:{},uid:10001,gid:10001,shell:false,detached:true,cwd:tmpdir(),timeoutMs:100,stdoutLimitBytes:100,stderrLimitBytes:100,signal:controller.signal}),e=>e instanceof ExecutorExecutionError&&e.executionState==='not_started')
})
