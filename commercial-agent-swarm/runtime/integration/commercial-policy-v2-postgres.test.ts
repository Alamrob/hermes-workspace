import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { runVersionedMigrations } from '../src/migration-runner.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip
const versions = [
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
]

integration('PostgreSQL 17 commercial policy v2 draft', () => {
  it('registers one exact immutable draft without activating delivery or external contact', async () => {
    const admin = new Pool({ connectionString: ADMIN })
    const database = `commercial_policy_v2_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    const pool = new Pool({ connectionString: url.toString() })
    try {
      await runVersionedMigrations(pool, await Promise.all(versions.map(async (version) => ({
        version,
        sql: await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8'),
      }))))
      const expected = JSON.parse(await readFile(
        new URL('../policies/proptimiza-commercial-policy-v2.json', import.meta.url),
        'utf8',
      ))
      const registered = await pool.query(
        `SELECT project_id,version,project_version,policy
         FROM catalog.policy_versions
         WHERE project_id='proptimiza' AND version='policy-v2'`,
      )
      assert.deepEqual(registered.rows, [{
        project_id: 'proptimiza',
        version: 'policy-v2',
        project_version: 'v1',
        policy: expected,
      }])
      assert.equal(registered.rows[0].policy.status, 'draft_human_approval_required')
      assert.equal(registered.rows[0].policy.effective, false)
      assert.equal(registered.rows[0].policy.external_contact, false)
      assert.equal(registered.rows[0].policy.human_review.completed, false)
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM catalog.version_activations
         WHERE project_id='proptimiza' AND policy_version='policy-v2'`,
      )).rows[0].count, 0)
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM mail.delivery_policies
         WHERE project_id='proptimiza' AND policy_version='policy-v2'`,
      )).rows[0].count, 0)
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM mail.delivery_policy_activations
         WHERE project_id='proptimiza' AND policy_version='policy-v2'`,
      )).rows[0].count, 0)
      assert.equal((await pool.query(
        `SELECT policy_version FROM catalog.current_version_activation
         WHERE project_id='proptimiza'`,
      )).rows[0].policy_version, 'policy-v1')
      await assert.rejects(
        pool.query(`UPDATE catalog.policy_versions SET policy='{}'::jsonb WHERE project_id='proptimiza' AND version='policy-v2'`),
        /VERSIONED_CATALOG_IMMUTABLE/,
      )
      await assert.rejects(
        pool.query(`DELETE FROM catalog.policy_versions WHERE project_id='proptimiza' AND version='policy-v2'`),
        /VERSIONED_CATALOG_IMMUTABLE/,
      )
      await pool.query(await readFile(new URL('../migrations/023_policy_activation_dossier.rollback.sql', import.meta.url), 'utf8'))
      await pool.query(await readFile(new URL('../migrations/022_policy_human_review.rollback.sql', import.meta.url), 'utf8'))
      const rollback = await readFile(
        new URL('../migrations/021_commercial_policy_v2_draft.rollback.sql', import.meta.url),
        'utf8',
      )
      await pool.query(rollback)
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM catalog.policy_versions
         WHERE project_id='proptimiza' AND version='policy-v2'`,
      )).rows[0].count, 0)
      assert.equal((await pool.query(
        `SELECT policy_version FROM catalog.current_version_activation
         WHERE project_id='proptimiza'`,
      )).rows[0].policy_version, 'policy-v1')
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
