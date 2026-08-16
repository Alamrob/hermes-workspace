import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const RUNTIME_MIGRATION = new URL('../migrations/001_runtime.sql', import.meta.url)
const COMMERCIAL_MIGRATION = new URL('../migrations/002_commercial_control_plane.sql', import.meta.url)
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
      WHERE project_id = 'proptimiza' AND offer_id = 'operacion-sin-planillas' AND version = 'v1'
    `)
    assert.deepEqual(offer.rows, [{
      name: 'Operación Sin Planillas',
      currency: 'CLP',
      starting_price: '1800000.00',
    }])
    const icp = await pool.query(`
      SELECT country_code, business_model, sector, employee_min, employee_max
      FROM catalog.icp_versions
      WHERE project_id = 'proptimiza' AND version = 'v1'
    `)
    assert.deepEqual(icp.rows, [{
      country_code: 'CL',
      business_model: 'B2B',
      sector: 'services',
      employee_min: 10,
      employee_max: 100,
    }])
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM catalog.offer_versions`)).rows[0].count, 1)
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
      pool.query(`INSERT INTO catalog.offer_versions
        (project_id, offer_id, version, project_version, name, currency, starting_price, description)
        VALUES ('proptimiza', 'bad', 'v1', 'v1', 'Bad', 'CLP', -1, 'invalid')`),
      /offer_versions_starting_price_check/,
    )
    await assert.rejects(
      pool.query(`INSERT INTO mail.delivery_policies
        (project_id, policy_version, sender, recipient, maximum_volume)
        VALUES ('proptimiza', 'missing', 'ventas@proptimiza.com', 'contacto@proptimiza.com', 1)`),
      /foreign key constraint/,
    )
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

  it('creates non-login least-privilege runtime and observer roles', async () => {
    const roles = await pool.query(`
      SELECT rolname, rolcanlogin, rolsuper
      FROM pg_roles WHERE rolname IN ('commercial_runtime', 'commercial_observer')
      ORDER BY rolname
    `)
    assert.deepEqual(roles.rows, [
      { rolname: 'commercial_observer', rolcanlogin: false, rolsuper: false },
      { rolname: 'commercial_runtime', rolcanlogin: false, rolsuper: false },
    ])
    const grants = await pool.query(`SELECT
      has_table_privilege('commercial_runtime', 'control.missions', 'SELECT,INSERT,UPDATE') AS runtime_write,
      has_table_privilege('commercial_runtime', 'control.missions', 'DELETE') AS runtime_delete,
      has_table_privilege('commercial_observer', 'catalog.offer_versions', 'SELECT') AS observer_read,
      has_table_privilege('commercial_observer', 'catalog.offer_versions', 'INSERT') AS observer_write
    `)
    assert.deepEqual(grants.rows[0], {
      runtime_write: true,
      runtime_delete: false,
      observer_read: true,
      observer_write: false,
    })
  })
})
