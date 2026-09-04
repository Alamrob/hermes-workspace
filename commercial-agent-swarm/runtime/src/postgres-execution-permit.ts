import type {Pool,PoolClient,QueryConfig} from 'pg'
import {validateExecutionPermit,type ExecutionPermit} from './execution-lease.js'
// pg8.16.3 supports per-query read timeouts (lib/client.js); its typings omit it.
const bounded=(text:string,values?:unknown[]):QueryConfig&{query_timeout:number}=>({text,values,query_timeout:1500})

// No credential crosses IPC. Each read uses a fresh, short read-only transaction
// and returns only bounded identity/lease metadata, never the SQL exception.
export class PostgresExecutionPermitReader {
  constructor(private readonly pool:Pool){}
  async read(jobId:string,missionId:string,worker:string,budgetVersion:number):Promise<ExecutionPermit>{
    let client:PoolClient|undefined,healthy=false
    try{
      client=await this.acquire()
      await client.query(bounded("BEGIN READ ONLY; SET LOCAL statement_timeout='1000ms'; SET LOCAL lock_timeout='250ms'"))
      const result=await client.query<{permit:unknown}>(bounded('SELECT control.get_a1_job_execution_permit($1::uuid,$2,$3::bigint) AS permit',[jobId,worker,budgetVersion]))
      await client.query(bounded('COMMIT'));healthy=true
      if(result.rowCount!==1)throw Error('EXECUTOR_LEASE_DENIED')
      const permit=validateExecutionPermit(result.rows[0].permit)
      if(permit.job_id!==jobId||permit.mission_id!==missionId||permit.worker_id!==worker||permit.budget_version!==budgetVersion)throw Error('EXECUTOR_LEASE_DENIED')
      return permit
    }catch{throw Error('EXECUTOR_LEASE_DENIED')}
    finally{client?.release(!healthy)}
  }
  private acquire():Promise<PoolClient>{
    return new Promise((resolve,reject)=>{
      let expired=false
      const timer=setTimeout(()=>{expired=true;reject(Error('EXECUTOR_LEASE_DENIED'))},1000)
      this.pool.connect().then(client=>{clearTimeout(timer);if(expired)client.release(true);else resolve(client)},()=>{clearTimeout(timer);reject(Error('EXECUTOR_LEASE_DENIED'))})
    })
  }
}
