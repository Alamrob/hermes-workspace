import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {PostgresDispatchSettlement,SettlementUncertainError} from '../src/postgres-dispatch-settlement.js'
import {PostgresDispatchQueue} from '../src/dispatch-queue.js'

const id=randomUUID(),receiptId=randomUUID(),cost={usageValueMicroCents:10000,usageRecordId:'synthetic:usage',source:'opencode_go_native_telemetry' as const,budgetVersion:1,total_tokens:100,api_calls:1}
const receipt={receipt_id:receiptId,job_id:id,budget_version:1,status:'succeeded',result_accepted:true,reason:'ATOMIC_USAGE_SETTLED',usage_value_micro_cents:10000}
function fake(options:{stageError?:boolean,readError?:boolean,result?:unknown}={}){
  const calls:any[]=[]
  const pool={query:async(config:any)=>{calls.push(config);if(calls.length===1){if(options.stageError)throw Error('private SQL/credential');return {rowCount:1,rows:[{id:receiptId}]}}
    if(options.readError)throw Error('private credential');return{rowCount:1,rows:[{receipt:'result'in options?options.result:receipt}]}}}
  const connectionPool={connect:async()=>({...pool,release:()=>{}})} as never
  return{calls,settlement:new PostgresDispatchSettlement(connectionPool),queue:new PostgresDispatchQueue(connectionPool)}
}
test('acceptance follows exact finalized receipt, not successful staging',async()=>{
  const f=fake();assert.equal(await f.settlement.complete(id,'broker-dispatcher-1',{},'a'.repeat(64),cost),'succeeded')
  assert.equal(f.calls.length,2);assert.match(f.calls[0].text,/^CALL control\.commit_dispatch_settlement/);assert.match(f.calls[1].text,/get_dispatch_settlement/);assert.deepEqual(f.calls[0].values,f.calls[1].values)
  assert.ok(f.calls.every(c=>c.query_timeout===10000));assert.ok(f.calls.every(c=>!c.text.includes('BEGIN')))
})
test('lost stage reply after commit reconciles by read without a second write',async()=>{
  const f=fake({stageError:true});assert.equal(await f.settlement.complete(id,'broker-dispatcher-1',{},'a'.repeat(64),cost),'succeeded');assert.equal(f.calls.length,2)
})

test('default PostgreSQL queue uses atomic receipt instead of the legacy completion function',async()=>{
  const f=fake();assert.equal(await f.queue.complete(id,'broker-dispatcher-1',{},'a'.repeat(64),cost),'succeeded')
  assert.equal(f.calls.length,2);assert.match(f.calls[0].text,/^CALL control\.commit_dispatch_settlement/);assert.match(f.calls[1].text,/get_dispatch_settlement/)
  assert.ok(f.calls.every(c=>!c.text.includes('complete_dispatch(')))
})

test('missing036 fails closed without falling back to a legacy completion',async()=>{
  const f=fake({stageError:true,readError:true})
  await assert.rejects(f.queue.complete(id,'broker-dispatcher-1',{},'a'.repeat(64),cost),SettlementUncertainError)
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>!c.text.includes('complete_dispatch(')))
})
for(const status of ['failed','budget_exceeded'] as const)test(`settled ${status} is not commercial success`,async()=>{
  const f=fake({result:{...receipt,status,result_accepted:false}});assert.equal(await f.settlement.complete(id,'broker-dispatcher-1',{},'a'.repeat(64),cost),status)
})
for(const [name,result] of Object.entries({pending:{...receipt,status:'pending'},missing:null,cross:{...receipt,job_id:randomUUID()},version:{...receipt,budget_version:2},amount:{...receipt,usage_value_micro_cents:0},extra:{...receipt,secret:'do not echo'},contradiction:{...receipt,status:'failed'},different_receipt:{...receipt,receipt_id:randomUUID()}}))test(`unverified ${name} remains uncertain without leaking details or retrying`,async()=>{
  const f=fake({result});await assert.rejects(f.settlement.complete(id,'broker-dispatcher-1',{},'a'.repeat(64),cost),e=>e instanceof SettlementUncertainError&&e.message==='DISPATCH_SETTLEMENT_UNCONFIRMED');assert.equal(f.calls.length,2)
})
test('database outage after staging cannot manufacture a zero charge or a failed job',async()=>{
  const f=fake({readError:true});await assert.rejects(f.settlement.complete(id,'broker-dispatcher-1',{},'a'.repeat(64),cost),SettlementUncertainError);assert.equal(f.calls.length,2)
})
test('expired pool acquisition destroys a late client without issuing a late stage write',async()=>{
  let resolveLate!:(c:unknown)=>void,connects=0,lateQueries=0,destroyed=false
  const waiting=new Promise(resolve=>{resolveLate=resolve})
  const pool={connect:()=>++connects===1?waiting:Promise.resolve({query:async()=>({rowCount:1,rows:[{receipt:null}]}),release:()=>{}})}
  const client=new PostgresDispatchSettlement(pool as never)
  await assert.rejects(client.complete(id,'broker-dispatcher-1',{},'a'.repeat(64),cost),SettlementUncertainError)
  resolveLate({query:async()=>{lateQueries++},release:(destroy:boolean)=>{destroyed=destroy}});await delay(10)
  assert.equal(connects,2);assert.equal(lateQueries,0);assert.equal(destroyed,true)
})

test('monotonic deadline rejects acquisition after a blocked event loop before its timer fires',async()=>{
  let connects=0,lateQueries=0,destroyed=false
  const pool={connect:()=>{
    if(++connects!==1)return Promise.resolve({query:async()=>({rowCount:1,rows:[{receipt:null}]}),release:()=>{}})
    const until=performance.now()+1050
    while(performance.now()<until){ /* synthetic event-loop pause, no network */ }
    return Promise.resolve({query:async()=>{lateQueries++},release:(destroy:boolean)=>{destroyed=destroy}})
  }}
  await assert.rejects(new PostgresDispatchSettlement(pool as never).complete(id,'broker-dispatcher-1',{},'a'.repeat(64),cost),SettlementUncertainError)
  assert.equal(connects,2);assert.equal(lateQueries,0);assert.equal(destroyed,true)
})
