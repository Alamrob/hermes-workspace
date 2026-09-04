import assert from 'node:assert/strict'
import {test} from 'node:test'
import {EventEmitter} from 'node:events'
import type {Socket} from 'node:net'
import {randomUUID} from 'node:crypto'
import {ExecutorGuardianClient} from '../src/executor-guardian-client.js'
import {assertExecutorServerSecurity,EXECUTOR_BOOTSTRAP_CONTRACT_V2} from '../src/supervisor-security.js'
import {ExecutionLeaseChallenges,isLeaseClosingReply} from '../src/execution-lease.js'

const binding={target_request_id:randomUUID(),mission_id:randomUUID(),assignment_id:randomUUID()}
class Wire extends EventEmitter {
  frames:any[]=[];destroyed=false;reply=true
  write(bytes:Buffer,callback:(e?:Error)=>void){const v=JSON.parse(bytes.toString());this.frames.push(v);callback();if(this.reply)queueMicrotask(()=>this.emit('data',Buffer.from(JSON.stringify({id:v.id,ok:true,...(v.op==='challenge'?{challenge_id:randomUUID()}:{})})+'\n')))}
  destroy(){this.destroyed=true}
}
test('guardian client uses one sequenced private channel and no arbitrary tool call',async()=>{
  const wire=new Wire(),client=new ExecutorGuardianClient(wire as unknown as Socket)
  try{await client.challenge(binding);await client.finish(binding);assert.deepEqual(wire.frames.map(x=>[x.seq,x.op]),[[1,'challenge'],[2,'finish']]);assert.deepEqual(wire.frames[0].binding,binding)}finally{client.close()}
})
for(const failure of ['unknown_id','extra_key','invalid_challenge','oversize','eof','timeout'])test(`guardian ${failure} closes pending calls instead of accepting an ACK`,async()=>{
  const wire=new Wire();wire.reply=false;const client=new ExecutorGuardianClient(wire as unknown as Socket)
  try{
    const request=assert.rejects(client.challenge(binding),/EXECUTOR_GUARDIAN_UNAVAILABLE/)
    const id=wire.frames[0].id
    if(failure==='eof')wire.emit('end')
    else if(failure==='oversize')wire.emit('data',Buffer.alloc(16385))
    else if(failure!=='timeout')wire.emit('data',Buffer.from(JSON.stringify({id:failure==='unknown_id'?randomUUID():id,ok:true,challenge_id:failure==='invalid_challenge'?'*':randomUUID(),...(failure==='extra_key'?{secret:'redacted-synthetic'}:{})})+'\n'))
    await request;assert.equal(wire.destroyed,true)
  }finally{client.close()}
})
test('adopted guardian challenges use earlier local clock and reject replay/future',()=>{
  let now=100;const c=new ExecutionLeaseChallenges(()=>now),id=randomUUID();c.issue(binding,id,80)
  assert.throws(()=>c.issue(binding,id,80),/INVALID/)
  assert.throws(()=>c.issue(binding,randomUUID(),101),/INVALID/)
  now=6000;assert.throws(()=>c.issue(binding,randomUUID(),80),/INVALID/)
})
test('closing notice is exact, bound and carries no permission',()=>{
  const id=randomUUID();assert.equal(isLeaseClosingReply({request_id:id,type:'lease_closing_result'},id),true)
  assert.throws(()=>isLeaseClosingReply({request_id:id,type:'lease_closing_result',valid_for_ms:5000},id),/INVALID/)
  assert.throws(()=>isLeaseClosingReply({request_id:randomUUID(),type:'lease_closing_result'},id),/INVALID/)
})
test('server requires private PID1 guardian, exact parent argv and unexpanded caps',()=>{
  const status=['Uid:\t10000\t10000\t10000\t10000','Gid:\t10000\t10000\t10000\t10000','Groups:\t','NoNewPrivs:\t1',...['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>`${k}:\t00000000000001e1`)].join('\n')
  const valid={pid:7,ppid:1,uid:10000,gid:10000,status,parentStatus:status,parentCommand:'/opt/hermes/.venv/bin/python\0-I\0-B\0/app/guardian/executor_guardian.py\0'}
  assert.doesNotThrow(()=>assertExecutorServerSecurity(valid))
  for(const change of [{pid:1},{ppid:8},{parentCommand:'python\0attacker.py\0'},{parentStatus:status.replace('NoNewPrivs:\t1','NoNewPrivs:\t0')},{status:status.replace('CapEff:\t00000000000001e1','CapEff:\t00000000000003e1')}])assert.throws(()=>assertExecutorServerSecurity({...valid,...change}),/SECURITY_INVALID/)
  assert.deepEqual(EXECUTOR_BOOTSTRAP_CONTRACT_V2.slice(-4),['/opt/hermes/.venv/bin/python','-I','-B','/app/guardian/executor_guardian.py'])
})
