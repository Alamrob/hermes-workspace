import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { PostgresA0BehaviorLedger } from '../src/postgres-a0-behavior-ledger.js'
import { dropTestDatabase } from './database-cleanup.js'

const ADMIN = process.env.TEST_A0_PROVISIONING_ADMIN_URL
const PSQL = process.env.PSQL_BIN ?? 'psql'
const integration = ADMIN ? describe : describe.skip
const authorityDatabase = 'proptimiza_commercial_authority'
const authorityOwner = 'proptimiza_commercial_authority_owner'
const ledgerLogin = 'proptimiza_a0_behavior_ledger_login'
const bootstrap = fileURLToPath(
  new URL('../scripts/bootstrap-commercial-authority-database.sql', import.meta.url),
)
const provision = fileURLToPath(
  new URL('../scripts/provision-a0-behavior-ledger-principal.sql', import.meta.url),
)
const rollback = fileURLToPath(
  new URL('../scripts/rollback-a0-behavior-ledger-principal.sql', import.meta.url),
)

integration('PostgreSQL A0 principal database isolation', () => {
  it('grants only function capability and leaves sibling database ACLs unchanged', async () => {
    const admin = new Pool({ connectionString: ADMIN })
    const suffix = randomUUID().replaceAll('-', '')
    const siblings = [`runtime_${suffix}`, `crm_${suffix}`, `n8n_${suffix}`]
    let authority: Pool | undefined
    try {
      const context = await admin.query<{ database: string }>(
        'SELECT current_database()::text AS database',
      )
      assert.equal(context.rows[0]?.database, 'postgres')
      const preexisting = await admin.query<{ count: number }>(
        `SELECT (
          (SELECT count(*) FROM pg_database WHERE datname=$1)
          +(SELECT count(*) FROM pg_roles WHERE rolname=ANY($2::text[]))
        )::int AS count`,
        [authorityDatabase, [authorityOwner, ledgerLogin]],
      )
      assert.equal(preexisting.rows[0]?.count, 0, 'requires a disposable cluster')
      for (const database of siblings) await admin.query(`CREATE DATABASE ${database}`)
      const before = await databaseAclSnapshot(admin, siblings)

      await runPsql(ADMIN!, bootstrap)
      const authorityUrl = new URL(ADMIN!)
      authorityUrl.pathname = `/${authorityDatabase}`
      authority = new Pool({ connectionString: authorityUrl.toString() })
      await runVersionedMigrations(authority, await loadMigrationSources())

      const beforeRejectedProvision = await databaseAclSnapshot(admin, [
        authorityDatabase,
      ])
      await admin.query(
        'COMMENT ON DATABASE proptimiza_commercial_authority IS NULL',
      )
      await assert.rejects(
        runPsql(authorityUrl.toString(), provision, true),
        /A0_AUTHORITY_DATABASE_NOT_DEDICATED/,
      )
      assert.equal(await roleExists(admin, ledgerLogin), false)
      assert.deepEqual(
        await databaseAclSnapshot(admin, [authorityDatabase]),
        beforeRejectedProvision,
      )
      await admin.query(
        "COMMENT ON DATABASE proptimiza_commercial_authority IS 'proptimiza:commercial-authority:v1'",
      )
      await runPsql(authorityUrl.toString(), provision, true)

      const privileges = await authority.query<{
        connect: boolean
        create: boolean
        temporary: boolean
      }>(
        `SELECT
          has_database_privilege($1,current_database(),'CONNECT') AS connect,
          has_database_privilege($1,current_database(),'CREATE') AS create,
          has_database_privilege($1,current_database(),'TEMP') AS temporary`,
        [ledgerLogin],
      )
      assert.deepEqual(privileges.rows[0], {
        connect: true,
        create: false,
        temporary: false,
      })

      const client = await authority.connect()
      try {
        await client.query(`SET SESSION AUTHORIZATION ${ledgerLogin}`)
        await new PostgresA0BehaviorLedger({
          database: client,
          expectedPrincipal: ledgerLogin,
        }).ready()
        await assert.rejects(client.query('CREATE TEMP TABLE forbidden(value int)'))
        await assert.rejects(client.query('CREATE TABLE public.forbidden(value int)'))
        await assert.rejects(client.query('SELECT * FROM control.a0_behavior_batch_ledger'))
      } finally {
        await client.query('RESET SESSION AUTHORIZATION')
        client.release()
      }

      assert.deepEqual(await databaseAclSnapshot(admin, siblings), before)
      const beforeRejectedRollback = await principalPrivilegeSnapshot(
        authority,
        ledgerLogin,
      )
      await admin.query(
        "COMMENT ON DATABASE proptimiza_commercial_authority IS 'tampered'",
      )
      await assert.rejects(
        runPsql(authorityUrl.toString(), rollback, true),
        /A0_AUTHORITY_DATABASE_NOT_DEDICATED/,
      )
      assert.equal(await roleExists(admin, ledgerLogin), true)
      assert.deepEqual(
        await principalPrivilegeSnapshot(authority, ledgerLogin),
        beforeRejectedRollback,
      )
      await admin.query(
        "COMMENT ON DATABASE proptimiza_commercial_authority IS 'proptimiza:commercial-authority:v1'",
      )
      await runPsql(authorityUrl.toString(), rollback, true)
      await runPsql(authorityUrl.toString(), rollback, true)
      const removed = await admin.query<{ present: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS present',
        [ledgerLogin],
      )
      assert.equal(removed.rows[0]?.present, false)
      assert.deepEqual(await databaseAclSnapshot(admin, siblings), before)
    } finally {
      await authority?.end()
      await dropTestDatabase(admin, authorityDatabase).catch(() => undefined)
      for (const database of siblings)
        await dropTestDatabase(admin, database).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS ${ledgerLogin}`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS ${authorityOwner}`).catch(() => undefined)
      await admin.end()
    }
  })
})

