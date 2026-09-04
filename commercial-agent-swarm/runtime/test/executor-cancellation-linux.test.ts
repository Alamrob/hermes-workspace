import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {NodeProcessRunner,ExecutorExecutionError,type ProcessInvocation} from '../src/hermes-executor.js'
import {UnixExecutorServer} from '../src/unix-executor-server.js'
import {UnixExecutorClient,ExecutorTransportError} from '../src/unix-executor-client.js'
import type {ExecuteInput} from '../src/executor-contract.js'

const linux=process.platform==='linux'
const input:ExecuteInput={mission_id:randomUUID(),trace_id:randomUUID(),assignment_id:randomUUID(),profile_id:'sales-orchestrator',execution_timeout_ms:10000,instruction:'Synthetic test; no provider.',evidence:{trust:'untrusted_data',content:'Synthetic.'},execution_policy:{autonomy_level:'A1',allowed_actions:['analysis.internal'],approved_channels:['internal'],approved_tools:['hermes.analysis']},reservation:{maximum_tokens:100,maximum_api_calls:1,budget_reservation:{currency:'USD',amount:0.01}}}

async function fixture(){
  const cwd=await mkdtemp(join(tmpdir(),'cancel-real-')),marker=join(cwd,'ready.json')
  const descendant="process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')"
  const code=`const{spawn}=require('child_process');const fs=require('fs');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({leader:process.pid,descendant:child.pid})));setInterval(()=>{},1000)`
  const invocation:ProcessInvocation={command:process.execPath,args:['-e',code],env:{PATH:process.env.PATH??''},uid:process.getuid!(),gid:process.getgid!(),shell:false,detached:true,cwd,timeoutMs:10000,stdoutLimitBytes:1024,stderrLimitBytes:1024}
  return{cwd,invocation,async ready(){
    const deadline=performance.now()+6000
    while(performance.now()<deadline){
      try{const ids=JSON.parse(await readFile(marker,'utf8'));assert.ok(Number.isSafeInteger(ids.leader)&&ids.leader>1);assert.ok(Number.isSafeInteger(ids.descendant)&&ids.descendant>1);return ids as {leader:number;descendant:number}}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      await delay(10)
    }
    throw Error('SYNTHETIC_CHILD_NOT_READY')
  }}
}
function gone(pid:number){assert.throws(()=>process.kill(pid,0),error=>(error as NodeJS.ErrnoException).code==='ESRCH')}

test('Linux AbortSignal kills the real group with inherited pipes and SIGTERM-ignoring descendants', {skip:!linux,timeout:15000},async()=>{
  const f=await fixture(),controller=new AbortController(),run=new NodeProcessRunner().run({...f.invocation,signal:controller.signal})
  void run.catch(()=>{})
  try{
    const ids=await f.ready(),started=performance.now();controller.abort();controller.abort()
    const result=await run
    assert.equal(result.cancelled,true);assert.equal(result.timedOut,false)
    assert.ok(performance.now()-started<3000);gone(ids.leader);gone(ids.descendant);gone(-ids.leader)
  }finally{controller.abort();await run.catch(()=>{});await rm(f.cwd,{recursive:true,force:true})}
})

for(const mode of ['cancel','stop'] as const)test(`Linux IPC ${mode} acknowledges completion only after real child group termination`,{skip:!linux,timeout:15000},async()=>{
  const f=await fixture(),socketPath=join(f.cwd,'executor.sock'),controller=new AbortController()
  let verified=false
  const server=new UnixExecutorServer({socketPath,frameTimeoutMs:3000,executor:{execute:async(_input,ctx)=>{
    assert.ok(ctx?.signal)
    const out=await new NodeProcessRunner().run({...f.invocation,signal:ctx.signal})
    assert.equal(out.cancelled,true);verified=true
    throw new ExecutorExecutionError('HERMES_CANCELLED','finished')
  }}})
  await server.start()
  const rejected=assert.rejects(new UnixExecutorClient({socketPath,timeoutMs:12000}).execute(input,{signal:controller.signal}),error=>error instanceof ExecutorTransportError&&error.code==='HERMES_CANCELLED'&&error.executionState==='finished'&&!error.recoverable)
  try{
    const ids=await f.ready()
    // Linux request EOF has already been consumed, but both processes remain.
    process.kill(ids.leader,0);process.kill(ids.descendant,0)
    if(mode==='cancel')controller.abort();else await server.stop()
    await rejected;assert.equal(verified,true);gone(ids.leader);gone(ids.descendant);gone(-ids.leader)
  }finally{controller.abort();await server.stop();await rejected;await rm(f.cwd,{recursive:true,force:true})}
})

