import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createConnection} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {ExecutionLeaseChallenges,RunningExecutionLease,validateExecutionPermit,validateLeaseGrant,type ExecutionPermit} from '../src/execution-lease.js'
import {UnixExecutorServer} from '../src/unix-executor-server.js'
import {UnixExecutorClient,ExecutorTransportError} from '../src/unix-executor-client.js'
import {ExecutorExecutionError,type ExecutorPort} from '../src/hermes-executor.js'
import {encodeFrame,readSingleFrame} from '../src/unix-frame.js'
import {PostgresExecutionPermitReader} from '../src/postgres-execution-permit.js'
import type {ExecuteInput} from '../src/executor-contract.js'

const input:ExecuteInput={mission_id:randomUUID(),trace_id:randomUUID(),assignment_id:randomUUID(),profile_id:'sales-orchestrator',execution_timeout_ms:30000,instruction:'Synthetic only.',evidence:{trust:'untrusted_data',content:'Synthetic.'},execution_policy:{autonomy_level:'A1',allowed_actions:['analysis.internal'],approved_channels:['internal'],approved_tools:['hermes.analysis']},reservation:{maximum_tokens:100,maximum_api_calls:1,budget_reservation:{currency:'USD',amount:0.01}}}
const permit:ExecutionPermit={allowed:true,job_id:input.assignment_id,mission_id:input.mission_id,worker_id:'broker-dispatcher-1',window_id:randomUUID(),epoch_id:randomUUID(),budget_version:1,valid_for_ms:500}
const binding={target_request_id:randomUUID(),mission_id:input.mission_id,assignment_id:input.assignment_id}
const socketPath=()=>process.platform==='win32'?`\\\\.\\pipe\\lease-${randomUUID()}`:join(tmpdir(),`lease-${randomUUID()}.sock`)
async function rpc(path:string,frame:unknown){const socket=createConnection({path,allowHalfOpen:true}),strict=process.platform!=='win32',result=readSingleFrame(socket,4096,3000,strict);socket.once('connect',()=>{if(strict)socket.end(encodeFrame(frame));else socket.write(encodeFrame(frame))});try{return await result as any}finally{socket.destroy()}}
function worker(){
  let calls=0,aborted=false,started!:()=>void;const ready=new Promise<void>(r=>{started=r})
  const executor:ExecutorPort={execute:async(_input,ctx)=>{calls++;assert.ok(ctx?.leaseLive?.());started();await new Promise<void>(r=>{if(ctx?.signal?.aborted)r();else ctx?.signal?.addEventListener('abort',()=>r(),{once:true})});aborted=true;throw new ExecutorExecutionError('HERMES_CANCELLED','finished')}}
  return{executor,ready,get calls(){return calls},get aborted(){return aborted}}
}

