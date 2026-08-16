import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { runVersionedMigrations } from '../src/migration-runner.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip

integration('PostgreSQL 17 versioned migration runner', () => {
  it('applies each exact migration once and rejects changed recorded history', async () => {
    const admin = new Pool({ connectionString: ADMIN })
    const database = `migration_runner_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    const pool = new Pool({ connectionString: url.toString() })
    try {
      const sources = await Promise.all(
        [
          '001_runtime',
          '002_commercial_control_plane',
          '003_dispatch_queue',
          '004_crm_integration',
          '005_portfolio_read_models',
          '006_sales_read_models',
        ].map(async (version) => ({
          version,
          sql: await readFile(
            new URL(`../migrations/${version}.sql`, import.meta.url),
            'utf8',
          ),
        })),
      )
      await runVersionedMigrations(pool, sources)
      await runVersionedMigrations(pool, sources)
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS count FROM control.schema_migrations`,
          )
        ).rows[0].count,
        6,
      )
      const rollback006 = await readFile(
        new URL('../migrations/006_sales_read_models.rollback.sql', import.meta.url),
        'utf8',
      )
      await pool.query(rollback006)
      assert.equal(
        (await pool.query(
          `SELECT count(*)::int AS count FROM control.schema_migrations
           WHERE version='006_sales_read_models'`,
        )).rows[0].count,
        0,
      )
      assert.equal(
        (await pool.query(
          `SELECT has_function_privilege('commercial_runtime','control.get_portfolio_read_model()','EXECUTE') AS allowed`,
        )).rows[0].allowed,
        false,
      )
      await runVersionedMigrations(pool, sources)
      assert.equal(
        Array.isArray((await pool.query(
          `SELECT control.get_portfolio_read_model() AS model`,
        )).rows[0].model.portfolio),
        true,
      )
      const rollback005 = await readFile(
        new URL('../migrations/005_portfolio_read_models.rollback.sql', import.meta.url),
        'utf8',
      )
      await pool.query(rollback005)
      assert.equal(
        (await pool.query(
          `SELECT count(*)::int AS count FROM control.schema_migrations
           WHERE version IN('005_portfolio_read_models','006_sales_read_models')`,
        )).rows[0].count,
        0,
      )
      assert.equal(
        (await pool.query(`SELECT count(*)::int AS count FROM catalog.project_inventory`)).rows[0].count,
        26,
      )
      await runVersionedMigrations(pool, sources)
      assert.equal(
        (await pool.query(
          `SELECT count(*)::int AS count FROM control.schema_migrations
           WHERE version='005_portfolio_read_models'`,
        )).rows[0].count,
        1,
      )
      assert.equal(
        (await pool.query(
          `SELECT has_function_privilege('commercial_runtime','control.get_portfolio_read_model()','EXECUTE') AS allowed`,
        )).rows[0].allowed,
        true,
      )
      assert.equal(
        Array.isArray((await pool.query(
          `SELECT control.get_portfolio_read_model() AS model`,
        )).rows[0].model.portfolio),
        true,
      )
      await pool.query(
        `UPDATE control.schema_migrations SET sha256=$1 WHERE version='003_dispatch_queue'`,
        ['0'.repeat(64)],
      )
      await assert.rejects(
        runVersionedMigrations(pool, sources),
        /MIGRATION_HASH_MISMATCH:003_dispatch_queue/,
      )
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
