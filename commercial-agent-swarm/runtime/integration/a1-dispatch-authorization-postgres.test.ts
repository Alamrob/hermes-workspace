import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { dropTestDatabase } from './database-cleanup.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip
const ATTESTATIONS = {
  exact_assignment_plan_confirmed: true,
  authorization_record_only: true,
  no_assignments_created: true,
  no_dispatch_queued: true,
  no_execution: true,
  no_contact: true,
  no_crm_write: true,
  no_external_actions: true,
  no_provider_credit_spend: true,
  global_kill_switch_required: true,
}

integration('PostgreSQL exact A1 assignment-plan authorization', () => {
  it('records one immutable plan hash without creating or claiming any assignment', async () => {
    const fixture = await databaseFixture('a1_dispatch_auth')
    const { admin, pool, database } = fixture
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())
      assert.equal((await pool.query(
        `SELECT control.is_global_kill_switch_active() AS active`,
      )).rows[0].active, true)
      const missionId = randomUUID()
      const traceId = randomUUID()
      const authorizationId = randomUUID()
      const mission = {
        mission_id: missionId,
        trace_id: traceId,
        autonomy_level: 'A1',
        dry_run: true,
        contact_policy: { contact_permitted: false },
        volume_limits: { maximum_external_actions: 0 },
      }
      await pool.query(
        `INSERT INTO control.missions(mission_id,idempotency_key,payload)
         VALUES($1,$2,$3::jsonb)`,
        [missionId, `a1-dispatch-test:${missionId}`, JSON.stringify(mission)],
      )
      const reviewedAt = new Date().toISOString()
      const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString()
      const values = [
        authorizationId, missionId, traceId, 'a1-plan-v1', 'approved',
        'Autoriza registrar solamente el plan exacto sin crear ni ejecutar asignaciones.',
        'director', 'proptimizaspa@gmail.com', reviewedAt, expiresAt,
        'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), JSON.stringify(ATTESTATIONS),
        'a1-dispatch-auth:postgres-00000053', 'd'.repeat(64),
      ]
      const query = `SELECT control.record_a1_dispatch_authorization(
        $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,
        $11,$12,$13,$14::jsonb,$15,$16
      ) AS state`
      const first = (await pool.query(query, values)).rows[0].state
      const replay = (await pool.query(query, values)).rows[0].state
      assert.equal(first.authorizationId, authorizationId)
      assert.equal(first.assignmentCreated, false)
      assert.equal(first.dispatchQueued, false)
      assert.equal(first.executionAuthorized, false)
      assert.equal(first.nextRequiredGate, 'enqueue_exact_assignment_plan_separately')
      assert.equal(replay.authorizationId, authorizationId)
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM control.dispatch_jobs WHERE mission_id=$1`,
        [missionId],
      )).rows[0].count, 0)
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM control.audit_events
         WHERE event->>'event'='a1_dispatch_authorization_recorded'
           AND event->>'mission_id'=$1`,
        [missionId],
      )).rows[0].count, 1)
      const changed = [...values]
      changed[11] = 'e'.repeat(64)
      await assert.rejects(pool.query(query, changed), /A1_DISPATCH_AUTHORIZATION_IMMUTABLE_CONFLICT/)
      await pool.query('ROLLBACK')
      await pool.query(await readFile(new URL('../migrations/034_a1_dispatch_execution_window.rollback.sql', import.meta.url),'utf8'))
      await pool.query(await readFile(new URL('../migrations/033_a1_dispatch_execution_arm.rollback.sql', import.meta.url),'utf8'))
      await pool.query(await readFile(new URL('../migrations/032_a1_assignment_execution_authorization.rollback.sql', import.meta.url),'utf8'))
      await pool.query(await readFile(new URL('../migrations/031_a1_assignment_enqueue_authorization.rollback.sql', import.meta.url),'utf8'))
      const rollback = await readFile(
        new URL('../migrations/030_a1_dispatch_authorization.rollback.sql', import.meta.url),
        'utf8',
      )
      await assert.rejects(pool.query(rollback), /A1_DISPATCH_AUTHORIZATION_HISTORY_PRESENT/)
      await pool.query('ROLLBACK')
    } finally {
      await destroyDatabase(admin, pool, database)
    }
  })

  it('rolls back cleanly while its ledger is empty', async () => {
    const fixture = await databaseFixture('a1_dispatch_auth_rollback')
    const { admin, pool, database } = fixture
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())
      await pool.query(await readFile(
        new URL('../migrations/034_a1_dispatch_execution_window.rollback.sql', import.meta.url),
        'utf8',
      ))
      await pool.query(await readFile(
        new URL('../migrations/033_a1_dispatch_execution_arm.rollback.sql', import.meta.url),
        'utf8',
      ))
      await pool.query(await readFile(
        new URL('../migrations/032_a1_assignment_execution_authorization.rollback.sql', import.meta.url),
        'utf8',
      ))
      const enqueueRollback = await readFile(
        new URL('../migrations/031_a1_assignment_enqueue_authorization.rollback.sql', import.meta.url),
        'utf8',
      )
      await pool.query(enqueueRollback)
      const rollback = await readFile(
        new URL('../migrations/030_a1_dispatch_authorization.rollback.sql', import.meta.url),
        'utf8',
      )
      await pool.query(rollback)
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM control.schema_migrations
         WHERE version='030_a1_dispatch_authorization'`,
      )).rows[0].count, 0)
      assert.equal((await pool.query(
        `SELECT to_regclass('control.a1_dispatch_authorizations') IS NULL AS absent`,
      )).rows[0].absent, true)
    } finally {
      await destroyDatabase(admin, pool, database)
    }
  })
})

async function databaseFixture(prefix: string) {
  const admin = new Pool({ connectionString: ADMIN })
  const database = `${prefix}_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(ADMIN!)
  url.pathname = `/${database}`
  return { admin, database, pool: new Pool({ connectionString: url.toString() }) }
}

async function destroyDatabase(admin: Pool, pool: Pool, database: string) {
  await pool.end()
  await dropTestDatabase(admin, database)
  await admin.end()
}
