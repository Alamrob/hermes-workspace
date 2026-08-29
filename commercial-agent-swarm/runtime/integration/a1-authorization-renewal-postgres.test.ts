import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip
const REVIEW_ID = 'a2500000-0000-4500-8500-000000000099'
const DOSSIER_SHA = 'd'.repeat(64)
const PARENT_ATTESTATIONS = {
  no_contact: true,
  no_crm_write: true,
  no_external_actions: true,
  no_provider_credit_spend: true,
  separate_signed_work_order_required: true,
}
const ORDER_ATTESTATIONS = {
  exact_work_order_confirmed: true,
  no_contact: true,
  no_crm_write: true,
  no_external_actions: true,
  no_provider_credit_spend: true,
}

integration('PostgreSQL append-only A1 authorization renewal', () => {
  it('rejects overlap, renews only after expiry, and retains both parent and exact-order ledgers', async () => {
    const fixture = await databaseFixture('a1_auth_renewal')
    const { admin, pool, database } = fixture
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())
      await seedCompletedReview(pool)

      const baseNow = new Date()
      const firstReviewedAt = new Date(baseNow.getTime() - 60_000).toISOString()
      const firstExpiresAt = new Date(baseNow.getTime() + 20 * 60_000).toISOString()
      const firstParentId = randomUUID()
      const firstParent = parentInput(firstParentId, firstReviewedAt, firstExpiresAt, 'first')
      const firstState = await recordParent(pool, firstParent)
      assert.equal(firstState.authorization.authorizationId, firstParentId)
      assert.equal(firstState.nextRequiredGate, 'separate_signed_work_order')
      const idempotent = await recordParent(pool, firstParent)
      assert.equal(idempotent.authorization.authorizationId, firstParentId)
      assert.equal(idempotent.nextRequiredGate, 'separate_signed_work_order')

      const firstOrderId = randomUUID()
      await recordOrder(pool, orderInput({
        orderId: firstOrderId,
        parentId: firstParentId,
        reviewedAt: new Date(baseNow.getTime() - 30_000).toISOString(),
        expiresAt: firstExpiresAt,
        label: 'first',
      }))

      const overlapping = parentInput(
        randomUUID(),
        new Date().toISOString(),
        new Date(Date.now() + 20 * 60_000).toISOString(),
        'overlap',
      )
      await assert.rejects(recordParent(pool, overlapping), /A1_RESEARCH_AUTHORIZATION_ACTIVE_CONFLICT/)

      const expiredAt = new Date(baseNow.getTime() - 5_000).toISOString()
      await pool.query(
        `UPDATE control.a1_research_order_authorizations SET expires_at=$1 WHERE order_authorization_id=$2`,
        [expiredAt, firstOrderId],
      )
      await pool.query(
        `UPDATE control.a1_research_authorizations SET expires_at=$1 WHERE authorization_id=$2`,
        [expiredAt, firstParentId],
      )

      const secondReviewedAt = new Date().toISOString()
      const secondExpiresAt = new Date(Date.now() + 20 * 60_000).toISOString()
      const secondParentId = randomUUID()
      const renewed = await recordParent(
        pool,
        parentInput(secondParentId, secondReviewedAt, secondExpiresAt, 'renewed'),
      )
      assert.equal(renewed.authorization.authorizationId, secondParentId)
      assert.equal(renewed.nextRequiredGate, 'separate_signed_work_order')

      const secondOrderId = randomUUID()
      const secondOrder = await recordOrder(pool, orderInput({
        orderId: secondOrderId,
        parentId: secondParentId,
        reviewedAt: secondReviewedAt,
        expiresAt: secondExpiresAt,
        label: 'renewed',
      }))
      assert.equal(secondOrder.orderAuthorizationId, secondOrderId)

      const parents = await pool.query(
        `SELECT authorization_id::text,supersedes_authorization_id::text
         FROM control.a1_research_authorizations WHERE review_id=$1 ORDER BY reviewed_at`,
        [REVIEW_ID],
      )
      assert.deepEqual(parents.rows, [
        { authorization_id: firstParentId, supersedes_authorization_id: null },
        { authorization_id: secondParentId, supersedes_authorization_id: firstParentId },
      ])
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM control.a1_research_order_authorizations WHERE review_id=$1`,
        [REVIEW_ID],
      )).rows[0].count, 2)
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM control.audit_events
         WHERE event->>'event'='a1_research_authorization_renewed' AND event->>'review_id'=$1`,
        [REVIEW_ID],
      )).rows[0].count, 1)

      const latestExpiredAt = new Date(Date.parse(secondReviewedAt) + 1_000).toISOString()
      await pool.query(
        `UPDATE control.a1_research_order_authorizations SET expires_at=$1 WHERE order_authorization_id=$2`,
        [latestExpiredAt, secondOrderId],
      )
      await pool.query(
        `UPDATE control.a1_research_authorizations SET expires_at=$1 WHERE authorization_id=$2`,
        [latestExpiredAt, secondParentId],
      )
      await pool.query(`SELECT pg_sleep(1.1)`)
      const expiredState = (await pool.query(
        `SELECT control.build_a1_research_authorization_state($1::uuid,$2) AS state`,
        [REVIEW_ID, DOSSIER_SHA],
      )).rows[0].state
      assert.equal(expiredState.authorization.authorizationId, secondParentId)
      assert.equal(expiredState.nextRequiredGate, 'authorization_expired')

      const rollback = await readFile(
        new URL('../migrations/029_a1_authorization_renewal.rollback.sql', import.meta.url),
        'utf8',
      )
      await assert.rejects(pool.query(rollback), /ROLLBACK_BLOCKED_A1_AUTHORIZATION_RENEWALS_EXIST/)
      await pool.query('ROLLBACK')
    } finally {
      await destroyDatabase(admin, pool, database)
    }
  })

  it('rolls back cleanly before any renewal history is written', async () => {
    const fixture = await databaseFixture('a1_auth_rollback')
    const { admin, pool, database } = fixture
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())
      const rollback = await readFile(
        new URL('../migrations/029_a1_authorization_renewal.rollback.sql', import.meta.url),
        'utf8',
      )
      await pool.query(rollback)
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM control.schema_migrations WHERE version='029_a1_authorization_renewal'`,
      )).rows[0].count, 0)
      assert.equal((await pool.query(
        `SELECT count(*)::int AS count FROM pg_constraint
         WHERE conrelid='control.a1_research_authorizations'::regclass
           AND conname='a1_research_authorizations_review_id_key'`,
      )).rows[0].count, 1)
    } finally {
      await destroyDatabase(admin, pool, database)
    }
  })
})

async function databaseFixture(prefix: string) {
  const admin = new Pool({ connectionString: ADMIN })
  const database = `${prefix}_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(ADMIN!)
  url.pathname = `/${database}`
  return { admin, database, pool: new Pool({ connectionString: url.toString() }) }
}

