import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import {
  assertSimulationKillSwitchActive,
  assertSimulationSafetyBoundary,
} from '../src/broker-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { PostgresRuntimeRepository } from '../src/postgres-repository.js'
import { dropTestDatabase } from './database-cleanup.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip

integration('PostgreSQL simulation safety seed', { concurrency: 1 }, () => {
  const database = `safety_seed_${randomUUID().replaceAll('-', '')}`
  let admin: Pool
  let pool: Pool
  let sources: Array<{ version: string; sql: string }>

  before(async () => {
    admin = new Pool({ connectionString: ADMIN })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.toString() })
    sources = await Promise.all(
      [
        '001_runtime',
        '002_commercial_control_plane',
        '003_dispatch_queue',
        '004_crm_integration',
        '005_portfolio_read_models',
        '006_sales_read_models',
        '007_usage_budget_ledger',
        '008_simulation_safety_seed',
        '009_internal_automation',
        '010_instruction_inbox',
        '011_go_native_usage_ledger',
        '012_dependency_terminalization',
        '013_variable_usage_reservations',
        '014_variable_usage_constraint',
        '015_shadow_human_review',
        '016_usage_source_not_null',
        '017_external_action_kill_switch_projection',
        '018_sales_mission_draft_projection',
        '019_codex_instruction_review',
        '020_internal_mail_attestation',
        '021_commercial_policy_v2_draft',
        '022_policy_human_review',
        '023_policy_activation_dossier',
        '024_draft_internal_review',
        '025_a1_research_dossier',
        '026_a1_research_authorization',
        '027_a1_research_order_authorization',
        '028_ed25519_a1_work_orders',
        '029_a1_authorization_renewal',
        '030_a1_dispatch_authorization',
        '031_a1_assignment_enqueue_authorization',
        '032_a1_assignment_execution_authorization',
      ].map(async (version) => ({
        version,
        sql: await readFile(
          new URL(`../migrations/${version}.sql`, import.meta.url),
          'utf8',
        ),
      })),
    )
  })

  after(async () => {
    await pool.end()
    await dropTestDatabase(admin, database)
    await admin.end()
  })

  it('seeds every external channel fail-closed and exposes closed execution projections', async () => {
    await runVersionedMigrations(pool, sources)
    const channels = await pool.query<{ scope_id: string; active: boolean }>(
      `SELECT scope_id,active
         FROM control.kill_switches
        WHERE scope='channel'
        ORDER BY scope_id`,
    )
    assert.deepEqual(channels.rows, [
      { scope_id: 'calendar', active: true },
      { scope_id: 'crm', active: true },
      { scope_id: 'email', active: true },
      { scope_id: 'public_web', active: true },
      { scope_id: 'telephone', active: true },
      { scope_id: 'web_chat', active: true },
      { scope_id: 'whatsapp', active: true },
    ])
    assert.equal(
      (await pool.query(`SELECT control.external_actions_blocked() AS blocked`))
        .rows[0].blocked,
      true,
    )
    await assertSimulationSafetyBoundary(
      new PostgresRuntimeRepository(pool),
      false,
    )
    const missingMission = randomUUID()
    assert.deepEqual(
      (
        await pool.query(`SELECT control.get_mission_execution($1) AS value`, [
          missingMission,
        ])
      ).rows[0].value,
      { mission_id: missingMission, status: 'completed', assignments: [] },
    )

    const rollback = await readFile(
      new URL('../migrations/009_internal_automation.rollback.sql', import.meta.url),
      'utf8',
    )
    await pool.query(rollback)
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS count
             FROM control.kill_switches
            WHERE scope='channel' AND active`,
        )
      ).rows[0].count,
      7,
    )
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS count
             FROM control.schema_migrations
            WHERE version='009_internal_automation'`,
        )
      ).rows[0].count,
      0,
    )
    await runVersionedMigrations(pool, sources)
  })

  it('starts fresh simulation safe, preserves safety on rollback, and never overwrites an existing false', async () => {
    await runVersionedMigrations(pool, sources)
    assert.deepEqual(await globalSwitch(pool), {
      active: true,
      count: 1,
    })
    await assertSimulationKillSwitchActive(new PostgresRuntimeRepository(pool))
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM control.schema_migrations`,
        )
      ).rows[0].count,
      32,
    )

    const rollback = await readFile(
      new URL('../migrations/008_simulation_safety_seed.rollback.sql', import.meta.url),
      'utf8',
    )
    await pool.query(rollback)
    assert.deepEqual(await globalSwitch(pool), { active: true, count: 1 })
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM control.schema_migrations
            WHERE version='008_simulation_safety_seed'`,
        )
      ).rows[0].count,
      0,
    )
    await runVersionedMigrations(pool, sources)
    assert.deepEqual(await globalSwitch(pool), { active: true, count: 1 })

    await pool.query(rollback)
    await pool.query(
      `UPDATE control.kill_switches SET active=false
        WHERE scope='global' AND scope_id='*'`,
    )
    await runVersionedMigrations(pool, sources)
    assert.deepEqual(await globalSwitch(pool), { active: false, count: 1 })
    await assert.rejects(
      assertSimulationKillSwitchActive(new PostgresRuntimeRepository(pool)),
      /SIMULATION_KILL_SWITCH_NOT_ACTIVE/,
    )
  })
})

async function globalSwitch(pool: Pool) {
  const result = await pool.query<{ active: boolean; count: number }>(
    `SELECT bool_and(active) AS active,count(*)::int AS count
       FROM control.kill_switches
      WHERE scope='global' AND scope_id='*'`,
  )
  return result.rows[0]
}
