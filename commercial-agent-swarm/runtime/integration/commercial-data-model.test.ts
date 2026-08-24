import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import { verifyProductionDatabasePrincipals } from '../src/production.js'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const RUNTIME_MIGRATION = new URL(
  '../migrations/001_runtime.sql',
  import.meta.url,
)
const COMMERCIAL_MIGRATION = new URL(
  '../migrations/002_commercial_control_plane.sql',
  import.meta.url,
)
const COMMERCIAL_ROLLBACK = new URL(
  '../migrations/002_commercial_control_plane.rollback.sql',
  import.meta.url,
)
const DISPATCH_MIGRATION = new URL(
  '../migrations/003_dispatch_queue.sql',
  import.meta.url,
)
const CRM_MIGRATION = new URL(
  '../migrations/004_crm_integration.sql',
  import.meta.url,
)
const PORTFOLIO_READ_MODELS_MIGRATION = new URL(
  '../migrations/005_portfolio_read_models.sql',
  import.meta.url,
)
const SALES_READ_MODELS_MIGRATION = new URL(
  '../migrations/006_sales_read_models.sql',
  import.meta.url,
)
const USAGE_BUDGET_MIGRATION = new URL(
  '../migrations/007_usage_budget_ledger.sql',
  import.meta.url,
)
const INTERNAL_AUTOMATION_MIGRATION = new URL(
  '../migrations/009_internal_automation.sql',
  import.meta.url,
)
const INSTRUCTION_INBOX_MIGRATION = new URL(
  '../migrations/010_instruction_inbox.sql',
  import.meta.url,
)
const GO_NATIVE_USAGE_MIGRATION = new URL(
  '../migrations/011_go_native_usage_ledger.sql',
  import.meta.url,
)
const DEPENDENCY_TERMINALIZATION_MIGRATION = new URL(
  '../migrations/012_dependency_terminalization.sql',
  import.meta.url,
)
const SHADOW_HUMAN_REVIEW_MIGRATION = new URL(
  '../migrations/015_shadow_human_review.sql',
  import.meta.url,
)
const CODEX_INSTRUCTION_REVIEW_MIGRATION = new URL(
  '../migrations/019_codex_instruction_review.sql',
  import.meta.url,
)
const integration = ADMIN_URL ? describe : describe.skip