async function destroyDatabase(admin: Pool, pool: Pool, database: string) {
  await pool.end()
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [database])
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
  await admin.end()
}

async function seedCompletedReview(pool: Pool) {
  const sourceMission = randomUUID()
  const predecessorMission = randomUUID()
  await pool.query(
    `INSERT INTO control.missions(mission_id,idempotency_key,payload) VALUES
      ($1,'renewal-source-mission','{}'::jsonb),($2,'renewal-predecessor-mission','{}'::jsonb)`,
    [sourceMission, predecessorMission],
  )
  await pool.query(
    `INSERT INTO control.draft_review_sessions(
       review_id,mission_id,predecessor_mission_id,project_id,offer_id,offer_version,title,
       source_artifact_sha256,qa_artifact_sha256,predecessor_artifact_sha256,predecessor_qa_artifact_sha256,
       expected_items,external_actions,status,version,internal_review_gate,production_gate,reviewer_id,completed_at
     ) VALUES($1,$2,$3,'proptimiza','operacion-sin-planillas','v1','Renewal integration review',
       $4,$5,$6,$7,3,0,'completed',4,'complete','blocked','integration-reviewer',clock_timestamp())`,
    [REVIEW_ID, sourceMission, predecessorMission, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)],
  )
  for (let slot = 1; slot <= 3; slot += 1) {
    await pool.query(
      `INSERT INTO control.draft_review_items(
         review_id,item_slot,company_name,source_url,evidence_basis,original_subject,original_body,
         source_draft_sha256,machine_decision,machine_reason,risk_flags,human_decision,human_rationale,
         approval_state,external_action_eligible,reviewer_id,version,updated_at
       ) VALUES($1,$2,$3,$4,'Public corporate evidence','Internal subject','Internal body',
         $5,'human_review_candidate','Human review required','[]'::jsonb,$6,
         'Reviewed solely for internal A1 testing',$7,false,'integration-reviewer',1,clock_timestamp())`,
      [
        REVIEW_ID,
        slot,
        `Company ${slot}`,
        `https://company-${slot}.example/`,
        String(slot).repeat(64),
        slot === 1 ? 'accepted_internal' : 'rejected',
        slot === 1 ? 'internal_reviewed' : 'not_applicable',
      ],
    )
  }
  const dossier = (await pool.query(
    `SELECT control.build_a1_research_dossier($1::uuid) AS dossier`,
    [REVIEW_ID],
  )).rows[0].dossier
  assert.equal(dossier.status, 'authorization_required')
  assert.equal(dossier.eligibleAccountCount, 1)
}

