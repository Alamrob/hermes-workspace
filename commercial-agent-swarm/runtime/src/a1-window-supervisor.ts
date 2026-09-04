import { Client } from 'pg'
import { setTimeout as delay } from 'node:timers/promises'

export interface SupervisorState {
  status: 'ready' | 'stopped'
  instance_id: string
  server_time: string
  lease_until: string
  closed: Array<{mission_id: string | null; window_id: string | null; reason: string}>
}
export interface SupervisorPort {
  pulse(instance: string): Promise<unknown>
  stop(instance: string): Promise<unknown>
  close(): Promise<void>
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const REASONS=new Set(['WINDOW_EXPIRED','GLOBAL_KILL_SWITCH_ACTIVE','CHANNEL_GUARD_CHANGED',
  'WINDOW_BINDING_CHANGED','DISPATCH_UNSAFE','MISSION_TERMINAL','SUPERVISOR_RESTART','SUPERVISOR_STOP','ORPHANED_CONTROL'])
function keys(x:unknown,expected:string):x is Record<string,unknown> {
  return !!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===expected
}
export function validateSupervisorState(value:unknown,instance:string,status:'ready'|'stopped'):SupervisorState {
  const bad=()=>{throw new Error('A1_SUPERVISOR_RESPONSE_INVALID')}
  if(!keys(value,'closed,instance_id,lease_until,server_time,status')||value.instance_id!==instance||
    !UUID.test(instance)||value.status!==status||typeof value.server_time!=='string'||typeof value.lease_until!=='string'||
    !Number.isFinite(Date.parse(value.server_time))||!Number.isFinite(Date.parse(value.lease_until))||
    Date.parse(value.lease_until)-Date.parse(value.server_time)!==(status==='ready'?5000:0)||
    !Array.isArray(value.closed)||value.closed.length>8)return bad()
  for(const item of value.closed){
    if(!keys(item,'mission_id,reason,window_id')||typeof item.reason!=='string'||!REASONS.has(item.reason))return bad()
    if(item.reason==='ORPHANED_CONTROL'){
      if(item.mission_id!==null||item.window_id!==null)return bad()
    }else if(typeof item.mission_id!=='string'||typeof item.window_id!=='string'||!UUID.test(item.mission_id)||!UUID.test(item.window_id))return bad()
  }
  return value as unknown as SupervisorState
}

export interface SupervisorEvent {
  event:'a1_supervisor_ready'|'a1_supervisor_contained'|'a1_supervisor_unavailable'|'a1_supervisor_stopped'|'a1_supervisor_stop_unverified'
  instance_id:string
  closed?:SupervisorState['closed']
}
// No dispatcher, approval, LLM, mail or CRM port exists in this process.
export async function runA1WindowSupervisor(options:{
  instance:string; signal:AbortSignal; connect:()=>Promise<SupervisorPort>;
  event:(event:SupervisorEvent)=>void;
  wait?:(ms:number,signal:AbortSignal)=>Promise<void>;
}):Promise<void>{
  if(!UUID.test(options.instance))throw new Error('A1_SUPERVISOR_INSTANCE_INVALID')
  const wait=options.wait??((ms,signal)=>delay(ms,undefined,{signal}))
  let port:SupervisorPort|undefined, failures=0
  try{
    while(!options.signal.aborted){
      let interval=1000
      try{
        const fresh=!port
        port??=await options.connect()
        const state=validateSupervisorState(await port.pulse(options.instance),options.instance,'ready')
        failures=0
        if(fresh)options.event({event:'a1_supervisor_ready',instance_id:options.instance})
        if(state.closed.length)options.event({event:'a1_supervisor_contained',instance_id:options.instance,closed:state.closed})
      }catch{
        failures++
        options.event({event:'a1_supervisor_unavailable',instance_id:options.instance})
        await port?.close().catch(()=>undefined);port=undefined
        interval=Math.min(5000,1000*2**Math.min(failures-1,3))
      }
      try{await wait(interval,options.signal)}catch{if(!options.signal.aborted)throw new Error('A1_SUPERVISOR_WAIT_FAILED')}
    }
  }finally{
    if(port){
      try{
        const state=validateSupervisorState(await port.stop(options.instance),options.instance,'stopped')
        options.event({event:'a1_supervisor_stopped',instance_id:options.instance,closed:state.closed})
      }catch{options.event({event:'a1_supervisor_stop_unverified',instance_id:options.instance})}
      finally{await port.close().catch(()=>undefined)}
    }
  }
}

export async function connectA1Supervisor(connectionString:string):Promise<SupervisorPort>{
  const client=new Client({connectionString,application_name:'proptimiza-a1-window-supervisor',
    connectionTimeoutMillis:2000,query_timeout:3000,statement_timeout:2000,options:'-c lock_timeout=500'})
  let lost=false
  client.on('error',()=>{lost=true})
  try{
    await client.connect()
    const r=await client.query(`SELECT r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND pg_has_role(current_user,'commercial_a1_supervisor','MEMBER')
      AND (SELECT count(*) FROM pg_auth_members WHERE member=r.oid)=1
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid AND admin_option)
      AND has_function_privilege(current_user,'control.pulse_a1_window_supervisor(uuid)','EXECUTE')
      AND has_function_privilege(current_user,'control.stop_a1_window_supervisor(uuid)','EXECUTE')
      AND NOT has_function_privilege(current_user,'control.set_kill_switch(text,text,boolean)','EXECUTE')
      AND NOT has_function_privilege(current_user,'control.claim_dispatch(text,integer,integer)','EXECUTE')
      AND NOT has_table_privilege(current_user,'control.a1_window_supervisor_lease','UPDATE') AS safe
      FROM pg_roles r WHERE r.rolname=current_user`)
    if(r.rows[0]?.safe!==true)throw new Error('A1_SUPERVISOR_PRINCIPAL_INVALID')
    const query=async(name:'pulse_a1_window_supervisor'|'stop_a1_window_supervisor',instance:string)=>{
      if(lost)throw new Error('A1_SUPERVISOR_CONNECTION_LOST')
      return(await client.query(`SELECT control.${name}($1::uuid) AS state`,[instance])).rows[0]?.state
    }
    return{pulse:id=>query('pulse_a1_window_supervisor',id),stop:id=>query('stop_a1_window_supervisor',id),close:()=>client.end()}
  }catch{
    await client.end().catch(()=>undefined)
    throw new Error('A1_SUPERVISOR_CONNECT_FAILED')
  }
}
