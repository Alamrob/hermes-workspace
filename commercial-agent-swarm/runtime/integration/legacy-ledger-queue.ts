import type {Pool} from 'pg'
import {PostgresDispatchQueue,type CompletionCost} from '../src/dispatch-queue.js'
import type {SettlementStatus} from '../src/postgres-dispatch-settlement.js'

// Test-only adapter for historical budget/queue migrations before036. Never
// imported by production. Current factories use atomic receipts exclusively.
export class LegacyLedgerQueue extends PostgresDispatchQueue {
  constructor(private readonly testPool:Pool){super(testPool)}
  override async complete(id:string,worker:string,envelope:unknown,artifactHash:string,cost:CompletionCost):Promise<SettlementStatus>{
    await this.testPool.query('SELECT control.complete_dispatch($1::uuid,$2::text,$3::jsonb,$4::text,$5::bigint,$6::text,$7::text,$8::bigint,$9::bigint,$10::integer)',[
      id,worker,JSON.stringify(envelope),artifactHash,cost.usageValueMicroCents,cost.usageRecordId,cost.source,cost.budgetVersion,cost.total_tokens,cost.api_calls,
    ])
    const result=await this.testPool.query('SELECT status FROM control.dispatch_jobs WHERE job_id=$1',[id])
    const status=result.rows[0]?.status
    if(!['succeeded','failed','budget_exceeded'].includes(status))throw Error('LEGACY_TEST_STATUS_INVALID')
    return status
  }
}
