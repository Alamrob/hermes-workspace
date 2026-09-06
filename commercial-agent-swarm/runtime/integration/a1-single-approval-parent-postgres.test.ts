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
const stages = [
  'audit_terminal_state',
  'consume_parent_authorization',
  'create_execution_arm',
  'dispatch_bounded_dag',
  'materialize_exact_job_set',
  'open_execution_window',
  'recontain_execution_window',
  'register_assignment_plan_authorization',
  'register_enqueue_authorization',
  'register_execution_authorization',
] as const

integration('PostgreSQL A1 single-approval parent capability', () => {
  it('consumes one exact parent, exposes a safe projection, and rejects replay', async () => {
    const fixture = await databaseFixture('a1_single_parent')
    const { admin, pool, database } = fixture
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())
      const now = new Date()
      const missionId = randomUUID()
      const traceId = randomUUID()
      const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString()
      await pool.query(
        `INSERT INTO control.missions(mission_id,idempotency_key,payload)
         VALUES($1,$2,$3::jsonb)`,
        [
          missionId,
          `a1-single-parent:${missionId}`,
          JSON.stringify({
            mission_id: missionId,
            trace_id: traceId,
            autonomy_level: 'A1',
            dry_run: true,
            expires_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
            contact_policy: { contact_permitted: false },
            volume_limits: { maximum_external_actions: 0 },
          }),
        ],
      )
      const stageReceiptKeys = Object.fromEntries(
        stages.map((stage, index) => [stage, (index + 1).toString(16).repeat(64)]),
      )
      const parent = {
        assignment_ids: Array.from({ length: 6 }, () => randomUUID()),
        assignment_plan_sha256: 'a'.repeat(64),
        authorization_digest_sha256: 'b'.repeat(64),
        expected_mission_sha256: 'c'.repeat(64),
        expires_at: expiresAt,
        idempotency_key: stageReceiptKeys.consume_parent_authorization,
        job_set_sha256: 'd'.repeat(64),
        maximum_dispatch_ticks: 6,
        maximum_provider_credit_spend_usd: 0.06,
        mission_id: missionId,
        request_id: randomUUID(),
        reviewed_at: now.toISOString(),
        reviewer_email: 'proptimizaspa@gmail.com',
        reviewer_id: 'user:proptimizaspa@gmail.com',
        stage_receipt_key: stageReceiptKeys.consume_parent_authorization,
        stage_receipt_keys: stageReceiptKeys,
        trace_id: traceId,
        user_authorization_sha256: 'e'.repeat(64),
        worker_id: 'broker-dispatcher-1',
      }
      const runner = await pool.connect()
      try {
        await runner.query('SET ROLE commercial_a1_chain_runner')
        const result = await runner.query(
          `SELECT control.consume_a1_single_approval_parent($1::jsonb) AS value`,
          [JSON.stringify(parent)],
        )
        assert.deepEqual(result.rows[0].value, { consumed: true })
        const state = await runner.query(
          `SELECT control.get_a1_single_approval_chain_state($1::uuid) AS value`,
          [missionId],
        )
        assert.equal(state.rows[0].value.parent_authorization_consumed, true)
        assert.equal(state.rows[0].value.global_kill, true)
        assert.equal(state.rows[0].value.channel_kills, 7)
        assert.equal(state.rows[0].value.external_actions, 0)
        assert.equal(state.rows[0].value.crm_outbox, 0)
        await assert.rejects(
          runner.query(
            `SELECT control.consume_a1_single_approval_parent($1::jsonb)`,
            [JSON.stringify(parent)],
          ),
          /A1_SINGLE_APPROVAL_PARENT_ALREADY_CONSUMED/,
        )
        const recontained = await runner.query(
          `SELECT control.recontain_a1_single_approval_chain($1::uuid,$2) AS value`,
          [missionId, 'A1_SINGLE_APPROVAL_CHAIN_COMPLETED'],
        )
        assert.deepEqual(recontained.rows[0].value, { recontained: true })
      } finally {
        await runner.query('RESET ROLE')
        runner.release()
      }
      const privileges = await pool.query(
        `SELECT
           has_table_privilege('commercial_a1_chain_runner',
             'control.a1_single_approval_parent_consumptions','SELECT') AS table_read,
           has_function_privilege('commercial_a1_chain_runner',
             'control.consume_a1_single_approval_parent(jsonb)','EXECUTE') AS consume,
           has_function_privilege('commercial_a1_chain_runner',
             'control.get_a1_single_approval_chain_state(uuid)','EXECUTE') AS inspect,
           has_function_privilege('commercial_a1_chain_runner',
             'control.recontain_a1_single_approval_chain(uuid,text)','EXECUTE') AS recontain`,
      )
      assert.deepEqual(privileges.rows[0], {
        table_read: false,
        consume: true,
        inspect: true,
        recontain: true,
      })
      await assert.rejects(
        pool.query(await readFile(
          new URL('../migrations/037_a1_single_approval_parent.rollback.sql', import.meta.url),
          'utf8',
        )),
        /A1_SINGLE_APPROVAL_ROLLBACK_REQUIRES_EMPTY_CONTAINED_LEDGER/,
      )
      await pool.query('ROLLBACK')
    } finally {
      await destroyDatabase(admin, pool, database)
    }
  })

  it('rolls back only an empty, fully contained parent capability', async () => {
    const fixture = await databaseFixture('a1_single_parent_rollback')
    const { admin, pool, database } = fixture
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())
      await pool.query(await readFile(
        new URL('../migrations/037_a1_single_approval_parent.rollback.sql', import.meta.url),
        'utf8',
      ))
      const state = await pool.query(
        `SELECT
           to_regclass('control.a1_single_approval_parent_consumptions') IS NULL AS table_absent,
           to_regprocedure('control.consume_a1_single_approval_parent(jsonb)') IS NULL AS function_absent,
           NOT EXISTS(SELECT 1 FROM control.schema_migrations
             WHERE version='037_a1_single_approval_parent') AS history_absent`,
      )
      assert.deepEqual(state.rows[0], {
        table_absent: true,
        function_absent: true,
        history_absent: true,
      })
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
