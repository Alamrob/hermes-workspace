import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import { connectA1Supervisor } from '../src/a1-window-supervisor.js'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'

const ADMIN = process.env.TEST_DATABASE_URL
if (!ADMIN) throw new Error('TEST_DATABASE_URL_REQUIRED')

describe('PostgreSQL 17 A1 window supervisor live lease', () => {
  const suffix = randomUUID().replaceAll('-', '')
  const database = `a1_supervisor_${suffix}`
  const role = `a1_supervisor_${suffix.slice(0, 12)}`
  const password = randomBytes(32).toString('base64url')
  const admin = new Pool({ connectionString: ADMIN })
  let pool: Pool

  before(async () => {
    await admin.query(`CREATE DATABASE "${database}"`)
    const databaseUrl = new URL(ADMIN)
    databaseUrl.pathname = `/${database}`
    pool = new Pool({ connectionString: databaseUrl.toString() })
    await runVersionedMigrations(pool, await loadMigrationSources())
    await admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    )
    await admin.query(`GRANT commercial_a1_supervisor TO ${role}`)
  })

  after(async () => {
    await pool?.end()
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  })

  it('publishes and removes a live lease through the least-privilege login', async () => {
    const supervisorUrl = new URL(ADMIN)
    supervisorUrl.pathname = `/${database}`
    supervisorUrl.username = role
    supervisorUrl.password = password
    const instance = randomUUID()
    const supervisor = await connectA1Supervisor(supervisorUrl.toString())
    try {
      const pulse = (await supervisor.pulse(instance)) as { status: string }
      assert.equal(pulse.status, 'ready')
      assert.equal(
        (await pool.query('SELECT control.a1_window_supervisor_live() AS live')).rows[0].live,
        true,
      )
      const stopped = (await supervisor.stop(instance)) as { status: string }
      assert.equal(stopped.status, 'stopped')
      assert.equal(
        (await pool.query('SELECT control.a1_window_supervisor_live() AS live')).rows[0].live,
        false,
      )
    } finally {
      await supervisor.close()
    }
  })
})
