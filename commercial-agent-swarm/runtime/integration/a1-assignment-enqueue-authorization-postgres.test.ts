import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { dropTestDatabase } from './database-cleanup.js'

const ADMIN=process.env.TEST_DATABASE_URL;const integration=ADMIN?describe:describe.skip
const DISPATCH_ATTESTATIONS={exact_assignment_plan_confirmed:true,authorization_record_only:true,no_assignments_created:true,no_dispatch_queued:true,no_execution:true,no_contact:true,no_crm_write:true,no_external_actions:true,no_provider_credit_spend:true,global_kill_switch_required:true}
const ENQUEUE_ATTESTATIONS={exact_enqueue_confirmed:true,authorization_record_only:true,no_assignments_enqueued_by_authorization:true,no_execution:true,no_contact:true,no_crm_write:true,no_external_actions:true,no_provider_credit_spend:true,global_kill_switch_required:true}

integration('PostgreSQL exact A1 assignment enqueue authorization',()=>{
  it('records the second immutable gate while creating zero dispatch jobs',async()=>{
    const fixture=await databaseFixture('a1_enqueue_auth');const{admin,pool,database}=fixture
    try{
      await runVersionedMigrations(pool,await loadMigrationSources())
      const missionId=randomUUID(),traceId=randomUUID(),dispatchId=randomUUID(),enqueueId=randomUUID()
      const mission={mission_id:missionId,trace_id:traceId,autonomy_level:'A1',dry_run:true,contact_policy:{contact_permitted:false},volume_limits:{maximum_external_actions:0}}
      await pool.query(`INSERT INTO control.missions(mission_id,idempotency_key,payload)VALUES($1,$2,$3::jsonb)`,[missionId,`a1-enqueue-test:${missionId}`,JSON.stringify(mission)])
      const reviewedAt=new Date().toISOString(),dispatchExpires=new Date(Date.now()+25*60_000).toISOString(),enqueueExpires=new Date(Date.now()+15*60_000).toISOString()
      await pool.query(`SELECT control.record_a1_dispatch_authorization($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11,$12,$13,$14::jsonb,$15,$16)`,[dispatchId,missionId,traceId,'a1-plan-v1','approved','Autoriza registrar solamente el plan exacto sin crear ni ejecutar asignaciones.','director','proptimizaspa@gmail.com',reviewedAt,dispatchExpires,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),JSON.stringify(DISPATCH_ATTESTATIONS),'a1-dispatch-auth:postgres-r125-parent','d'.repeat(64)])
      const values=[enqueueId,missionId,traceId,'a1-plan-v1',dispatchId,'approved','Autoriza solamente el enqueue posterior del plan exacto, sin ejecutar.','director','proptimizaspa@gmail.com',reviewedAt,enqueueExpires,'a'.repeat(64),'b'.repeat(64),'e'.repeat(64),JSON.stringify(ENQUEUE_ATTESTATIONS),'a1-enqueue-auth:postgres-r125-gate','f'.repeat(64)]
      const query=`SELECT control.record_a1_assignment_enqueue_authorization($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15::jsonb,$16,$17) AS state`
      const state=(await pool.query(query,values)).rows[0].state
      assert.equal(state.authorizationId,enqueueId);assert.equal(state.assignmentEnqueuePermitted,true);assert.equal(state.assignmentsEnqueued,false);assert.equal(state.executionAuthorized,false);assert.equal(state.dispatchClaimingPermitted,false)
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM control.dispatch_jobs WHERE mission_id=$1`,[missionId])).rows[0].count,0)
      await assert.rejects(pool.query(await readFile(new URL('../migrations/031_a1_assignment_enqueue_authorization.rollback.sql',import.meta.url),'utf8')),/A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_HISTORY_PRESENT/);await pool.query('ROLLBACK')
    }finally{await destroyDatabase(admin,pool,database)}
  })
  it('rolls back cleanly with an empty ledger',async()=>{const fixture=await databaseFixture('a1_enqueue_rollback');const{admin,pool,database}=fixture;try{await runVersionedMigrations(pool,await loadMigrationSources());await pool.query(await readFile(new URL('../migrations/031_a1_assignment_enqueue_authorization.rollback.sql',import.meta.url),'utf8'));assert.equal((await pool.query(`SELECT to_regclass('control.a1_assignment_enqueue_authorizations') IS NULL AS absent`)).rows[0].absent,true)}finally{await destroyDatabase(admin,pool,database)}})
})
async function databaseFixture(prefix:string){const admin=new Pool({connectionString:ADMIN});const database=`${prefix}_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(ADMIN!);url.pathname=`/${database}`;return{admin,database,pool:new Pool({connectionString:url.toString()})}}
async function destroyDatabase(admin:Pool,pool:Pool,database:string){await pool.end();await dropTestDatabase(admin,database);await admin.end()}
