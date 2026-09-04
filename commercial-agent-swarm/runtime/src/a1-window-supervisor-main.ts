import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { currentProcessIdentity, readGroupSecretFile } from './secret-file.js'
import { connectA1Supervisor, runA1WindowSupervisor } from './a1-window-supervisor.js'

export function supervisorConfig(env:Record<string,string|undefined>,identity:{uid:number;gid:number}){
  if(env.NODE_ENV!=='production'||identity.uid!==10009||identity.gid!==10009)
    throw new Error('A1_SUPERVISOR_IDENTITY_INVALID')
  if(env.A1_SUPERVISOR_DATABASE_URL||!env.A1_SUPERVISOR_DATABASE_URL_FILE?.startsWith('/run/secrets/'))
    throw new Error('A1_SUPERVISOR_SECRET_FILE_REQUIRED')
  for(const name of ['DATABASE_URL','DATABASE_URL_FILE','SAFETY_DATABASE_URL','SAFETY_DATABASE_URL_FILE',
    'WORK_ORDER_DATABASE_URL_FILE','OPENCODE_API_KEY','OPENCODE_USAGE_TOKEN_FILE','HOSTINGER_MAIL_TOKEN_FILE'])
    if(env[name])throw new Error('A1_SUPERVISOR_EXTRANEOUS_SECRET')
  return{secretFile:env.A1_SUPERVISOR_DATABASE_URL_FILE,gid:10009}
}
export async function main(){
  const config=supervisorConfig(process.env,currentProcessIdentity())
  const connectionString=await readGroupSecretFile(config.secretFile,config.gid)
  const controller=new AbortController(),stop=()=>controller.abort()
  process.once('SIGINT',stop);process.once('SIGTERM',stop)
  try{
    await runA1WindowSupervisor({instance:randomUUID(),signal:controller.signal,
      connect:()=>connectA1Supervisor(connectionString),event:e=>console.info(JSON.stringify(e))})
  }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await main()}catch{console.error(JSON.stringify({event:'a1_supervisor_start_failed'}));process.exitCode=1}
}
