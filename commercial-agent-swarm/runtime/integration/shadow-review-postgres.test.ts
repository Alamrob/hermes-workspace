import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import { PostgresRuntimeRepository } from '../src/postgres-repository.js'
import { dropTestDatabase } from './database-cleanup.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip
const REVIEW_ID = 'a1500000-0000-4500-8500-000000000050'
const MISSION_ID = 'bbfc3cae-e64d-5fc8-93a8-5354f470216a'
const actor = 'proptimizaspa@gmail.com'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

integration('PostgreSQL shadow human review gate', { concurrency: 1 }, () => {
  const database = `shadow_review_${randomUUID().replaceAll('-', '')}`
  let admin: Pool
  let leftPool: Pool
  let rightPool: Pool
  let left: PostgresRuntimeRepository
  let right: PostgresRuntimeRepository

  before(async () => {
    admin = new Pool({ connectionString: ADMIN })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    leftPool = new Pool({ connectionString: url.toString(), max: 4 })
    rightPool = new Pool({ connectionString: url.toString(), max: 4 })
    for (const version of [
      '001_runtime','002_commercial_control_plane','003_dispatch_queue','004_crm_integration',
      '005_portfolio_read_models','006_sales_read_models','007_usage_budget_ledger',
      '008_simulation_safety_seed','009_internal_automation','010_instruction_inbox',
      '011_go_native_usage_ledger','012_dependency_terminalization',
      '013_variable_usage_reservations','014_variable_usage_constraint',
    ]) await leftPool.query(await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8'))
    await leftPool.query(
      'INSERT INTO control.missions(mission_id,idempotency_key,payload) VALUES($1,$2,$3::jsonb)',
      [MISSION_ID, 'ala50-shadow-review-test', JSON.stringify({ mission_id: MISSION_ID })],
    )
    await leftPool.query(await readFile(new URL('../migrations/015_shadow_human_review.sql', import.meta.url), 'utf8'))
    left = new PostgresRuntimeRepository(leftPool)
    right = new PostgresRuntimeRepository(rightPool)
  })

  after(async () => {
    await Promise.allSettled([leftPool.end(), rightPool.end()])
    await dropTestDatabase(admin, database)
    await admin.end()
  })

  it('seeds exactly 10 accounts and 30 conservative ALA-50 decisions', async () => {
    const reviews = await left.listShadowReviews()
    assert.equal(reviews.length, 1)
    assert.equal(reviews[0]?.id, REVIEW_ID)
    assert.equal(reviews[0]?.accounts.length, 10)
    assert.equal(reviews[0]?.accounts.flatMap((account) => account.decisions).length, 30)
    assert.equal(reviews[0]?.completedDecisionCount, 0)
    assert.equal(reviews[0]?.productionGate, 'blocked')
    assert.equal(reviews[0]?.externalActions, 0)
  })

  it('serializes concurrent decisions, replays one key idempotently and completes only after all 30', async () => {
    const initial = (await left.getShadowReview(REVIEW_ID))!
    const first = initial.accounts[0]!.decisions[0]!
    const base = {
      reviewId: REVIEW_ID, accountSlot: 1, dimension: first.dimension,
      humanValue: first.machineValue, rationale: 'Validación humana de la fuente oficial enlazada.',
      evidenceUrl: first.evidenceUrl, expectedVersion: 0, actorId: actor,
    } as const
    const outcomes = await Promise.allSettled([
      left.recordShadowDecision({ ...base, idempotencyKey: 'shadow-concurrent-left', requestSha256: digest('left') }),
      right.recordShadowDecision({ ...base, idempotencyKey: 'shadow-concurrent-right', requestSha256: digest('right') }),
    ])
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1)
    const current = (await left.getShadowReview(REVIEW_ID))!
    const saved = current.accounts[0]!.decisions[0]!
    const winningKey = outcomes[0]?.status === 'fulfilled' ? 'shadow-concurrent-left' : 'shadow-concurrent-right'
    const winningHash = outcomes[0]?.status === 'fulfilled' ? digest('left') : digest('right')
    const replay = await left.recordShadowDecision({ ...base, expectedVersion: 0, idempotencyKey: winningKey, requestSha256: winningHash })
    assert.equal(replay.completedDecisionCount, 1)
    await assert.rejects(
      left.recordShadowDecision({ ...base, expectedVersion: saved.version, rationale: 'Contenido cambiado.', idempotencyKey: winningKey, requestSha256: digest('changed') }),
      /SHADOW_REVIEW_IDEMPOTENCY_CONFLICT/,
    )
    for (const account of current.accounts) for (const decision of account.decisions) {
      if (account.slot === 1 && decision.dimension === first.dimension) continue
      await left.recordShadowDecision({
        reviewId: REVIEW_ID, accountSlot: account.slot, dimension: decision.dimension,
        humanValue: decision.machineValue, rationale: 'Validación humana de la fuente oficial enlazada.',
        evidenceUrl: decision.evidenceUrl, expectedVersion: decision.version, actorId: actor,
        idempotencyKey: `shadow-${account.slot}-${decision.dimension}`, requestSha256: digest(`${account.slot}:${decision.dimension}`),
      })
    }
    const completeReady = (await left.getShadowReview(REVIEW_ID))!
    assert.equal(completeReady.completedDecisionCount, 30)
    const completed = await left.completeShadowReview({ reviewId: REVIEW_ID, expectedVersion: completeReady.version, actorId: actor, idempotencyKey: 'shadow-complete-ala50', requestSha256: digest('complete') })
    assert.equal(completed.status, 'completed')
    assert.equal(completed.concordancePercent, 100)
    assert.equal(completed.evidenceCompletenessPercent, 100)
    assert.equal(completed.shadowGate, 'passed')
    assert.equal(completed.productionGate, 'blocked')
    const replayed = await right.completeShadowReview({ reviewId: REVIEW_ID, expectedVersion: completeReady.version, actorId: actor, idempotencyKey: 'shadow-complete-ala50', requestSha256: digest('complete') })
    assert.deepEqual(replayed, completed)
  })
})
