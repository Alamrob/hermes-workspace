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
      await runPsql(authorityUrl.toString(), provision)

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
      await runPsql(authorityUrl.toString(), rollback)
      await runPsql(authorityUrl.toString(), rollback)
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

async function runPsql(connectionString: string, file: string): Promise<void> {
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
      { windowsHide: true, timeout: 30_000 },
      (error) => (error ? reject(error) : resolve()),
    )
  })
}