integration('commercial catalog/control/mail data model', () => {
  const databaseName = `proptimiza_catalog_${randomUUID().replaceAll('-', '')}`
  let admin: Pool
  let pool: Pool

  before(async () => {
    admin = new Pool({ connectionString: ADMIN_URL })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    await admin.query(
      `REVOKE CREATE, TEMP ON DATABASE "${databaseName}" FROM PUBLIC`,
    )
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
    await pool.end()
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [databaseName],
    )
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
    await admin.end()
  })

  it('keeps non-empty legacy tables and rows byte-for-byte intact', async () => {
    assert.deepEqual(
      (await pool.query('SELECT * FROM public.approvals')).rows,
      [{ id: '41', note: 'legacy approval' }],
    )
    assert.deepEqual(
      (await pool.query('SELECT * FROM public.agent_runs')).rows,
      [{ id: '42', state: 'legacy run' }],
    )
  })

  it('seeds the fixed versioned Proptimiza offer and ICP exactly once', async () => {
    const offer = await pool.query(`
      SELECT name, currency, starting_price::text AS starting_price
      FROM catalog.offer_versions
      WHERE project_id = 'proptimiza' AND offer_id = 'operacion-sin-planillas' AND version = 'offer-v1'
    `)
    assert.deepEqual(offer.rows, [
      {
        name: 'Operación Sin Planillas',
        currency: 'CLP',
        starting_price: '1800000.00',
      },
    ])
    const icp = await pool.query(`
      SELECT country_code, business_model, sector, employee_min, employee_max, operational_signals
      FROM catalog.icp_versions
      WHERE project_id = 'proptimiza' AND version = 'icp-v1'
    `)
    assert.deepEqual(icp.rows, [
      {
        country_code: 'CL',
        business_model: 'B2B',
        sector: 'services',
        employee_min: 10,
        employee_max: 100,
        operational_signals: ['Excel', 'WhatsApp', 'correo'],
      },
    ])
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM catalog.offer_versions`,
        )
      ).rows[0].count,
      1,
    )
    const frozen = await pool.query(`SELECT
      (SELECT row_to_json(p) FROM (SELECT project_id,display_name FROM catalog.projects WHERE project_id='proptimiza') p) AS project,
      (SELECT row_to_json(v) FROM (SELECT project_id,version,display_name,status FROM catalog.project_versions WHERE project_id='proptimiza') v) AS project_version,
      (SELECT policy FROM catalog.policy_versions WHERE project_id='proptimiza' AND version='policy-v1') AS policy,
      (SELECT row_to_json(d) FROM (SELECT project_id,policy_version,sender,recipient,maximum_volume,active,valid_until FROM mail.delivery_policies WHERE project_id='proptimiza') d) AS delivery`)
    assert.deepEqual(frozen.rows[0].project, {
      project_id: 'proptimiza',
      display_name: 'Proptimiza',
    })
    assert.equal(frozen.rows[0].project_version.status, 'published')
    assert.deepEqual(frozen.rows[0].policy, {
      external_contact: false,
      mail_sender: 'ventas@proptimiza.com',
      mail_recipient: 'contacto@proptimiza.com',
      maximum_volume: 1,
    })
    assert.equal(frozen.rows[0].delivery.policy_version, 'policy-v1')
  })

  it('enforces catalog versions, domain checks, and immutable seeded records', async () => {
    await assert.rejects(
      pool.query(
        `UPDATE catalog.offer_versions SET starting_price = 1 WHERE project_id = 'proptimiza'`,
      ),
      /VERSIONED_CATALOG_IMMUTABLE/,
    )
    await assert.rejects(
      pool.query(
        `DELETE FROM catalog.icp_versions WHERE project_id = 'proptimiza'`,
      ),
      /VERSIONED_CATALOG_IMMUTABLE/,
    )
    await assert.rejects(
      pool.query(
        `UPDATE mail.delivery_policies SET active = false WHERE project_id = 'proptimiza'`,
      ),
      /DELIVERY_POLICY_IMMUTABLE/,
    )
    await pool.query(
      `INSERT INTO control.deployed_versions VALUES ('runtime-v1', '${'a'.repeat(64)}', clock_timestamp())`,
    )
    await assert.rejects(
      pool.query(
        `DELETE FROM control.deployed_versions WHERE deployed_version = 'runtime-v1'`,
      ),
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
    await assert.rejects(
      pool.query(
        `INSERT INTO catalog.project_versions(project_id,version,display_name,status) VALUES('proptimiza','v3','Legacy active state','active')`,
      ),
      /project_versions_status_check/,
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

  it('rotates and reactivates complete catalog and delivery tuples append-only', async () => {
    await pool.query(`
    INSERT INTO catalog.project_versions(project_id,version,display_name,status)VALUES('proptimiza','v2','Rotation','published');
    INSERT INTO catalog.offer_versions(project_id,offer_id,version,project_version,name,currency,starting_price,description)VALUES('proptimiza','operacion-sin-planillas','offer-v2','v2','Operación Sin Planillas 2','CLP',1800000,'rotation');
    INSERT INTO catalog.icp_versions(project_id,version,project_version,country_code,business_model,sector,employee_min,employee_max,operational_signals,description)VALUES('proptimiza','icp-v2','v2','CL','B2B','services',10,100,ARRAY['Excel'],'rotation');
    INSERT INTO catalog.policy_versions(project_id,version,project_version,policy)VALUES('proptimiza','policy-v2','v2','{}');
    INSERT INTO mail.delivery_policies(project_id,policy_version,sender,recipient,maximum_volume,active)VALUES('proptimiza','policy-v2','ventas@proptimiza.com','contacto@proptimiza.com',1,true)`)
    await assert.rejects(
      pool.query(
        `INSERT INTO catalog.version_activations(activation_key,project_id,project_version,offer_id,offer_version,icp_version,policy_version)VALUES('mixed-v2-offer-v1','proptimiza','v2','operacion-sin-planillas','offer-v1','icp-v2','policy-v2')`,
      ),
      /foreign key/,
    )
    await pool.query(`
    INSERT INTO catalog.version_activations(activation_key,project_id,project_version,offer_id,offer_version,icp_version,policy_version)VALUES('activate-catalog-v2','proptimiza','v2','operacion-sin-planillas','offer-v2','icp-v2','policy-v2');
    INSERT INTO mail.delivery_policy_activations(activation_key,project_id,policy_version)VALUES('activate-delivery-v2','proptimiza','policy-v2')`)
    assert.equal(
      (
        await pool.query(
          `SELECT catalog.mission_versions_exist('proptimiza','v1','operacion-sin-planillas','offer-v1','icp-v1','policy-v1') old,catalog.mission_versions_exist('proptimiza','v2','operacion-sin-planillas','offer-v2','icp-v2','policy-v2') current`,
        )
      ).rows[0].old,
      false,
    )
    assert.equal(
      (
        await pool.query(
          `SELECT catalog.mission_versions_exist('proptimiza','v2','operacion-sin-planillas','offer-v2','icp-v2','policy-v2') current`,
        )
      ).rows[0].current,
      true,
    )
    await pool.query(`
    INSERT INTO catalog.version_activations(activation_key,project_id,project_version,offer_id,offer_version,icp_version,policy_version)VALUES('reactivate-catalog-v1','proptimiza','v1','operacion-sin-planillas','offer-v1','icp-v1','policy-v1');
    INSERT INTO mail.delivery_policy_activations(activation_key,project_id,policy_version)VALUES('reactivate-delivery-v1','proptimiza','policy-v1')`)
    assert.equal(
      (
        await pool.query(
          `SELECT catalog.mission_versions_exist('proptimiza','v1','operacion-sin-planillas','offer-v1','icp-v1','policy-v1') current,catalog.mission_versions_exist('proptimiza','v2','operacion-sin-planillas','offer-v2','icp-v2','policy-v2') old`,
        )
      ).rows[0].current,
      true,
    )
    assert.equal(
      (
        await pool.query(
          `SELECT catalog.mission_versions_exist('proptimiza','v2','operacion-sin-planillas','offer-v2','icp-v2','policy-v2') old`,
        )
      ).rows[0].old,
      false,
    )
    assert.equal(
      (
        await pool.query(
          `SELECT mail.delivery_policy_allows('proptimiza','policy-v1','ventas@proptimiza.com','contacto@proptimiza.com',1) current`,
        )
      ).rows[0].current,
      true,
    )
  })

  it('never activates a retired project version', async () => {
    await pool.query(`
    INSERT INTO catalog.project_versions(project_id,version,display_name,status)VALUES('proptimiza','v3','Retired','retired');
    INSERT INTO catalog.offer_versions(project_id,offer_id,version,project_version,name,currency,starting_price,description)VALUES('proptimiza','operacion-sin-planillas','offer-v3','v3','Retired offer','CLP',1800000,'retired');
    INSERT INTO catalog.icp_versions(project_id,version,project_version,country_code,business_model,sector,employee_min,employee_max,operational_signals,description)VALUES('proptimiza','icp-v3','v3','CL','B2B','services',10,100,ARRAY['Excel'],'retired');
    INSERT INTO catalog.policy_versions(project_id,version,project_version,policy)VALUES('proptimiza','policy-v3','v3','{}');
    INSERT INTO mail.delivery_policies(project_id,policy_version,sender,recipient,maximum_volume,active)VALUES('proptimiza','policy-v3','ventas@proptimiza.com','contacto@proptimiza.com',1,true)`)
    await assert.rejects(
      pool.query(
        `INSERT INTO catalog.version_activations(activation_key,project_id,project_version,offer_id,offer_version,icp_version,policy_version)VALUES('activate-retired-v3','proptimiza','v3','operacion-sin-planillas','offer-v3','icp-v3','policy-v3')`,
      ),
      /VERSION_NOT_PUBLISHED/,
    )
    await assert.rejects(
      pool.query(
        `INSERT INTO mail.delivery_policy_activations(activation_key,project_id,policy_version)VALUES('activate-retired-mail-v3','proptimiza','policy-v3')`,
      ),
      /VERSION_NOT_PUBLISHED/,
    )
  })

  it('creates five non-login capability roles and separates work-order ingestion from runtime', async () => {
    const roles = await pool.query(`
      SELECT rolname, rolcanlogin, rolsuper
      FROM pg_roles WHERE rolname IN ('commercial_runtime', 'commercial_work_order_ingestor', 'commercial_approver', 'commercial_safety_operator', 'commercial_observer')
      ORDER BY rolname
    `)
    assert.deepEqual(roles.rows, [
      { rolname: 'commercial_approver', rolcanlogin: false, rolsuper: false },
      { rolname: 'commercial_observer', rolcanlogin: false, rolsuper: false },
      { rolname: 'commercial_runtime', rolcanlogin: false, rolsuper: false },
      {
        rolname: 'commercial_safety_operator',
        rolcanlogin: false,
        rolsuper: false,
      },
      {
        rolname: 'commercial_work_order_ingestor',
        rolcanlogin: false,
        rolsuper: false,
      },
    ])
    await assert.rejects(
      queryAsRole(
        pool,
        'commercial_runtime',
        `SELECT control.save_mission($1,$2,'{}'::jsonb)`,
        [randomUUID(), 'runtime-cannot-ingest'],
      ),
      /permission denied/,
    )
    await assert.rejects(
      queryAsRole(
        pool,
        'commercial_work_order_ingestor',
        `SELECT control.save_mission($1,$2,'{}'::jsonb)`,
        [randomUUID(), 'malformed-ingest'],
      ),
      /INVALID_WORK_ORDER_SHAPE/,
    )
    for (const statement of [
      `UPDATE control.approvals SET status = 'denied'`,
      `UPDATE control.kill_switches SET active = false`,
      `UPDATE mail.external_actions SET receipt_id = 'forged'`,
    ])
      await assert.rejects(
        queryAsRole(pool, 'commercial_runtime', statement),
        /permission denied/,
      )
    for (const table of [
      'control.missions',
      'control.approvals',
      'mail.webhook_events',
    ]) {
      await assert.rejects(
        queryAsRole(pool, 'commercial_observer', `SELECT * FROM ${table}`),
        /permission denied/,
      )
    }
    assert.equal(
      (
        await queryAsRole(
          pool,
          'commercial_observer',
          'SELECT count(*)::int AS count FROM control.mission_summaries',
        )
      ).rows[0].count,
      0,
    )
  })

  it('limits approver and safety roles to their narrow CAS functions', async () => {
    const approvalId = '723e4567-e89b-42d3-a456-426614174000'
    const missionId = '823e4567-e89b-42d3-a456-426614174000'
    const action = { mission_id: missionId, action_type: 'mail.send' }
    await queryAsRole(
      pool,
      'commercial_runtime',
      `SELECT control.request_approval($1,$2::jsonb,$3,$4::timestamptz)`,
      [
        approvalId,
        JSON.stringify(action),
        'a'.repeat(64),
        '2026-08-15T20:00:00Z',
      ],
    )
    assert.equal(
      (
        await queryAsRole(
          pool,
          'commercial_approver',
          `SELECT control.decide_approval($1,'approved','human-director',$2::timestamptz,$3,$4,NULL,$5::jsonb,$6,$7::timestamptz) AS decided`,
          [
            approvalId,
            '2026-08-15T20:15:00Z',
            '00112233445566778899aabbccddeeff',
            `APPROVAL::${missionId}`,
            JSON.stringify(action),
            'a'.repeat(64),
            '2026-08-15T20:00:00Z',
          ],
        )
      ).rows[0].decided,
      true,
    )
    assert.equal(
      (
        await queryAsRole(
          pool,
          'commercial_approver',
          `SELECT control.decide_approval($1,'denied',NULL,NULL,NULL,NULL,NULL,$2::jsonb,$3,$4::timestamptz) AS decided`,
          [
            approvalId,
            JSON.stringify(action),
            'a'.repeat(64),
            '2026-08-15T20:00:00Z',
          ],
        )
      ).rows[0].decided,
      false,
    )
    await assert.rejects(
      queryAsRole(
        pool,
        'commercial_approver',
        `SELECT control.consume_approval($1,$2,$3,clock_timestamp())`,
        [missionId, 'a'.repeat(64), '00112233445566778899aabbccddeeff'],
      ),
      /permission denied/,
    )
    await assert.rejects(
      queryAsRole(
        pool,
        'commercial_approver',
        `SELECT control.set_kill_switch('global','*',true)`,
      ),
      /permission denied/,
    )

    assert.equal(
      (
        await queryAsRole(
          pool,
          'commercial_safety_operator',
          `SELECT control.set_kill_switch('global','*',true) AS changed`,
        )
      ).rows[0].changed,
      true,
    )
    assert.equal(
      (
        await queryAsRole(
          pool,
          'commercial_safety_operator',
          `SELECT control.set_kill_switch('global','*',false) AS changed`,
        )
      ).rows[0].changed,
      true,
    )
    await assert.rejects(
      queryAsRole(
        pool,
        'commercial_safety_operator',
        `SELECT control.decide_approval($1,'denied',NULL,NULL,NULL,NULL,NULL,$2::jsonb,$3,$4::timestamptz)`,
        [
          approvalId,
          JSON.stringify(action),
          'a'.repeat(64),
          '2026-08-15T20:00:00Z',
        ],
      ),
      /permission denied/,
    )
  })

  it('normalizes unexpected grants and rejects unsafe pre-existing role attributes', async () => {
    await pool.query('GRANT UPDATE ON control.approvals TO commercial_observer')
    await pool.query(await readFile(COMMERCIAL_MIGRATION, 'utf8'))
    assert.equal(
      (
        await pool.query(
          `SELECT has_table_privilege('commercial_observer','control.approvals','UPDATE') AS allowed`,
        )
      ).rows[0].allowed,
      false,
    )
    await pool.query('ALTER ROLE commercial_observer LOGIN')
    try {
      await assert.rejects(
        pool.query(await readFile(COMMERCIAL_MIGRATION, 'utf8')),
        /UNSAFE_PREEXISTING_ROLE/,
      )
    } finally {
      await pool.query('ALTER ROLE commercial_observer NOLOGIN')
    }
    const suffix = randomUUID().replaceAll('-', '')
    const login = `runtime_login_${suffix}`,
      rogue = `rogue_${suffix}`
    await pool.query(
      `CREATE ROLE ${login} LOGIN;GRANT commercial_runtime TO ${login};CREATE ROLE ${rogue} NOLOGIN`,
    )
    try {
      await pool.query(await readFile(COMMERCIAL_MIGRATION, 'utf8'))
      await pool.query(`GRANT ${rogue} TO commercial_runtime`)
      await assert.rejects(
        pool.query(await readFile(COMMERCIAL_MIGRATION, 'utf8')),
        /UNSAFE_CAPABILITY_OUTBOUND_MEMBERSHIP/,
      )
      await pool.query(
        `REVOKE ${rogue} FROM commercial_runtime;GRANT commercial_runtime TO ${rogue}`,
      )
      await assert.rejects(
        pool.query(await readFile(COMMERCIAL_MIGRATION, 'utf8')),
        /UNSAFE_CAPABILITY_INBOUND_MEMBERSHIP/,
      )
    } finally {
      await pool.query(
        `REVOKE commercial_runtime FROM ${login},${rogue};REVOKE ${rogue} FROM commercial_runtime;DROP ROLE IF EXISTS ${login},${rogue}`,
      )
    }
  })

  it('verifies distinct live login principals and rejects inherited or direct cross-capabilities', async () => {
    await pool.query(await readFile(DISPATCH_MIGRATION, 'utf8'))
    await pool.query(await readFile(CRM_MIGRATION, 'utf8'))
    await pool.query(await readFile(PORTFOLIO_READ_MODELS_MIGRATION, 'utf8'))
    await pool.query(await readFile(SALES_READ_MODELS_MIGRATION, 'utf8'))
    await pool.query(await readFile(USAGE_BUDGET_MIGRATION, 'utf8'))
    await pool.query(await readFile(INTERNAL_AUTOMATION_MIGRATION, 'utf8'))
    await pool.query(await readFile(INSTRUCTION_INBOX_MIGRATION, 'utf8'))
    await pool.query(await readFile(GO_NATIVE_USAGE_MIGRATION, 'utf8'))
    await pool.query(
      await readFile(DEPENDENCY_TERMINALIZATION_MIGRATION, 'utf8'),
    )
    await pool.query(await readFile(SHADOW_HUMAN_REVIEW_MIGRATION, 'utf8'))
    await pool.query(
      await readFile(CODEX_INSTRUCTION_REVIEW_MIGRATION, 'utf8'),
    )
    const suffix = randomUUID().replaceAll('-', ''),
      password = `test_${suffix}`,
      names = {
        runtime: `runtime_live_${suffix}`,
        ingestor: `ingestor_live_${suffix}`,
        approver: `approver_live_${suffix}`,
        safety: `safety_live_${suffix}`,
      }
    await pool.query(
      `CREATE ROLE ${names.runtime} LOGIN PASSWORD '${password}';CREATE ROLE ${names.ingestor} LOGIN PASSWORD '${password}';CREATE ROLE ${names.approver} LOGIN PASSWORD '${password}';CREATE ROLE ${names.safety} LOGIN PASSWORD '${password}';GRANT commercial_runtime TO ${names.runtime};GRANT commercial_work_order_ingestor TO ${names.ingestor};GRANT commercial_approver TO ${names.approver};GRANT commercial_safety_operator TO ${names.safety}`,
    )
    const makePool = (username: string) => {
      const url = new URL(ADMIN_URL!)
      url.pathname = `/${databaseName}`
      url.username = username
      url.password = password
      return new Pool({ connectionString: url.toString(), max: 1 })
    }
    const runtime = makePool(names.runtime),
      ingestor = makePool(names.ingestor),
      approver = makePool(names.approver),
      safety = makePool(names.safety)
    try {
      await verifyProductionDatabasePrincipals([
        {
          pool: runtime,
          expected: names.runtime,
          capability: 'commercial_runtime',
        },
        {
          pool: ingestor,
          expected: names.ingestor,
          capability: 'commercial_work_order_ingestor',
        },
        {
          pool: approver,
          expected: names.approver,
          capability: 'commercial_approver',
        },
        {
          pool: safety,
          expected: names.safety,
          capability: 'commercial_safety_operator',
        },
      ])
      await assert.rejects(
        verifyProductionDatabasePrincipals([
          {
            pool: safety,
            expected: names.runtime,
            capability: 'commercial_runtime',
          },
        ]),
        /DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/,
      )
      await pool.query(`GRANT UPDATE ON control.approvals TO ${names.runtime}`)
      await assert.rejects(
        verifyProductionDatabasePrincipals([
          {
            pool: runtime,
            expected: names.runtime,
            capability: 'commercial_runtime',
          },
        ]),
        /DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/,
      )
      await pool.query(
        `REVOKE UPDATE ON control.approvals FROM ${names.runtime}`,
      )
    } finally {
      await Promise.all([
        runtime.end(),
        ingestor.end(),
        approver.end(),
        safety.end(),
      ])
      await pool.query(
        `REVOKE commercial_runtime FROM ${names.runtime};REVOKE commercial_work_order_ingestor FROM ${names.ingestor};REVOKE commercial_approver FROM ${names.approver};REVOKE commercial_safety_operator FROM ${names.safety};DROP ROLE IF EXISTS ${names.runtime},${names.ingestor},${names.approver},${names.safety}`,
      )
    }
  })

  it('rejects every dangerous relation, sequence, schema, database, and membership capability', async () => {
    const suffix = randomUUID().replaceAll('-', '')
    const login = `least_privilege_${suffix}`
    const bridge = `bridge_${suffix}`
    const password = `test_${suffix}`
    await pool.query(
      `CREATE ROLE ${login} LOGIN PASSWORD '${password}'; CREATE ROLE ${bridge} NOLOGIN; GRANT commercial_runtime TO ${login}`,
    )
    const url = new URL(ADMIN_URL!)
    url.pathname = `/${databaseName}`
    url.username = login
    url.password = password
    const loginPool = new Pool({ connectionString: url.toString(), max: 1 })
    const verify = () =>
      verifyProductionDatabasePrincipals([
        { pool: loginPool, expected: login, capability: 'commercial_runtime' },
      ])
    try {
      await verify()
      for (const [grant, revoke] of [
        [
          `GRANT SELECT(status) ON control.approvals TO ${login}`,
          `REVOKE SELECT(status) ON control.approvals FROM ${login}`,
        ],
        [
          `GRANT TRUNCATE ON control.approvals TO ${login}`,
          `REVOKE TRUNCATE ON control.approvals FROM ${login}`,
        ],
        [
          `GRANT USAGE ON SEQUENCE control.dispatch_events_event_id_seq TO ${login}`,
          `REVOKE USAGE ON SEQUENCE control.dispatch_events_event_id_seq FROM ${login}`,
        ],
        [
          `GRANT CREATE ON SCHEMA control TO ${login}`,
          `REVOKE CREATE ON SCHEMA control FROM ${login}`,
        ],
        [
          `GRANT TEMP ON DATABASE "${databaseName}" TO ${login}`,
          `REVOKE TEMP ON DATABASE "${databaseName}" FROM ${login}`,
        ],
      ]) {
        await pool.query(grant)
        await assert.rejects(verify(), /DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/)
        await pool.query(revoke)
        await verify()
      }
      await pool.query(`GRANT commercial_runtime TO ${login} WITH ADMIN OPTION`)
      await assert.rejects(verify(), /DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/)
      await pool.query(
        `REVOKE ADMIN OPTION FOR commercial_runtime FROM ${login}`,
      )
      await verify()
      await pool.query(`GRANT ${bridge} TO ${login} WITH INHERIT FALSE`)
      await assert.rejects(verify(), /DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/)
      await pool.query(`REVOKE ${bridge} FROM ${login}`)
      await verify()
      await pool.query(
        `GRANT commercial_runtime TO ${bridge}; REVOKE commercial_runtime FROM ${login}; GRANT ${bridge} TO ${login}`,
      )
      await assert.rejects(verify(), /DATABASE_PRINCIPAL_CAPABILITY_MISMATCH/)
    } finally {
      await loginPool.end()
      await pool.query(
        `REVOKE ${bridge} FROM ${login}; REVOKE commercial_runtime FROM ${login},${bridge}; DROP ROLE IF EXISTS ${login},${bridge}`,
      )
    }
  })

  it('rolls back only migration 002 objects and preserves runtime plus legacy rows', async () => {
    const rollbackDatabase = `proptimiza_rollback_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${rollbackDatabase}"`)
    const url = new URL(ADMIN_URL!)
    url.pathname = `/${rollbackDatabase}`
    const rollbackPool = new Pool({ connectionString: url.toString() })
    try {
      await rollbackPool.query(
        `CREATE TABLE public.approvals (id bigint PRIMARY KEY); INSERT INTO public.approvals VALUES (9)`,
      )
      await rollbackPool.query(await readFile(RUNTIME_MIGRATION, 'utf8'))
      await rollbackPool.query(await readFile(COMMERCIAL_MIGRATION, 'utf8'))
      await rollbackPool.query(
        `INSERT INTO catalog.projects(project_id,display_name) VALUES('rollback-guard','Rollback Guard')`,
      )
      await assert.rejects(
        rollbackPool.query(await readFile(COMMERCIAL_ROLLBACK, 'utf8')),
        /ROLLBACK_BLOCKED_COMMERCIAL_DATA/,
      )
      assert.equal(
        (
          await rollbackPool.query(
            `SELECT count(*)::int AS count FROM catalog.projects WHERE project_id='rollback-guard'`,
          )
        ).rows[0].count,
        1,
      )
      await rollbackPool.query(
        `DELETE FROM catalog.projects WHERE project_id='rollback-guard'`,
      )
      await rollbackPool.query(
        'CREATE TABLE catalog.keep_after_002(value text)',
      )
      await rollbackPool.query(await readFile(COMMERCIAL_ROLLBACK, 'utf8'))
      assert.equal(
        (
          await rollbackPool.query(
            `SELECT to_regclass('control.missions') AS runtime, to_regclass('catalog.projects') AS catalog`,
          )
        ).rows[0].runtime,
        'control.missions',
      )
      assert.equal(
        (
          await rollbackPool.query(
            `SELECT to_regclass('catalog.projects') AS catalog`,
          )
        ).rows[0].catalog,
        null,
      )
      assert.deepEqual(
        (await rollbackPool.query('SELECT * FROM public.approvals')).rows,
        [{ id: '9' }],
      )
      assert.equal(
        (
          await rollbackPool.query(
            `SELECT to_regclass('catalog.keep_after_002') IS NOT NULL AS kept`,
          )
        ).rows[0].kept,
        true,
      )
    } finally {
      await rollbackPool.end()
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [rollbackDatabase],
      )
      await admin.query(`DROP DATABASE IF EXISTS "${rollbackDatabase}"`)
    }
  })
})

async function queryAsRole(
  pool: Pool,
  role: string,
  sql: string,
  parameters: Array<unknown> = [],
) {
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