for(const failure of ['SIGSTOP','SIGKILL'] as const)test(`Linux executor expires its own lease after broker ${failure} and kills the child group`,{skip:!linux,timeout:20000},async()=>{
  const f=await fixture(),socketPath=join(f.cwd,'executor.sock')
  let active=false
  let stopped!:()=>void,failed!:(e:unknown)=>void
  const terminated=new Promise<void>((resolve,reject)=>{stopped=resolve;failed=reject});void terminated.catch(()=>{})
  const server=new UnixExecutorServer({socketPath,requireExecutionLease:true,frameTimeoutMs:3000,executor:{execute:async(_input,ctx)=>{
    try{
      assert.equal(ctx?.leaseLive?.(),true)
      active=true
      const out=await new NodeProcessRunner().run({...f.invocation,signal:ctx?.signal})
      assert.equal(out.cancelled,true);assert.equal(out.timedOut,false);stopped()
    }catch(error){failed(error);throw error}finally{active=false}
    throw new ExecutorExecutionError('HERMES_CANCELLED','finished')
  }}})
  await server.start()
  const permit={allowed:true,job_id:input.assignment_id,mission_id:input.mission_id,worker_id:'broker-dispatcher-1',window_id:randomUUID(),epoch_id:randomUUID(),budget_version:1,valid_for_ms:1800}
  const source=`import {UnixExecutorClient} from ${JSON.stringify(new URL('../src/unix-executor-client.js',import.meta.url).href)};let reads=0;try{await new UnixExecutorClient({socketPath:${JSON.stringify(socketPath)},timeoutMs:12000,requireExecutionLease:true}).execute(${JSON.stringify(input)},{readExecutionPermit:async()=>{reads++;process.send({reads});return ${JSON.stringify(permit)}}});process.exitCode=2}catch{process.send({finished:true})}`
  const broker=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH},cwd:f.cwd})
  let reads=0;broker.on('message',(message:any)=>{if(Number.isSafeInteger(message?.reads))reads=message.reads})
  const exited=new Promise<void>(resolve=>broker.once('exit',()=>resolve()))
  try{
    const ids=await f.ready(),deadline=performance.now()+5000
    while(reads<2&&performance.now()<deadline)await delay(10)
    assert.ok(reads>=2,'broker queried a renewal')
    // Merely entering the SQL callback is not a renewal acknowledgement.
    // Survive beyond the initial lease with a live child before injecting fault.
    await delay(2200)
    assert.equal(active,true,'executor must remain live beyond the initial 1800 ms grant')
    process.kill(ids.leader,0);process.kill(ids.descendant,0)
    const before=performance.now();assert.equal(broker.kill(failure),true)
    // This test process is the independent executor; the stopped/dead broker
    // cannot send cancel or renewal. Its previously granted lease must expire.
    await Promise.race([terminated,delay(5000).then(()=>{throw Error('LEASE_DID_NOT_TERMINATE_CHILD')})])
    assert.ok(performance.now()-before<4500)
    gone(ids.leader);gone(ids.descendant);gone(-ids.leader)
  }finally{
    if(broker.exitCode===null&&broker.signalCode===null){broker.kill('SIGCONT');broker.kill('SIGKILL')}
    await exited;await server.stop();await rm(f.cwd,{recursive:true,force:true})
  }
})
