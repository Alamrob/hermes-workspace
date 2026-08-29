import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe,it } from 'node:test'
import { Pool } from 'pg'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { dropTestDatabase } from './database-cleanup.js'

const ADMIN=process.env.TEST_DATABASE_URL,integration=ADMIN?describe:describe.skip
const DISPATCH_ATTESTATIONS={exact_assignment_plan_confirmed:true,authorization_record_only:true,no_assignments_created:true,no_dispatch_queued:true,no_execution:true,no_contact:true,no_crm_write:true,no_external_actions:true,no_provider_credit_spend:true,global_kill_switch_required:true}
const ENQUEUE_ATTESTATIONS={exact_enqueue_confirmed:true,authorization_record_only:true,no_assignments_enqueued_by_authorization:true,no_execution:true,no_contact:true,no_crm_write:true,no_external_actions:true,no_provider_credit_spend:true,global_kill_switch_required:true}
const EXECUTION_ATTESTATIONS={exact_job_set_confirmed:true,authorization_record_only:true,no_jobs_claimed_by_authorization:true,no_execution:true,no_internet:true,no_contact:true,no_crm_write:true,no_external_actions:true,no_provider_credit_spend:true,global_kill_switch_required:true,execution_arm_requires_separate_gate:true}

integration('PostgreSQL exact A1 assignment execution authorization',()=>{
 it('keeps jobs unclaimable after record-only authorization and requires a separate exact arm',async()=>{
  const fixture=await databaseFixture('a1_execution_auth'),{admin,pool,database}=fixture
  try{
   await runVersionedMigrations(pool,await loadMigrationSources())
   const missionId=randomUUID(),traceId=randomUUID(),dispatchId=randomUUID(),enqueueId=randomUUID(),executionId=randomUUID(),jobId=randomUUID(),armId=randomUUID(),now=new Date(),dispatchExpires=new Date(now.getTime()+28*60_000).toISOString(),enqueueExpires=new Date(now.getTime()+24*60_000).toISOString(),executionExpires=new Date(now.getTime()+20*60_000).toISOString(),missionHash='a'.repeat(64),planHash='b'.repeat(64),jobSetHash='c'.repeat(64)
   const mission={mission_id:missionId,trace_id:traceId,autonomy_level:'A1',dry_run:true,a3_enabled:false,expires_at:new Date(now.getTime()+60*60_000).toISOString(),budget_limit:{currency:'USD',maximum:0.5},contact_policy:{contact_permitted:false},volume_limits:{maximum_external_actions:0}}
   await pool.query(`INSERT INTO control.missions(mission_id,idempotency_key,payload)VALUES($1,$2,$3::jsonb)`,[missionId,`a1-execution-test:${missionId}`,JSON.stringify(mission)])
   await pool.query(`SELECT control.record_a1_dispatch_authorization($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11,$12,$13,$14::jsonb,$15,$16)`,[dispatchId,missionId,traceId,'a1-plan-v1','approved','Autoriza registrar solamente el plan exacto sin crear ni ejecutar asignaciones.','director','proptimizaspa@gmail.com',now.toISOString(),dispatchExpires,missionHash,planHash,'d'.repeat(64),JSON.stringify(DISPATCH_ATTESTATIONS),'a1-dispatch-auth:postgres-r126-parent','e'.repeat(64)])
   await pool.query(`SELECT control.record_a1_assignment_enqueue_authorization($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15::jsonb,$16,$17)`,[enqueueId,missionId,traceId,'a1-plan-v1',dispatchId,'approved','Autoriza solamente el enqueue posterior del plan exacto, sin ejecutar.','director','proptimizaspa@gmail.com',now.toISOString(),enqueueExpires,missionHash,planHash,'f'.repeat(64),JSON.stringify(ENQUEUE_ATTESTATIONS),'a1-enqueue-auth:postgres-r126-parent','1'.repeat(64)])
   await pool.query(`SELECT control.enqueue_dispatch($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid[],$9::numeric,$10::bigint,$11,$12)`,[jobId,missionId,traceId,'a1-plan-v1:job-1','sales-orchestrator','Clasificar únicamente evidencia interna aprobada.','Expediente interno exacto.',[],0.01,6144,3,1])
   assert.equal((await pool.query(`SELECT count(*)::int AS count FROM control.claim_dispatch('r126-worker',60,30)`)).rows[0].count,0)
   const state=(await pool.query(`SELECT control.record_a1_assignment_execution_authorization($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15::uuid[],$16::numeric,$17,$18::jsonb,$19,$20) AS state`,[executionId,missionId,traceId,'a1-plan-v1',enqueueId,'approved','Registra solamente el prerrequisito exacto; no inicia ni ejecuta jobs.','director','proptimizaspa@gmail.com',now.toISOString(),executionExpires,missionHash,planHash,jobSetHash,[jobId],0.01,'2'.repeat(64),JSON.stringify(EXECUTION_ATTESTATIONS),'a1-execution-auth:postgres-r126-gate','3'.repeat(64)])).rows[0].state
   assert.equal(state.executionAuthorizationRecorded,true);assert.equal(state.executionArmCreated,false);assert.equal(state.dispatchClaimingPermitted,false);assert.equal(state.providerCreditSpendAllowed,false)
   assert.equal((await pool.query(`SELECT count(*)::int AS count FROM control.claim_dispatch('r126-worker',60,30)`)).rows[0].count,0)
   await pool.query(`INSERT INTO control.a1_dispatch_execution_arms(arm_id,mission_id,execution_authorization_id,worker_id,starts_at,expires_at,maximum_claims,maximum_provider_credit_spend_usd)VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '5 minutes',1,0.01)`,[armId,missionId,executionId,'r126-worker'])
   assert.equal((await pool.query(`SELECT count(*)::int AS count FROM control.claim_dispatch('r126-worker',60,30)`)).rows[0].count,0)
   await pool.query(`SELECT control.set_kill_switch('global','*',false)`)
   const claim=await pool.query(`SELECT job_id FROM control.claim_dispatch('r126-worker',60,30)`);assert.equal(claim.rows[0]?.job_id,jobId)
   assert.equal((await pool.query(`SELECT claims_used FROM control.a1_dispatch_execution_arms WHERE arm_id=$1`,[armId])).rows[0].claims_used,1)
   await pool.query(`SELECT control.set_kill_switch('global','*',true)`)
   await assert.rejects(pool.query(await readFile(new URL('../migrations/032_a1_assignment_execution_authorization.rollback.sql',import.meta.url),'utf8')),/A1_ASSIGNMENT_EXECUTION_AUTHORIZATION_HISTORY_PRESENT/);await pool.query('ROLLBACK')
  }finally{await destroyDatabase(admin,pool,database)}
 })
 it('rolls back cleanly while authorization and arm ledgers are empty',async()=>{const fixture=await databaseFixture('a1_execution_rollback'),{admin,pool,database}=fixture;try{await runVersionedMigrations(pool,await loadMigrationSources());await pool.query(await readFile(new URL('../migrations/032_a1_assignment_execution_authorization.rollback.sql',import.meta.url),'utf8'));assert.equal((await pool.query(`SELECT to_regclass('control.a1_assignment_execution_authorizations') IS NULL AS absent`)).rows[0].absent,true)}finally{await destroyDatabase(admin,pool,database)}})
})

async function databaseFixture(prefix:string){const admin=new Pool({connectionString:ADMIN});const database=`${prefix}_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(ADMIN!);url.pathname=`/${database}`;return{admin,database,pool:new Pool({connectionString:url.toString()})}}
async function destroyDatabase(admin:Pool,pool:Pool,database:string){await pool.end();await dropTestDatabase(admin,database);await admin.end()}
