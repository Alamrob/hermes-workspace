import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { dropTestDatabase } from './database-cleanup.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip

integration('PostgreSQL A0 behavior authority', () => {
  it('permits fresh execution and records one exact known result after expiry hold', async () => {
    const fixture = await databaseFixture('a0_behavior_authority')
    const { admin, pool, database } = fixture
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())
      const runId = randomUUID()
      const batchId = `a0:${runId}:t01`
      const source = 'a'.repeat(64)
      const batch = 'b'.repeat(64)
      const idempotency = `a0:${source}:${batch}`
      const expiresAt = new Date(Date.now() + 1_000).toISOString()
      const client = await pool.connect()
      try {
        await client.query('SET ROLE commercial_a0_behavior_ledger')
        const reserved = await client.query(
          `SELECT control.reserve_a0_behavior_batch(
            $1::text,$2::uuid,$3::text,$4::text,6000000,$5::timestamptz) AS value`,
          [idempotency, runId, batchId, batch, expiresAt],
        )
        assert.deepEqual(reserved.rows[0].value, {
          disposition: 'created',
          state: 'reserved',
          version: 1,
        })
        for (let check = 0; check < 2; check += 1) {
          const permit = await client.query(
            `SELECT control.acquire_a0_behavior_execution_permit(
              $1::uuid,$2::text,1) AS granted`,
            [runId, batchId],
          )
          assert.equal(permit.rows[0].granted, true)
        }
        await client.query('SELECT pg_sleep(1.1)')
        const settled = await client.query(
          `SELECT control.settle_a0_behavior_batch(
            $1::uuid,$2::text,1,5000000,$3::text) AS applied`,
          [runId, batchId, 'usage-late-known-1'],
        )
        assert.equal(settled.rows[0].applied, true)
        const exactReplay = await client.query(
          `SELECT control.settle_a0_behavior_batch(
            $1::uuid,$2::text,1,5000000,$3::text) AS applied`,
          [runId, batchId, 'usage-late-known-1'],
        )
        assert.equal(exactReplay.rows[0].applied, true)
        const lookup = await client.query(
          `SELECT control.get_a0_behavior_batch_settlement(
            $1::uuid,$2::text,1,5000000,$3::text) AS value`,
          [runId, batchId, 'usage-late-known-1'],
        )
        assert.deepEqual(lookup.rows[0].value, {
          status: 'confirmed',
          state: 'settled',
          version: 3,
        })
        const replay = await client.query(
          `SELECT control.reserve_a0_behavior_batch(
            $1::text,$2::uuid,$3::text,$4::text,6000000,$5::timestamptz) AS value`,
          [idempotency, runId, batchId, batch, expiresAt],
        )
        assert.deepEqual(replay.rows[0].value, {
          disposition: 'replayed',
          state: 'settled',
          version: 3,
        })
      } finally {
        await client.query('RESET ROLE')
        client.release()
      }
      const evidence = await pool.query(
        `SELECT
          (SELECT array_agg(version ORDER BY version) FROM control.a0_behavior_batch_ledger
            WHERE run_id=$1 AND batch_id=$2) AS versions,
          (SELECT count(*)::int FROM control.usage_record_registry
            WHERE provider_id='opencode-go' AND usage_record_id='usage-late-known-1') AS registry_count,
          (SELECT count(*)::int FROM control.audit_events
            WHERE event->>'event'='a0_behavior_batch_settled'
              AND event->>'run_id'=$1::text AND event->>'batch_id'=$2) AS settlement_audits,
          (SELECT quarantined FROM control.usage_budget_control WHERE control_id=1) AS quarantined`,
        [runId, batchId],
      )
      assert.deepEqual(evidence.rows[0], {
        versions: ['1', '2', '3'],
        registry_count: 1,
        settlement_audits: 1,
        quarantined: true,
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
