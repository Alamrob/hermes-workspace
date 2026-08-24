import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'

const root = process.env.TEST_DATABASE_URL
const integration = root ? describe : describe.skip

integration('PostgreSQL 17 Codex instruction review', { concurrency: 1 }, () => {
  const database = `instruction_review_${randomUUID().replaceAll('-', '')}`
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
    await admin?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await admin?.end()
  })

  it('converts one bounded request atomically and replays without a duplicate mission', async () => {
    const client = await pool.connect()
    try {
      const requestId = randomUUID()
      const missionId = randomUUID()
      const createdAt = new Date()
      const expiresAt = new Date(createdAt.getTime() + 86_400_000)
      const instructionSha = 'a'.repeat(64)
      const reviewSha = 'b'.repeat(64)
      const mission = {
        mission_id: missionId,
        trace_id: randomUUID(),
        created_at: createdAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        project_id: 'proptimiza',
        offer_id: 'operacion-sin-planillas',
        requested_by: 'codex-auditor',
        idempotency_key: `instruction:${requestId}:v1`,
        autonomy_level: 'A1',
        dry_run: true,
        a3_enabled: false,
        approval_token: null,
        allowed_actions: ['analysis.internal', 'research.public.read'],
        prohibited_actions: [
          'mail.send', 'message.send', 'campaign.activate', 'crm.write',
          'price.change', 'proposal.send', 'contract.commit',
        ],
        approved_channels: ['internal', 'public_web'],
        approved_tools: ['hermes.analysis', 'hermes.web'],
        budget_limit: { currency: 'USD', maximum: 0.5 },
        volume_limits: {
          maximum_accounts: 10,
          maximum_contacts: 0,
          maximum_external_actions: 0,
        },
        contact_policy: { contact_permitted: false },
        metadata: {
          instruction_request_id: requestId,
          instruction_sha256: instructionSha,
        },
      }
      await client.query('SET ROLE commercial_work_order_ingestor')
      await client.query(
        `SELECT control.create_instruction_request(
          $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12::jsonb
        )`,
        [
          requestId, `request-${requestId}`, 'proptimiza', 'Revisar evidencia pública',
          'Preparar una recomendación interna. No contactar ni modificar sistemas.',
          instructionSha, 'proptimizaspa@gmail.com', 'workspace', 'A1',
          createdAt.toISOString(), expiresAt.toISOString(), '{}',
        ],
      )
      const listed = (await client.query(
        'SELECT control.list_instruction_requests() AS requests',
      )).rows[0].requests
      assert.equal(listed[0].request_id, requestId)
      assert.equal(listed[0].status, 'pending_codex_review')

      const values = [
        requestId, 'convert', 'codex-auditor',
        'La solicitud queda limitada a investigación pública A1 sin contacto ni escritura externa.',
        createdAt.toISOString(), `codex-review:${requestId}`, instructionSha, reviewSha,
        missionId, mission.idempotency_key, JSON.stringify(mission),
      ]
      const converted = (await client.query(
        `SELECT control.review_instruction_request(
          $1::uuid,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9::uuid,$10,$11::jsonb
        ) AS result`,
        values,
      )).rows[0].result
      assert.equal(converted.status, 'converted')
      assert.equal(converted.external_actions_allowed, false)
      assert.equal(converted.replayed, false)
      const replay = (await client.query(
        `SELECT control.review_instruction_request(
          $1::uuid,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9::uuid,$10,$11::jsonb
        ) AS result`,
        values,
      )).rows[0].result
      assert.equal(replay.replayed, true)
      await client.query('RESET ROLE')
      assert.equal((await pool.query(
        'SELECT count(*)::int AS count FROM control.missions WHERE mission_id=$1',
        [missionId],
      )).rows[0].count, 1)
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM control.audit_events
         WHERE event->>'event_type'='instruction_request_reviewed'
           AND event->>'request_id'=$1 AND event->>'external_actions'='0'`,
        [requestId],
      )).rows[0].count, 1)
    } finally {
      await client.query('RESET ROLE').catch(() => undefined)
      client.release()
    }
  })

  it('fails closed for an externalized mission and refuses rollback after review history', async () => {
    const requestId = randomUUID()
    const missionId = randomUUID()
    const now = new Date()
    const expires = new Date(now.getTime() + 86_400_000)
    const client = await pool.connect()
    try {
      await client.query('SET ROLE commercial_work_order_ingestor')
      await client.query(
        `SELECT control.create_instruction_request(
          $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12::jsonb
        )`,
        [requestId, `request-${requestId}`, 'proptimiza', 'Solicitud insegura controlada',
          'Analizar evidencia sin contactar ni modificar sistemas.', 'c'.repeat(64),
          'proptimizaspa@gmail.com', 'sales', 'A1', now.toISOString(), expires.toISOString(), '{}'],
      )
      const unsafe = {
        mission_id: missionId,
        idempotency_key: `instruction:${requestId}:unsafe`,
        project_id: 'proptimiza', offer_id: 'operacion-sin-planillas', requested_by: 'codex-auditor',
        expires_at: expires.toISOString(), autonomy_level: 'A1', dry_run: true, a3_enabled: false,
        approval_token: null, allowed_actions: ['mail.send'],
        prohibited_actions: ['mail.send','message.send','campaign.activate','crm.write','price.change','proposal.send','contract.commit'],
        approved_channels: ['email'], approved_tools: ['hermes.analysis'],
        budget_limit: { currency: 'USD', maximum: 0.5 },
        volume_limits: { maximum_accounts: 1, maximum_contacts: 0, maximum_external_actions: 0 },
        contact_policy: { contact_permitted: false },
        metadata: { instruction_request_id: requestId, instruction_sha256: 'c'.repeat(64) },
      }
      await assert.rejects(client.query(
        `SELECT control.review_instruction_request(
          $1::uuid,'convert','codex-auditor',$2,$3::timestamptz,$4,$5,$6,$7::uuid,$8,$9::jsonb
        )`,
        [requestId, 'Este intento de expansión de autoridad debe fallar cerrado.', now.toISOString(),
          `codex-review:${requestId}`, 'c'.repeat(64), 'd'.repeat(64), missionId,
          unsafe.idempotency_key, JSON.stringify(unsafe)],
      ), /INSTRUCTION_REVIEW_INVALID/)
    } finally {
      await client.query('RESET ROLE').catch(() => undefined)
      client.release()
    }
    const rollback = await readFile(
      new URL('../migrations/019_codex_instruction_review.rollback.sql', import.meta.url),
      'utf8',
    )
    await assert.rejects(pool.query(rollback), /INSTRUCTION_REVIEW_ROLLBACK_REQUIRES_NO_REVIEWED_ROWS/)
  })
})
