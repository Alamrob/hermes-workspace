import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const RUNTIME_MIGRATION = new URL('../migrations/001_runtime.sql', import.meta.url)
const COMMERCIAL_MIGRATION = new URL('../migrations/002_commercial_control_plane.sql', import.meta.url)
const COMMERCIAL_ROLLBACK = new URL('../migrations/002_commercial_control_plane.rollback.sql', import.meta.url)
const integration = ADMIN_URL ? describe : describe.skip

integration('commercial catalog/control/mail data model', () => {
  const databaseName = `proptimiza_catalog_${randomUUID().replaceAll('-', '')}`
  let admin: Pool
  let pool: Pool

  before(async () => {
    admin = new Pool({ connectionString: ADMIN_URL })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    const url = new URL(ADMIN_URL!)
    url.pathname = `/${databaseName}`
    pool = new Pool({ connectionString: url.toString(), max: 2 })
    await pool.query(`
      CREATE TABLE public.approvals (id bigint PRIMARY KEY, note text NOT NULL);
      CREATE TABLE public.agent_runs (id bigint PRIMARY KEY, state text NOT NULL);
      INSERT INTO public.approvals VALUES (41, 'legacy approval');
      INSERT INTO public.agent_runs VALUES (42, 'legacy run');
    `)
    const migrations = await Promise.all([
      readFile(RUNTIME_MIGRATION, 'utf8'),
      readFile(COMMERCIAL_MIGRATION, 'utf8'),
    ])
    for (const sql of migrations) await pool.query(sql)
    for (const sql of migrations) await pool.query(sql)
  })

  after(async () => {
    await pool?.end()
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  })

  it('keeps non-empty legacy tables and rows byte-for-byte intact', async () => {
    assert.deepEqual((await pool.query('SELECT * FROM public.approvals')).rows, [
      { id: '41', note: 'legacy approval' },
    ])
    assert.deepEqual((await pool.query('SELECT * FROM public.agent_runs')).rows, [
      { id: '42', state: 'legacy run' },
    ])
  })

  it('seeds the fixed versioned Proptimiza offer and ICP exactly once', async () => {
    const offer = await pool.query(`
      SELECT name, currency, starting_price::text AS starting_price
      FROM catalog.offer_versions
      WHERE project_id = 'proptimiza' AND offer_id = 'operacion-sin-planillas' AND version = 'offer-v1'
    `)
    assert.deepEqual(offer.rows, [{
      name: 'Operación Sin Planillas',
      currency: 'CLP',
      starting_price: '1800000.00',
    }])
    const icp = await pool.query(`
      SELECT country_code, business_model, sector, employee_min, employee_max, operational_signals
      FROM catalog.icp_versions
      WHERE project_id = 'proptimiza' AND version = 'icp-v1'
    `)
    assert.deepEqual(icp.rows, [{
      country_code: 'CL',
      business_model: 'B2B',
      sector: 'services',
      employee_min: 10,
      employee_max: 100,
      operational_signals: ['Excel', 'WhatsApp', 'correo'],
    }])
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM catalog.offer_versions`)).rows[0].count, 1)
    const frozen = await pool.query(`SELECT
      (SELECT row_to_json(p) FROM (SELECT project_id,display_name FROM catalog.projects WHERE project_id='proptimiza') p) AS project,
      (SELECT row_to_json(v) FROM (SELECT project_id,version,display_name,status FROM catalog.project_versions WHERE project_id='proptimiza') v) AS project_version,
      (SELECT policy FROM catalog.policy_versions WHERE project_id='proptimiza' AND version='policy-v1') AS policy,
      (SELECT row_to_json(d) FROM (SELECT project_id,policy_version,sender,recipient,maximum_volume,active,valid_until FROM mail.delivery_policies WHERE project_id='proptimiza') d) AS delivery`)
    assert.deepEqual(frozen.rows[0].project, { project_id: 'proptimiza', display_name: 'Proptimiza' })
    assert.equal(frozen.rows[0].project_version.status, 'active')
    assert.deepEqual(frozen.rows[0].policy, { external_contact: false, mail_sender: 'ventas@proptimiza.com', mail_recipient: 'contacto@proptimiza.com', maximum_volume: 1 })
    assert.equal(frozen.rows[0].delivery.policy_version, 'policy-v1')
  })

  it('enforces catalog versions, domain checks, and immutable seeded records', async () => {
    await assert.rejects(
      pool.query(`UPDATE catalog.offer_versions SET starting_price = 1 WHERE project_id = 'proptimiza'`),
      /VERSIONED_CATALOG_IMMUTABLE/,
    )
    await assert.rejects(
      pool.query(`DELETE FROM catalog.icp_versions WHERE project_id = 'proptimiza'`),
      /VERSIONED_CATALOG_IMMUTABLE/,
    )
    await assert.rejects(
      pool.query(`UPDATE mail.delivery_policies SET active = false WHERE project_id = 'proptimiza'`),
      /DELIVERY_POLICY_IMMUTABLE/,
    )
    await pool.query(`INSERT INTO control.deployed_versions VALUES ('runtime-v1', '${'a'.repeat(64)}', clock_timestamp())`)
    await assert.rejects(
      pool.query(`DELETE FROM control.deployed_versions WHERE deployed_version = 'runtime-v1'`),
      /DEPLOYED_VERSION_IMMUTABLE/,
    )
    await assert.rejects(
      pool.query(`INSERT INTO catalog.offer_versions
        (project_id, offer_id, version, project_version, name, currency, starting_price, description)
        VALUES ('proptimiza', 'bad', 'v1', 'v1', 'Bad', 'CLP', -1, 'invalid')`),
      /offer_versions_starting_price_check/,
    )
    await assert.rejects(
      pool.query(`INSERT INTO mail.delivery_policies
        (project_id, policy_version, sender, recipient, maximum_volume, active)
        VALUES ('proptimiza', 'missing', 'ventas@proptimiza.com', 'contacto@proptimiza.com', 1, true)`),
      /foreign key constraint/,
    )
    await assert.rejects(
      pool.query(`INSERT INTO mail.delivery_policies
        (project_id, policy_version, sender, recipient, maximum_volume, active)
        VALUES ('proptimiza', 'policy-v1', 'other@proptimiza.com', 'contacto@proptimiza.com', 1, true)`),
      /duplicate key value/,
    )
    await assert.rejects(pool.query(`INSERT INTO catalog.project_versions(project_id,version,display_name,status) VALUES('proptimiza','v2','conflict','active')`), /project_versions_one_active_uq/)
  })

  it('indexes every foreign-key column set in catalog, control, and mail', async () => {
    const missing = await pool.query(`
      SELECT conrelid::regclass::text AS table_name, conname
      FROM pg_constraint AS c
      WHERE c.contype = 'f'
        AND c.connamespace IN ('catalog'::regnamespace, 'control'::regnamespace, 'mail'::regnamespace)
        AND NOT EXISTS (
          SELECT 1 FROM pg_index AS i
          WHERE i.indrelid = c.conrelid
            AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey
        )
    `)
    assert.deepEqual(missing.rows, [])
  })

  it('creates four non-login capability roles and removes direct sensitive-table privileges', async () => {
    const roles = await pool.query(`
      SELECT rolname, rolcanlogin, rolsuper
      FROM pg_roles WHERE rolname IN ('commercial_runtime', 'commercial_approver', 'commercial_safety_operator', 'commercial_observer')
      ORDER BY rolname
    `)
    assert.deepEqual(roles.rows, [
      { rolname: 'commercial_approver', rolcanlogin: false, rolsuper: false },
      { rolname: 'commercial_observer', rolcanlogin: false, rolsuper: false },
      { rolname: 'commercial_runtime', rolcanlogin: false, rolsuper: false },
      { rolname: 'commercial_safety_operator', rolcanlogin: false, rolsuper: false },
    ])
    for (const statement of [
      `UPDATE control.approvals SET status = 'denied'`,
      `UPDATE control.kill_switches SET active = false`,
      `UPDATE mail.external_actions SET receipt_id = 'forged'`,
    ]) await assert.rejects(queryAsRole(pool, 'commercial_runtime', statement), /permission denied/)
    for (const table of ['control.missions', 'control.approvals', 'mail.webhook_events']) {
      await assert.rejects(queryAsRole(pool, 'commercial_observer', `SELECT * FROM ${table}`), /permission denied/)
    }
    assert.equal((await queryAsRole(pool, 'commercial_observer', 'SELECT count(*)::int AS count FROM control.mission_summaries')).rows[0].count, 0)
  })

  it('limits approver and safety roles to their narrow CAS functions', async () => {
    const approvalId = '723e4567-e89b-42d3-a456-426614174000'
    const missionId = '823e4567-e89b-42d3-a456-426614174000'
    const action = { mission_id: missionId, action_type: 'mail.send' }
    await queryAsRole(pool, 'commercial_runtime',
      `SELECT control.request_approval($1,$2::jsonb,$3,$4::timestamptz)`,
      [approvalId, JSON.stringify(action), 'a'.repeat(64), '2026-08-15T20:00:00Z'])
    assert.equal((await queryAsRole(pool, 'commercial_approver',
      `SELECT control.decide_approval($1,'approved','human-director',$2::timestamptz,$3,$4,NULL,$5::jsonb,$6,$7::timestamptz) AS decided`,
      [approvalId, '2026-08-15T20:15:00Z', '00112233445566778899aabbccddeeff', `APPROVAL::${missionId}`, JSON.stringify(action), 'a'.repeat(64), '2026-08-15T20:00:00Z'])).rows[0].decided, true)
    assert.equal((await queryAsRole(pool, 'commercial_approver',
      `SELECT control.decide_approval($1,'denied',NULL,NULL,NULL,NULL,NULL,$2::jsonb,$3,$4::timestamptz) AS decided`, [approvalId, JSON.stringify(action), 'a'.repeat(64), '2026-08-15T20:00:00Z'])).rows[0].decided, false)
    await assert.rejects(queryAsRole(pool, 'commercial_approver',
      `SELECT control.consume_approval($1,$2,$3,clock_timestamp())`, [missionId, 'a'.repeat(64), '00112233445566778899aabbccddeeff']), /permission denied/)
    await assert.rejects(queryAsRole(pool, 'commercial_approver',
      `SELECT control.set_kill_switch('global','*',true)`), /permission denied/)

    assert.equal((await queryAsRole(pool, 'commercial_safety_operator',
      `SELECT control.set_kill_switch('global','*',true) AS changed`)).rows[0].changed, true)
    assert.equal((await queryAsRole(pool, 'commercial_safety_operator',
      `SELECT control.set_kill_switch('global','*',false) AS changed`)).rows[0].changed, true)
    await assert.rejects(queryAsRole(pool, 'commercial_safety_operator',
      `SELECT control.decide_approval($1,'denied',NULL,NULL,NULL,NULL,NULL,$2::jsonb,$3,$4::timestamptz)`, [approvalId, JSON.stringify(action), 'a'.repeat(64), '2026-08-15T20:00:00Z']), /permission denied/)
  })

  it('normalizes unexpected grants and rejects unsafe pre-existing role attributes', async () => {
    await pool.query('GRANT UPDATE ON control.approvals TO commercial_observer')
    await pool.query(await readFile(COMMERCIAL_MIGRATION, 'utf8'))
    assert.equal((await pool.query(`SELECT has_table_privilege('commercial_observer','control.approvals','UPDATE') AS allowed`)).rows[0].allowed, false)
    await pool.query('ALTER ROLE commercial_observer LOGIN')
    try {
      await assert.rejects(pool.query(await readFile(COMMERCIAL_MIGRATION, 'utf8')), /UNSAFE_PREEXISTING_ROLE/)
    } finally {
      await pool.query('ALTER ROLE commercial_observer NOLOGIN')
    }
  })

  it('rolls back only migration 002 objects and preserves runtime plus legacy rows', async () => {
    const rollbackDatabase = `proptimiza_rollback_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${rollbackDatabase}"`)
    const url = new URL(ADMIN_URL!)
    url.pathname = `/${rollbackDatabase}`
    const rollbackPool = new Pool({ connectionString: url.toString() })
    try {
      await rollbackPool.query(`CREATE TABLE public.approvals (id bigint PRIMARY KEY); INSERT INTO public.approvals VALUES (9)`)
      await rollbackPool.query(await readFile(RUNTIME_MIGRATION, 'utf8'))
      await rollbackPool.query(await readFile(COMMERCIAL_MIGRATION, 'utf8'))
      await rollbackPool.query(await readFile(COMMERCIAL_ROLLBACK, 'utf8'))
      assert.equal((await rollbackPool.query(`SELECT to_regclass('control.missions') AS runtime, to_regclass('catalog.projects') AS catalog`)).rows[0].runtime, 'control.missions')
      assert.equal((await rollbackPool.query(`SELECT to_regclass('catalog.projects') AS catalog`)).rows[0].catalog, null)
      assert.deepEqual((await rollbackPool.query('SELECT * FROM public.approvals')).rows, [{ id: '9' }])
    } finally {
      await rollbackPool.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [rollbackDatabase])
      await admin.query(`DROP DATABASE IF EXISTS "${rollbackDatabase}"`)
    }
  })
})

async function queryAsRole(pool: Pool, role: string, sql: string, parameters: unknown[] = []) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL ROLE ${role}`)
    const result = await client.query(sql, parameters)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
