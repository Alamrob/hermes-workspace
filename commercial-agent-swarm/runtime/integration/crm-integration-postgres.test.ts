import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { runVersionedMigrations } from '../src/migration-runner.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip

integration('PostgreSQL 17 CRM integration control plane', () => {
  it('bounds the pilot, provides least-privilege durable sync, and rolls back without data loss', async () => {
    const admin = new Pool({ connectionString: ADMIN })
    const database = `crm_integration_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    const pool = new Pool({ connectionString: url.toString() })
    try {
      const versions = [
        '001_runtime',
        '002_commercial_control_plane',
        '003_dispatch_queue',
        '004_crm_integration',
      ]
      const sources = await Promise.all(
        versions.map(async (version) => ({
          version,
          sql: await readFile(
            new URL(`../migrations/${version}.sql`, import.meta.url),
            'utf8',
          ),
        })),
      )
      await runVersionedMigrations(pool, sources)

      const cohortId = randomUUID()
      await pool.query(`SET ROLE commercial_runtime`)
      await pool.query(
        `SELECT integration.create_pilot_cohort($1,'proptimiza','shadow-pilot')`,
        [cohortId],
      )
      const targetIds: string[] = []
      for (let index = 0; index < 10; index += 1) {
        const targetId = randomUUID()
        targetIds.push(targetId)
        await pool.query(
          `SELECT integration.add_pilot_target($1,$2,$3,$4,$5)`,
          [cohortId, targetId, `account-${index}`, `Company ${index}`, {}],
        )
      }
      await assert.rejects(
        pool.query(
          `SELECT integration.add_pilot_target($1,$2,$3,$4,$5)`,
          [cohortId, randomUUID(), 'account-10', 'Company 10', {}],
        ),
        /PILOT_TARGET_LIMIT_EXCEEDED/,
      )

      const outboxId = randomUUID()
      await pool.query(
        `SELECT integration.enqueue_crm_change($1,$2,$3,'upsert_account',$4,1)`,
        [outboxId, cohortId, targetIds[0], { name: 'Company 0' }],
      )
      await assert.rejects(
        pool.query(
          `SELECT integration.enqueue_crm_change($1,$2,$3,'upsert_account',$4,1)`,
          [randomUUID(), cohortId, targetIds[0], { name: 'Changed' }],
        ),
        /CRM_IDEMPOTENCY_CONFLICT/,
      )

      await pool.query(`RESET ROLE`)
      await pool.query(`SET ROLE commercial_safety_operator`)
      await pool.query(`SELECT integration.set_crm_sync_enabled(true)`)
      await pool.query(`RESET ROLE`)
      await pool.query(`SET ROLE commercial_crm_sync`)
      const claimed = await pool.query(
        `SELECT outbox_id FROM integration.claim_crm_outbox('worker-1',60)`,
      )
      assert.equal(claimed.rows[0].outbox_id, outboxId)
      await pool.query(
        `SELECT integration.complete_crm_outbox($1,'worker-1','remote-1','v1')`,
        [outboxId],
      )
      assert.equal(
        (
          await pool.query(
            `SELECT integration.store_crm_inbox('twenty','event-1','account','remote-1','v1',$1) AS inserted`,
            [{ id: 'remote-1', name: 'Company 0' }],
          )
        ).rows[0].inserted,
        true,
      )
      assert.equal(
        (
          await pool.query(
            `SELECT integration.store_crm_inbox('twenty','event-1','account','remote-1','v1',$1) AS inserted`,
            [{ id: 'remote-1', name: 'Company 0' }],
          )
        ).rows[0].inserted,
        false,
      )
      assert.equal(
        (
          await pool.query(
            `SELECT integration.advance_crm_cursor('twenty','accounts',0,'cursor-1') AS version`,
          )
        ).rows[0].version,
        '1',
      )
      await assert.rejects(
        pool.query(
          `SELECT integration.advance_crm_cursor('twenty','accounts',0,'cursor-stale')`,
        ),
        /CRM_CURSOR_CONFLICT/,
      )
      await pool.query(`RESET ROLE`)

      const rollback = await readFile(
        new URL('../migrations/004_crm_integration.rollback.sql', import.meta.url),
        'utf8',
      )
      await pool.query(rollback)
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS count FROM integration.pilot_targets`,
          )
        ).rows[0].count,
        10,
      )
      assert.equal(
        (
          await pool.query(
            `SELECT enabled FROM integration.sync_control WHERE control_id=1`,
          )
        ).rows[0].enabled,
        false,
      )
      await pool.query(`SET ROLE commercial_crm_sync`)
      await assert.rejects(
        pool.query(`SELECT * FROM integration.crm_outbox`),
        /permission denied/,
      )
      await pool.query(`RESET ROLE`)
    } finally {
      await pool.end()
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`,
        [database],
      )
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      await admin.end()
    }
  })
})