function parentInput(
  authorizationId: string,
  reviewedAt: string,
  expiresAt: string,
  label: string,
) {
  return {
    authorizationId,
    reviewedAt,
    expiresAt,
    idempotencyKey: `a1-research-auth:renewal-${label}`,
    requestSha256: label.padEnd(64, label[0] ?? 'a').slice(0, 64).replace(/[^a-f0-9]/g, 'a'),
  }
}

async function recordParent(pool: Pool, input: ReturnType<typeof parentInput>) {
  return (await pool.query(
    `SELECT control.record_a1_research_authorization(
       $1::uuid,$2::uuid,'approved','Authorizes only an inert and separately signed A1 research gate.',
       'integration-reviewer','proptimizaspa@gmail.com',$3::timestamptz,$4::timestamptz,$5,$6::jsonb,$7,$8
     ) AS state`,
    [
      input.authorizationId,
      REVIEW_ID,
      input.reviewedAt,
      input.expiresAt,
      DOSSIER_SHA,
      JSON.stringify(PARENT_ATTESTATIONS),
      input.idempotencyKey,
      input.requestSha256,
    ],
  )).rows[0].state
}

function orderInput(input: {
  orderId: string
  parentId: string
  reviewedAt: string
  expiresAt: string
  label: string
}) {
  return {
    ...input,
    missionId: randomUUID(),
    unsignedSha: input.label === 'first' ? 'a'.repeat(64) : 'b'.repeat(64),
    userSha: input.label === 'first' ? 'c'.repeat(64) : 'e'.repeat(64),
    requestSha: input.label === 'first' ? '5'.repeat(64) : '6'.repeat(64),
    idempotencyKey: `a1-order-auth:renewal-${input.label}`,
  }
}

async function recordOrder(pool: Pool, input: ReturnType<typeof orderInput>) {
  return (await pool.query(
    `SELECT control.record_a1_research_order_authorization(
       $1::uuid,$2::uuid,$3::uuid,'approved','Authorizes only this exact inert A1 work order and no external action.',
       'integration-reviewer','proptimizaspa@gmail.com',$4::timestamptz,$5::timestamptz,$6,$7,$8::uuid,$9,
       $10::jsonb,$11,$12
     ) AS state`,
    [
      input.orderId,
      REVIEW_ID,
      input.parentId,
      input.reviewedAt,
      input.expiresAt,
      DOSSIER_SHA,
      input.unsignedSha,
      input.missionId,
      input.userSha,
      JSON.stringify(ORDER_ATTESTATIONS),
      input.idempotencyKey,
      input.requestSha,
    ],
  )).rows[0].state
}
