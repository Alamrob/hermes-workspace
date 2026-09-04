import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runA1WindowSupervisor, validateSupervisorState, type SupervisorEvent, type SupervisorPort } from '../src/a1-window-supervisor.js'
import { supervisorConfig } from '../src/a1-window-supervisor-main.js'
const ID='11111111-1111-4111-8111-111111111111'
const state=(status:'ready'|'stopped'='ready')=>({status,instance_id:ID,server_time:'2026-09-03T00:00:00.000Z',lease_until:status==='ready'?'2026-09-03T00:00:05.000Z':'2026-09-03T00:00:00.000Z',closed:[]})
test('supervisor accepts server-clock state without interpreting local clock as authority',()=>{
  assert.equal(validateSupervisorState(state(),ID,'ready').status,'ready')
  assert.equal(validateSupervisorState(state('stopped'),ID,'stopped').status,'stopped')
})
for(const patch of [{instance_id:'wrong'},{status:'stopped'},{lease_until:'2026-09-03T00:00:06.000Z'},{extra:'data'},{closed:[{mission_id:null,window_id:null,reason:'CLAIM_JOB'}]},{closed:[{mission_id:null,window_id:null,reason:'WINDOW_EXPIRED'}]}])
  test(`invalid supervisor response ${JSON.stringify(patch)}`,()=>assert.throws(()=>validateSupervisorState({...state(),...patch},ID,'ready'),/RESPONSE_INVALID/))
test('sequential pulses never overlap; abort closes and verifies stop',async()=>{
  const controller=new AbortController(),events:SupervisorEvent[]=[],calls:string[]=[]
  let active=0,waits=0
  const port:SupervisorPort={pulse:async()=>{assert.equal(active++,0);calls.push('pulse');await Promise.resolve();active--;return state()},stop:async()=>{calls.push('stop');return state('stopped')},close:async()=>{calls.push('close')}}
  await runA1WindowSupervisor({instance:ID,signal:controller.signal,connect:async()=>port,event:e=>events.push(e),wait:async(ms)=>{assert.equal(active,0);assert.equal(ms,1000);if(++waits===3)controller.abort()}})
  assert.deepEqual(calls,['pulse','pulse','pulse','stop','close'])
  assert.deepEqual(events.map(x=>x.event),['a1_supervisor_ready','a1_supervisor_stopped'])
})
test('DB/unknown-response failure discards session and never logs secrets or reports containment',async()=>{
  const controller=new AbortController(),events:SupervisorEvent[]=[],calls:string[]=[]
  let connects=0,waits=0
  await runA1WindowSupervisor({instance:ID,signal:controller.signal,event:e=>events.push(e),connect:async()=>{
    const n=++connects
    return{pulse:async()=>{calls.push('pulse'+n);if(n===1)throw new Error('postgres://secret:sensitive@example');return state()},stop:async()=>state('stopped'),close:async()=>{calls.push('close'+n)}}
  },wait:async()=>{if(++waits===2)controller.abort()}})
  assert.equal(connects,2);assert.deepEqual(calls,['pulse1','close1','pulse2','close2'])
  assert.equal(events[0].event,'a1_supervisor_unavailable');assert.doesNotMatch(JSON.stringify(events),/secret|postgres:|sensitive|example/)
})
test('failed stop remains explicitly unverified',async()=>{
  const controller=new AbortController(),events:SupervisorEvent[]=[]
  await runA1WindowSupervisor({instance:ID,signal:controller.signal,event:e=>events.push(e),connect:async()=>({pulse:async()=>state(),stop:async()=>{throw Error('token')},close:async()=>{}}),wait:async()=>controller.abort()})
  assert.equal(events.at(-1)?.event,'a1_supervisor_stop_unverified');assert.doesNotMatch(JSON.stringify(events),/token/)
})
test('pre-aborted process does not connect',async()=>{
  const controller=new AbortController();controller.abort()
  await runA1WindowSupervisor({instance:ID,signal:controller.signal,event:()=>{},connect:async()=>{throw Error('must not connect')}})
})
test('supervisor process uses only its dedicated secret and non-root identity',()=>{
  const env={NODE_ENV:'production',A1_SUPERVISOR_DATABASE_URL_FILE:'/run/secrets/a1-supervisor-db'}
  assert.equal(supervisorConfig(env,{uid:10009,gid:10009}).gid,10009)
  assert.throws(()=>supervisorConfig(env,{uid:0,gid:0}),/IDENTITY/)
  assert.throws(()=>supervisorConfig({...env,A1_SUPERVISOR_DATABASE_URL:'raw'},{uid:10009,gid:10009}),/SECRET_FILE/)
  for(const name of ['DATABASE_URL_FILE','OPENCODE_API_KEY','SAFETY_DATABASE_URL_FILE','HOSTINGER_MAIL_TOKEN_FILE'])
    assert.throws(()=>supervisorConfig({...env,[name]:'forbidden'},{uid:10009,gid:10009}),/EXTRANEOUS/)
})
