import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { dropTestDatabase } from './database-cleanup.js'

const root = process.env.TEST_DATABASE_URL
const integration = root ? describe : describe.skip

integration('PostgreSQL 17 instruction inbox', () => {
  const database = `instruction_${randomUUID().replaceAll('-', '')}`
  let admin: Pool
  let pool: Pool

  before(async () => {
    admin = new Pool({ connectionString: root })
    await admin.query(`CREATE DATABASE ${database}`)
    const url = new URL(root!)
    url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.toString() })
    await runVersionedMigrations(pool, await loadMigrationSources())
  })

  after(async () => {
    await pool?.end()
    if (admin) await dropTestDatabase(admin, database)
    await admin?.end()
  })

  it('stores one idempotent non-executable request through the narrow capability', async () => {
    const client = await pool.connect()
    try {
    const requestId = randomUUID()
    const createdAt = new Date()
    const expiresAt = new Date(createdAt.getTime() + 7 * 86_400_000)
    const values = [
      requestId,
      'workspace-instruction-0001',
      'proptimiza',
      'Revisar segmento de consultoras B2B',
      'Preparar una recomendación interna. No contactar ni modificar sistemas.',
      'a'.repeat(64),
      'proptimizaspa@gmail.com',
      'workspace',
      'A1',
      createdAt.toISOString(),
      expiresAt.toISOString(),
      JSON.stringify({ execution_eligible: false }),
    ]
    await client.query('SET ROLE commercial_work_order_ingestor')
    const first = await client.query(
      `SELECT control.create_instruction_request(
        $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12::jsonb
      ) AS result`,
      values,
    )
    assert.equal(first.rows[0].result.created, true)
    assert.equal(first.rows[0].result.status, 'pending_codex_review')
    assert.equal(first.rows[0].result.external_actions_allowed, false)
    const replay = await client.query(
      `SELECT control.create_instruction_request(
        $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12::jsonb
      ) AS result`,
      values,
    )
    assert.equal(replay.rows[0].result.created, false)
    await assert.rejects(
      client.query(
        `SELECT control.create_instruction_request(
          $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12::jsonb
        )`,
        values.map((value, index) => index === 3 ? 'Changed title' : value),
      ),
      /INSTRUCTION_IDEMPOTENCY_CONFLICT/,
    )
    await assert.rejects(
      client.query('SELECT * FROM control.instruction_requests'),
      /permission denied/,
    )
    await client.query('RESET ROLE')

    await client.query('SET ROLE commercial_runtime')
    const model = (await client.query(
      'SELECT control.get_portfolio_read_model() AS model',
    )).rows[0].model
    assert.equal(model.missionDrafts.length, 0)
    await client.query('RESET ROLE')
    } finally {
      await client.query('RESET ROLE').catch(() => undefined)
      client.release()
    }
  })

  it('rolls back the inbox without weakening the external kill switch', async () => {
    await pool.query(await readFile(
      new URL('../migrations/019_codex_instruction_review.rollback.sql', import.meta.url),
      'utf8',
    ))
    await pool.query(await readFile(
      new URL('../migrations/018_sales_mission_draft_projection.rollback.sql', import.meta.url),
      'utf8',
    ))
    const rollback = await readFile(
      new URL('../migrations/010_instruction_inbox.rollback.sql', import.meta.url),
      'utf8',
    )
    await pool.query(rollback)
    assert.equal(
      (await pool.query(`SELECT to_regclass('control.instruction_requests') AS table_name`)).rows[0].table_name,
      null,
    )
    assert.equal(
      (await pool.query(`SELECT control.external_actions_blocked() AS blocked`)).rows[0].blocked,
      true,
    )
    const model = (await pool.query(
      'SELECT control.get_portfolio_read_model() AS model',
    )).rows[0].model
    assert.deepEqual(model.missionDrafts, [])
  })
})