test('lease schemas deny missing, expanded, cross-authority and overlong grants',()=>{
  assert.deepEqual(validateExecutionPermit(permit),permit)
  for(const v of [{allowed:false},{...permit,valid_for_ms:5001},{...permit,valid_for_ms:0},{...permit,valid_for_ms:1.5},{...permit,budget_version:0},{...permit,job_id:'*'},{...permit,price:0}])assert.throws(()=>validateExecutionPermit(v),/EXECUTOR_LEASE_/)
  assert.throws(()=>validateLeaseGrant({...permit,challenge_id:'*'}),/EXECUTOR_LEASE_INVALID/)
})
test('challenge deadline starts before SQL, rejects replay, crossing and delayed responses',()=>{
  let now=100;const challenges=new ExecutionLeaseChallenges(()=>now)
  const id=challenges.issue(binding);now=300
  assert.equal(challenges.consume(binding,{...permit,challenge_id:id}),600)
  assert.throws(()=>challenges.consume(binding,{...permit,challenge_id:id}),/EXPIRED/)
  const cross=challenges.issue(binding)
  assert.throws(()=>challenges.consume({...binding,assignment_id:randomUUID()},{...permit,challenge_id:cross}),/EXPIRED/)
  const stale=challenges.issue(binding);now+=501
  assert.throws(()=>challenges.consume(binding,{...permit,challenge_id:stale}),/EXPIRED/)
})
test('challenge capacity fails closed and cleanup never evicts live challenges',()=>{
  let now=0;const c=new ExecutionLeaseChallenges(()=>now),first=c.issue(binding)
  for(let i=1;i<64;i++)c.issue(binding)
  assert.throws(()=>c.issue(binding),/CAPACITY/);assert.equal(c.consume(binding,{...permit,challenge_id:first}),500)
  c.issue(binding);now=5001;assert.doesNotThrow(()=>c.issue(binding));c.clear()
})
test('expired running lease cannot be revived and changed generation cannot renew',async()=>{
  const controller=new AbortController(),lease=new RunningExecutionLease(permit,performance.now()+25,controller)
  await delay(40);assert.equal(controller.signal.aborted,true)
  assert.throws(()=>lease.renew(permit,performance.now()+500),/EXPIRED/);lease.close()
  const other=new RunningExecutionLease(permit,performance.now()+500,new AbortController())
  assert.throws(()=>other.renew({...permit,epoch_id:randomUUID()},performance.now()+500),/EXPIRED/);other.close()
})
test('mandatory client and receiver refuse legacy execution before any work',async()=>{
  const path=socketPath(),w=worker(),server=new UnixExecutorServer({socketPath:path,executor:w.executor,requireExecutionLease:true,frameTimeoutMs:1000})
  await server.start()
  try{
    await assert.rejects(new UnixExecutorClient({socketPath:path,timeoutMs:3000,requireExecutionLease:true}).execute(input),e=>e instanceof ExecutorTransportError&&e.code==='EXECUTOR_LEASE_REQUIRED'&&e.executionState==='not_started')
    const result=await rpc(path,{request_id:randomUUID(),type:'execute',...input});assert.equal(result.error.code,'EXECUTOR_LEASE_REQUIRED');assert.equal(result.error.execution_state,'not_started');assert.equal(w.calls,0)
  }finally{await server.stop()}
})
test('guardian recycle capacity rejects before executor or provider work',async()=>{
  const path=socketPath(),w=worker(),guardian={challenge:async()=>randomUUID(),begin:async()=>{},renew:async()=>{},finish:async()=>{},close:()=>{}},server=new UnixExecutorServer({socketPath:path,executor:w.executor,requireExecutionLease:true,guardian,frameTimeoutMs:1000})
  ;(server as unknown as {closingLeases:Set<string>}).closingLeases=new Set(Array.from({length:1024},(_,i)=>String(i)))
  await server.start()
  try{
    const challenge=await rpc(path,{request_id:randomUUID(),type:'lease_challenge',...binding})
    const result=await rpc(path,{request_id:binding.target_request_id,type:'execute',...input,execution_lease:{...permit,challenge_id:challenge.challenge_id}})
    assert.equal(result.error.code,'EXECUTOR_LEASE_CAPACITY');assert.equal(result.error.execution_state,'not_started');assert.equal(w.calls,0)
  }finally{await server.stop()}
})
test('receiver independently expires work when the broker provides no renewals',async()=>{
  const path=socketPath(),w=worker(),server=new UnixExecutorServer({socketPath:path,executor:w.executor,requireExecutionLease:true,frameTimeoutMs:1000})
  await server.start()
  try{
    const challenge=await rpc(path,{request_id:randomUUID(),type:'lease_challenge',...binding})
    const result=await rpc(path,{request_id:binding.target_request_id,type:'execute',...input,execution_lease:{...permit,challenge_id:challenge.challenge_id,valid_for_ms:150}})
    assert.equal(result.error.code,'HERMES_CANCELLED');assert.equal(w.calls,1);assert.equal(w.aborted,true)
  }finally{await server.stop()}
})
test('renewals query authority only after a fresh challenge and keep exact identity',async()=>{
  const path=socketPath(),w=worker(),controller=new AbortController(),server=new UnixExecutorServer({socketPath:path,executor:w.executor,requireExecutionLease:true,frameTimeoutMs:1000});let reads=0
  await server.start()
  try{
    const pending=assert.rejects(new UnixExecutorClient({socketPath:path,timeoutMs:4000,requireExecutionLease:true}).execute(input,{signal:controller.signal,readExecutionPermit:async()=>{reads++;return permit}}),/HERMES_CANCELLED/)
    await w.ready
    const deadline=performance.now()+2500;while(reads<3&&performance.now()<deadline)await delay(10)
    assert.ok(reads>=3);assert.equal(w.aborted,false);controller.abort();await pending
  }finally{controller.abort();await server.stop()}
})
for(const failure of ['denied','epoch','job'] as const)test(`authority ${failure} cancels the running attempt without waiting for original TTL`,async()=>{
  const path=socketPath(),w=worker(),server=new UnixExecutorServer({socketPath:path,executor:w.executor,requireExecutionLease:true,frameTimeoutMs:1000});let reads=0
  await server.start()
  try{
    const pending=new UnixExecutorClient({socketPath:path,timeoutMs:3000,requireExecutionLease:true}).execute(input,{readExecutionPermit:async()=>{if(++reads===1)return permit;if(failure==='denied')throw Error('private SQL error must not escape');return {...permit,...(failure==='epoch'?{epoch_id:randomUUID()}:{job_id:randomUUID()})}}})
    await assert.rejects(pending,e=>e instanceof ExecutorTransportError&&e.code==='HERMES_CANCELLED'&&e.executionState==='finished');assert.equal(w.aborted,true);assert.equal(w.calls,1)
  }finally{await server.stop()}
})
test('SQL reader binds identity, uses a short readonly transaction and discards broken connections',async()=>{
  const queries:any[]=[],releases:boolean[]=[];let response:unknown=permit
  const client={query:async(config:any)=>{queries.push(config);return{rowCount:1,rows:[{permit:response}]}},release:(destroy:boolean)=>releases.push(destroy)}
  const reader=new PostgresExecutionPermitReader({connect:async()=>client} as never)
  assert.deepEqual(await reader.read(permit.job_id,permit.mission_id,permit.worker_id,1),permit)
  assert.match(queries[0].text,/BEGIN READ ONLY/);assert.match(queries[0].text,/statement_timeout='1000ms'/);assert.ok(queries.every(q=>q.query_timeout===1500));assert.deepEqual(releases,[false])
  response={...permit,job_id:randomUUID()};await assert.rejects(reader.read(permit.job_id,permit.mission_id,permit.worker_id,1),/^Error: EXECUTOR_LEASE_DENIED$/)
  client.query=async()=>{throw Error('credential/private-query')}
  await assert.rejects(reader.read(permit.job_id,permit.mission_id,permit.worker_id,1),/^Error: EXECUTOR_LEASE_DENIED$/);assert.equal(releases.at(-1),true)
})
