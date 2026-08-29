import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { validWorkOrder } from '../test/fixtures.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip

integration('PostgreSQL 17 Ed25519 A1 work-order boundary', () => {
  it('retains HMAC internally but requires Ed25519 metadata for public A1', async () => {
    const admin = new Pool({ connectionString: ADMIN })
    const database = `ed25519_a1_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    const pool = new Pool({ connectionString: url.toString() })
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())

      const internal = workOrder({
        missionId: '123e4567-e89b-42d3-a456-426614174701',
        idempotencyKey: 'ed25519-internal-a0',
        autonomyLevel: 'A0',
        algorithm: 'HMAC-SHA256',
        signature: 'a'.repeat(64),
      })
      assert.equal(await save(pool, internal), 'inserted')

      const publicHmac = workOrder({
        missionId: '123e4567-e89b-42d3-a456-426614174702',
        idempotencyKey: 'ed25519-public-hmac',
        autonomyLevel: 'A1',
        algorithm: 'HMAC-SHA256',
        signature: 'b'.repeat(64),
      })
      await assert.rejects(save(pool, publicHmac), /A1_ED25519_SIGNATURE_REQUIRED/)

      const publicEd25519 = workOrder({
        missionId: '123e4567-e89b-42d3-a456-426614174703',
        idempotencyKey: 'ed25519-public-valid',
        autonomyLevel: 'A1',
        algorithm: 'Ed25519',
        signature: 'c'.repeat(128),
      })
      assert.equal(await save(pool, publicEd25519), 'inserted')
      await assert.rejects(
        pool.query(
          await readFile(
            new URL('../migrations/028_ed25519_a1_work_orders.rollback.sql', import.meta.url),
            'utf8',
          ),
        ),
        /ROLLBACK_BLOCKED_ED25519_MISSIONS_EXIST/,
      )
    } finally {
      await pool.end()
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1',
        [database],
      )
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      await admin.end()
    }
  })
})

function workOrder(input: {
  missionId: string
  idempotencyKey: string
  autonomyLevel: 'A0' | 'A1'
  algorithm: 'HMAC-SHA256' | 'Ed25519'
  signature: string
}) {
  const base = validWorkOrder()
  const publicResearch = input.autonomyLevel === 'A1'
  return {
    ...base,
    mission_id: input.missionId,
    trace_id: randomUUID(),
    idempotency_key: input.idempotencyKey,
    autonomy_level: input.autonomyLevel,
    allowed_actions: publicResearch
      ? ['research.public.read']
      : ['analysis.internal'],
    approved_channels: publicResearch ? ['public_web'] : ['internal'],
    approved_tools: publicResearch ? ['hermes.public-research'] : [],
    prohibited_actions: ['prospect.contact', 'crm.write', 'mail.send'],
    contact_policy: {
      ...base.contact_policy,
      contact_permitted: false,
    },
    dry_run: true,
    a3_enabled: false,
    authority: {
      ...base.authority,
      algorithm: input.algorithm,
      signature: input.signature,
    },
    metadata: {},
  }
}

async function save(pool: Pool, order: ReturnType<typeof workOrder>) {
  return (
    await pool.query<{ state: string }>(
      'SELECT control.save_mission($1::uuid,$2,$3::jsonb) AS state',
      [order.mission_id, order.idempotency_key, JSON.stringify(order)],
    )
  ).rows[0].state
}
