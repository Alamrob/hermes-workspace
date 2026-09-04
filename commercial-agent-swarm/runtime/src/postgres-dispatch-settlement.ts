import type {Pool,PoolClient,QueryConfig,QueryResult,QueryResultRow} from 'pg'
import type {CompletionCost} from './dispatch-queue.js'

export type SettlementStatus='succeeded'|'failed'|'budget_exceeded'
export class SettlementUncertainError extends Error {
  constructor(){super('DISPATCH_SETTLEMENT_UNCONFIRMED')}
}
const signature='$1::uuid,$2::text,$3::jsonb,$4::text,$5::bigint,$6::text,$7::text,$8::bigint,$9::bigint,$10::integer'
const query=(text:string,values:unknown[]):QueryConfig&{query_timeout:number}=>({text,values,query_timeout:10000})
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// A fixed top-level CALL commits on the server before returning a receipt. Only a subsequent read of
// its finalized, exact request is authority for success. Never re-execute work.
export class PostgresDispatchSettlement {
  constructor(private readonly pool:Pick<Pool,'connect'>){}
  private acquire():Promise<PoolClient>{
    return new Promise((resolve,reject)=>{
      let expired=false
      const deadline=performance.now()+1000
      const timer=setTimeout(()=>{expired=true;reject(new SettlementUncertainError())},1000)
      this.pool.connect().then(client=>{clearTimeout(timer);if(expired||performance.now()>=deadline){client.release(true);reject(new SettlementUncertainError())}else resolve(client)},()=>{clearTimeout(timer);reject(new SettlementUncertainError())})
    })
  }
  private async query<T extends QueryResultRow>(config:QueryConfig):Promise<QueryResult<T>>{
    const client=await this.acquire();let healthy=false
    try{const result=await client.query<T>(config);healthy=true;return result}
    finally{client.release(!healthy)}
  }
  async complete(id:string,worker:string,envelope:unknown,artifactHash:string,cost:CompletionCost):Promise<SettlementStatus>{
    const args=[id,worker,JSON.stringify(envelope),artifactHash,cost.usageValueMicroCents,cost.usageRecordId,cost.source,cost.budgetVersion,cost.total_tokens,cost.api_calls]
    let receiptId:string|undefined
    try{
      const result=await this.query<{id:unknown}>(query(`CALL control.commit_dispatch_settlement(${signature},NULL::uuid)`,args))
      if(result.rowCount!==1||typeof result.rows[0].id!=='string'||!uuid.test(result.rows[0].id))throw new SettlementUncertainError()
      receiptId=result.rows[0].id
    }catch{
      // A lost reply may follow a successful commit. Read exactly this request
      // once; no repeat of stage, mission, provider call or budget release.
    }
    try{
      const result=await this.query<{receipt:unknown}>(query(`SELECT control.get_dispatch_settlement(${signature}) AS receipt`,args))
      if(result.rowCount!==1)throw new SettlementUncertainError()
      const r=result.rows[0].receipt
      if(!r||typeof r!=='object'||Array.isArray(r))throw new SettlementUncertainError()
      const row=r as Record<string,unknown>
      const keys=['receipt_id','job_id','budget_version','status','result_accepted','reason','usage_value_micro_cents']
      if(Object.keys(row).length!==keys.length||!keys.every(k=>Object.hasOwn(row,k))||typeof row.receipt_id!=='string'||!uuid.test(row.receipt_id)||
        (receiptId!==undefined&&row.receipt_id!==receiptId)||row.job_id!==id||row.budget_version!==cost.budgetVersion||
        !['succeeded','failed','budget_exceeded'].includes(String(row.status))||row.result_accepted!==(row.status==='succeeded')||
        row.usage_value_micro_cents!==cost.usageValueMicroCents||typeof row.reason!=='string'||!/^[A-Z0-9_:-]{3,128}$/.test(row.reason))throw new SettlementUncertainError()
      return row.status as SettlementStatus
    }catch{throw new SettlementUncertainError()}
  }
}