async function databaseAclSnapshot(admin: Pool, databases: string[]) {
  const result = await admin.query<{
    database: string
    owner: string
    acl: string | null
  }>(
    `SELECT datname::text AS database,pg_get_userbyid(datdba)::text AS owner,
       datacl::text AS acl FROM pg_database WHERE datname=ANY($1::text[])
       ORDER BY datname`,
    [databases],
  )
  return result.rows
}

async function principalPrivilegeSnapshot(database: Pool, role: string) {
  const result = await database.query<{
    login: boolean
    inherit: boolean
    superuser: boolean
    create_database: boolean
    create_role: boolean
    replication: boolean
    bypass_rls: boolean
    database_owner: string
    database_acl: string | null
    connect: boolean
    create: boolean
    temporary: boolean
    memberships: string[]
    executable_functions: string[]
  }>(
    `SELECT
       r.rolcanlogin AS login,
       r.rolinherit AS inherit,
       r.rolsuper AS superuser,
       r.rolcreatedb AS create_database,
       r.rolcreaterole AS create_role,
       r.rolreplication AS replication,
       r.rolbypassrls AS bypass_rls,
       pg_get_userbyid(d.datdba)::text AS database_owner,
       d.datacl::text AS database_acl,
       has_database_privilege(r.oid,d.oid,'CONNECT') AS connect,
       has_database_privilege(r.oid,d.oid,'CREATE') AS create,
       has_database_privilege(r.oid,d.oid,'TEMP') AS temporary,
       COALESCE((
         SELECT array_agg(parent.rolname::text ORDER BY parent.rolname::text)
         FROM pg_auth_members membership
         JOIN pg_roles parent ON parent.oid=membership.roleid
         WHERE membership.member=r.oid
       ),ARRAY[]::text[]) AS memberships,
       COALESCE((
         SELECT array_agg(
           format('%I.%I(%s)',namespace.nspname,procedure.proname,
             pg_get_function_identity_arguments(procedure.oid))
           ORDER BY namespace.nspname,procedure.proname,procedure.oid
         )
         FROM pg_proc procedure
         JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
         WHERE namespace.nspname=ANY(ARRAY['public','catalog','control','mail','integration'])
           AND has_function_privilege(r.oid,procedure.oid,'EXECUTE')
       ),ARRAY[]::text[]) AS executable_functions
     FROM pg_roles r
     CROSS JOIN pg_database d
     WHERE r.rolname=$1 AND d.datname=current_database()`,
    [role],
  )
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

async function roleExists(admin: Pool, role: string): Promise<boolean> {
  const result = await admin.query<{ present: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS present',
    [role],
  )
  return result.rows[0]?.present === true
}

async function runPsql(
  connectionString: string,
  file: string,
  allowSecretFreeTestLogin = false,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      PSQL,
      [
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--dbname',
        connectionString,
        '--file',
        file,
      ],
      {
        windowsHide: true,
        timeout: 30_000,
        env: allowSecretFreeTestLogin
          ? {
              ...process.env,
              PGOPTIONS:
                '-c proptimiza.allow_secret_free_a0_test_login=on',
            }
          : process.env,
      },
      (error) => (error ? reject(error) : resolve()),
    )
  })
}
