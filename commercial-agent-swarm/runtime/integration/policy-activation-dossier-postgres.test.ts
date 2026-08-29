import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { applyMigrationPrefix } from './migration-prefix.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip
const names = [
  'runtime','commercial_control_plane','dispatch_queue','crm_integration','portfolio_read_models','sales_read_models','usage_budget_ledger','simulation_safety_seed','internal_automation','instruction_inbox','go_native_usage_ledger','dependency_terminalization','variable_usage_reservations','variable_usage_constraint','shadow_human_review','usage_source_not_null','external_action_kill_switch_projection','sales_mission_draft_projection','codex_instruction_review','internal_mail_attestation','commercial_policy_v2_draft','policy_human_review','policy_activation_dossier',
]
const versions = names.map((name,index) => `${String(index+1).padStart(3,'0')}_${name}`)

integration('PostgreSQL 17 policy activation dossier', () => {
  it('starts empty and remains unable to activate policy-v2', async () => {
    const admin = new Pool({ connectionString: ADMIN })
    const database = `activation_dossier_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!); url.pathname = `/${database}`
    const pool = new Pool({ connectionString: url.toString() })
    try {
      await applyMigrationPrefix(pool, versions)
      const state = (await pool.query('SELECT control.build_policy_activation_dossier_state() AS state')).rows[0].state
      assert.equal(state.authorizationRecorded, false)
      assert.equal(state.activationAllowed, false)
      assert.equal(state.activePolicyVersion, 'policy-v1')
      assert.equal(state.policyEffective, false)
      assert.equal(state.externalContact, false)
      assert.equal(state.versionActivationCreated, false)
      assert.equal(state.deliveryPolicyCreated, false)
      assert.equal(state.deliveryPolicyActivationCreated, false)
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM control.policy_activation_authorizations')).rows[0].count, 0)
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM catalog.version_activations WHERE project_id='proptimiza' AND policy_version='policy-v2'`)).rows[0].count, 0)
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM mail.delivery_policies WHERE project_id='proptimiza' AND policy_version='policy-v2'`)).rows[0].count, 0)
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM mail.external_actions`)).rows[0].count, 0)
      await pool.query(await readFile(new URL('../migrations/023_policy_activation_dossier.rollback.sql', import.meta.url), 'utf8'))
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM control.schema_migrations WHERE version='023_policy_activation_dossier'`)).rows[0].count, 0)
      assert.equal((await pool.query(`SELECT to_regclass('control.policy_activation_authorizations') AS relation`)).rows[0].relation, null)
      assert.equal((await pool.query(`SELECT to_regprocedure('control.build_policy_activation_dossier_state()') AS function`)).rows[0].function, null)
    } finally {
      await pool.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [database])
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      await admin.end()
    }
  })
})
