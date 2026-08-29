import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import { PostgresDispatchQueue, type EnqueueJob } from '../src/dispatch-queue.js'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { validWorkOrder } from '../test/fixtures.js'
import { validateWorkOrder } from '../src/work-orders.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip
const missionTraceIds = new Map<string, string>()

integration('PostgreSQL authoritative Usage budget ledger', { concurrency: 1 }, () => {
  const database = `usage_budget_${randomUUID().replaceAll('-', '')}`
  let admin: Pool
  let leftPool: Pool
  let rightPool: Pool
  let left: PostgresDispatchQueue
  let right: PostgresDispatchQueue

  before(async () => {
    admin = new Pool({ connectionString: ADMIN })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    leftPool = new Pool({ connectionString: url.toString() })
    rightPool = new Pool({ connectionString: url.toString() })
    const versions = [
      '001_runtime', '002_commercial_control_plane', '003_dispatch_queue',
      '004_crm_integration', '005_portfolio_read_models', '006_sales_read_models',
      '007_usage_budget_ledger',
      '008_simulation_safety_seed',
      '009_internal_automation',
      '010_instruction_inbox',
      '011_go_native_usage_ledger',
      '012_dependency_terminalization',
      '013_variable_usage_reservations',
      '014_variable_usage_constraint',
      '015_shadow_human_review',
      '016_usage_source_not_null',
      '017_external_action_kill_switch_projection',
      '018_sales_mission_draft_projection',
      '019_codex_instruction_review',
      '020_internal_mail_attestation',
      '021_commercial_policy_v2_draft',
      '022_policy_human_review',
      '023_policy_activation_dossier',
      '024_draft_internal_review',
      '025_a1_research_dossier',
      '026_a1_research_authorization',
      '027_a1_research_order_authorization',
      '028_ed25519_a1_work_orders',
    ]
    await runVersionedMigrations(leftPool, await Promise.all(versions.map(async (version) => ({
      version,
      sql: await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8'),
    }))))
    await leftPool.query(
      `UPDATE control.kill_switches SET active=false
        WHERE scope='global' AND scope_id='*'`,
    )
    left = new PostgresDispatchQueue(leftPool)
    right = new PostgresDispatchQueue(rightPool)
  })

  after(async () => {
    await Promise.allSettled([leftPool.end(), rightPool.end()])
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [database])
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    await admin.end()
  })

  it('reserves 0.10 atomically before execution and settles confirmed Usage by CAS while releasing surplus', async () => {
    const mission = await saveMission(leftPool, 'reserve-settle', 0.5)
    const firstJob = job(mission, 'reserve-settle-1')
    await left.enqueue(firstJob)
    const claim = await left.claim('worker-a', 60, 30)
    assert(claim)
    assert.deepEqual(claim.usageBudget, {
      reservationMicroCents: 10_000_000,
      missionCommittedBeforeMicroCents: 0,
      totalCommittedBeforeMicroCents: 0,
      version: 1,
    })
    await assert.rejects(
      left.complete(firstJob.job_id, 'worker-a', completionEnvelope(), 'a'.repeat(64), {
        usageValueMicroCents: 0,
        usageRecordId: 'usage-record-zero',
        source: 'opencode_go_native_telemetry',
        budgetVersion: 1,
        total_tokens: 15,
        api_calls: 1,
      }),
      /INVALID_DISPATCH_USAGE/,
    )
    await left.complete(firstJob.job_id, 'worker-a', completionEnvelope(), 'a'.repeat(64), {
      usageValueMicroCents: 3_000_000,
      usageRecordId: 'usage-record-settle-1',
      source: 'opencode_go_native_telemetry',
      budgetVersion: 1,
      total_tokens: 15,
      api_calls: 1,
    })
    const settled = (await leftPool.query(
      `SELECT status,usage_budget_state,usage_value_reservation_micro_cents,
              usage_value_actual_micro_cents,usage_record_id,usage_value_consumed_usd
       FROM control.dispatch_jobs WHERE job_id=$1`,
      [firstJob.job_id],
    )).rows[0]
    assert.deepEqual(settled, {
      status: 'succeeded', usage_budget_state: 'settled',
      usage_value_reservation_micro_cents: '10000000',
      usage_value_actual_micro_cents: '3000000',
      usage_record_id: 'usage-record-settle-1',
      usage_value_consumed_usd: '0.030000',
    })
    await assert.rejects(
      leftPool.query(
        `UPDATE control.dispatch_jobs SET usage_value_source=NULL WHERE job_id=$1`,
        [firstJob.job_id],
      ),
      /dispatch_jobs_usage_budget_consistency_check/,
    )
    await assert.rejects(
      left.complete(firstJob.job_id, 'worker-a', completionEnvelope(), 'a'.repeat(64), {
        usageValueMicroCents: 3_000_000, usageRecordId: 'usage-record-settle-1',
        source: 'opencode_go_native_telemetry',
        budgetVersion: 1, total_tokens: 15, api_calls: 1,
      }),
      /DISPATCH_LEASE_CONFLICT|USAGE_BUDGET_CAS_CONFLICT/,
    )
    const secondJob = job(mission, 'reserve-settle-2')
    await left.enqueue(secondJob)
    const secondClaim = await left.claim('worker-b', 60, 30)
    assert.equal(secondClaim?.usageBudget.missionCommittedBeforeMicroCents, 3_000_000)
    assert.equal(secondClaim?.usageBudget.totalCommittedBeforeMicroCents, 3_000_000)
    await left.fail(
      secondJob.job_id,
      'worker-b',
      'PRE_SPAWN_TEST',
      false,
      'not_started',
      secondClaim!.usageBudget.version,
    )
    assert.equal((await leftPool.query(
      `SELECT usage_budget_state FROM control.dispatch_jobs WHERE job_id=$1`, [secondJob.job_id],
    )).rows[0].usage_budget_state, 'released')
  })

  it('reserves each signed assignment amount and enforces the exact mission ceiling', async () => {
    const mission = await saveMission(leftPool, 'variable-reservation-boundary', 0.05)
    const first = job(mission, 'variable-reservation-1', 0.025)
    await left.enqueue(first)
    const firstClaim = await left.claim('variable-worker-1', 60, 30)
    assert(firstClaim)
    assert.equal(firstClaim.usageBudget.reservationMicroCents, 2_500_000)
    await left.complete(first.job_id, 'variable-worker-1', completionEnvelope(), 'd'.repeat(64), {
      usageValueMicroCents: 2_500_000,
      usageRecordId: 'usage-variable-1',
      source: 'opencode_go_native_telemetry',
      budgetVersion: firstClaim.usageBudget.version,
      total_tokens: 15,
      api_calls: 1,
    })

    const second = job(mission, 'variable-reservation-2', 0.025)
    await left.enqueue(second)
    const secondClaim = await left.claim('variable-worker-2', 60, 30)
    assert(secondClaim)
    assert.equal(secondClaim.usageBudget.reservationMicroCents, 2_500_000)
    assert.equal(secondClaim.usageBudget.missionCommittedBeforeMicroCents, 2_500_000)
    await left.complete(second.job_id, 'variable-worker-2', completionEnvelope(), 'e'.repeat(64), {
      usageValueMicroCents: 2_500_000,
      usageRecordId: 'usage-variable-2',
      source: 'opencode_go_native_telemetry',
      budgetVersion: secondClaim.usageBudget.version,
      total_tokens: 15,
      api_calls: 1,
    })

    const over = job(mission, 'variable-reservation-over', 0.01)
    await left.enqueue(over)
    assert.equal(await left.claim('variable-worker-over', 60, 30), null)
    assert.equal((await leftPool.query(
      `SELECT status,error FROM control.dispatch_jobs WHERE job_id=$1`, [over.job_id],
    )).rows[0].status, 'budget_exceeded')
  })

  it('serializes concurrent probes and quarantines an ambiguous outcome without refunding zero', async () => {
    const mission = await saveMission(leftPool, 'concurrent-unknown', 0.5)
    const one = job(mission, 'concurrent-1')
    const two = job(mission, 'concurrent-2')
    await Promise.all([left.enqueue(one), right.enqueue(two)])
    const claims = await Promise.all([
      left.claim('worker-left', 60, 30), right.claim('worker-right', 60, 30),
    ])
    assert.equal(claims.filter(Boolean).length, 1)
    const claimed = claims.find(Boolean)!
    const worker = claims[0] ? 'worker-left' : 'worker-right'
    const queue = claims[0] ? left : right
    await queue.fail(
      claimed.job_id,
      worker,
      'OPENCODE_USAGE_DIFF_AMBIGUOUS',
      false,
      'usage_unknown',
      claimed.usageBudget.version,
    )
    const held = (await leftPool.query(
      `SELECT usage_budget_state,usage_value_reservation_micro_cents,
              usage_value_actual_micro_cents FROM control.dispatch_jobs WHERE job_id=$1`,
      [claimed.job_id],
    )).rows[0]
    assert.deepEqual(held, {
      usage_budget_state: 'held_uncertain',
      usage_value_reservation_micro_cents: '10000000',
      usage_value_actual_micro_cents: null,
    })
    assert.equal((await leftPool.query(
      `SELECT quarantined FROM control.usage_budget_control WHERE control_id=1`,
    )).rows[0].quarantined, true)
    assert.equal(await left.claim('blocked-after-unknown', 60, 30), null)
    await leftPool.query(`UPDATE control.usage_budget_control SET quarantined=false,quarantine_reason=NULL,probe_job_id=NULL,probe_worker=NULL,probe_lease_until=NULL WHERE control_id=1`)
    await leftPool.query(
      `UPDATE control.dispatch_jobs SET status='failed',usage_budget_state='released',
        usage_value_consumed_usd=0 WHERE mission_id=$1 AND status='queued'`,
      [mission],
    )
  })

  it('allows the exact mission and activation ceilings and rejects the next reservation', async () => {
    const mission = await saveMission(leftPool, 'mission-boundary', 1)
    for (let index = 0; index < 5; index += 1) {
      const candidate = job(mission, `mission-limit-${index}`)
      await left.enqueue(candidate)
      const claim = await left.claim(`mission-worker-${index}`, 60, 30)
      assert(claim)
      await left.complete(candidate.job_id, `mission-worker-${index}`, completionEnvelope(), 'b'.repeat(64), {
        usageValueMicroCents: 10_000_000,
        usageRecordId: `usage-mission-${index}`,
        source: 'opencode_go_native_telemetry',
        budgetVersion: claim.usageBudget.version,
        total_tokens: 15,
        api_calls: 1,
      })
    }
    const sixth = job(mission, 'mission-limit-5')
    await left.enqueue(sixth)
    assert.equal(await left.claim('mission-worker-5', 60, 30), null)
    assert.equal((await leftPool.query(
      `SELECT status FROM control.dispatch_jobs WHERE job_id=$1`, [sixth.job_id],
    )).rows[0].status, 'budget_exceeded')

    await leftPool.query(
      `UPDATE control.dispatch_jobs SET usage_budget_state='released',
        usage_value_actual_micro_cents=NULL,usage_record_id=NULL,usage_value_source=NULL,
        usage_value_consumed_usd=0 WHERE usage_budget_state IN('settled','held_uncertain')`,
    )
    const seedMission = await saveMission(leftPool, 'activation-seed', 0.5)
    await leftPool.query(
      `INSERT INTO control.dispatch_jobs(
        job_id,mission_id,trace_id,idempotency_key,profile_id,instruction,evidence,status,
        max_attempts,mission_usage_value_ceiling_usd,usage_value_reservation_usd,
        usage_value_consumed_usd,maximum_tokens,maximum_api_calls,
        usage_budget_state,usage_value_reservation_micro_cents,
        usage_value_actual_micro_cents,usage_record_id,usage_value_source,usage_budget_version)
       SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,$1::uuid,
        ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'activation-seed-'||i,
        'market-account-intelligence','seed','{"trust":"untrusted_data","content":"seed"}'::jsonb,
        'succeeded',1,0.5,0.1,0.1,100,1,'settled',10000000,10000000,
        'usage-activation-'||i,'opencode_usage_export',1
       FROM generate_series(1,99) AS i`,
      [seedMission],
    )
    const boundaryMission = await saveMission(leftPool, 'activation-boundary', 0.5)
    const boundary = job(boundaryMission, 'activation-boundary')
    await left.enqueue(boundary)
    const boundaryClaim = await left.claim('activation-worker', 60, 30)
    assert(boundaryClaim)
    assert.equal(boundaryClaim.usageBudget.totalCommittedBeforeMicroCents, 990_000_000)
    await left.complete(boundary.job_id, 'activation-worker', completionEnvelope(), 'c'.repeat(64), {
      usageValueMicroCents: 10_000_000, usageRecordId: 'usage-activation-boundary',
      source: 'opencode_go_native_telemetry',
      budgetVersion: boundaryClaim.usageBudget.version, total_tokens: 15, api_calls: 1,
    })
    const overMission = await saveMission(leftPool, 'activation-over', 0.5)
    const over = job(overMission, 'activation-over')
    await left.enqueue(over)
    assert.equal(await left.claim('activation-over-worker', 60, 30), null)
    assert.equal((await leftPool.query(
      `SELECT status FROM control.dispatch_jobs WHERE job_id=$1`, [over.job_id],
    )).rows[0].status, 'budget_exceeded')
  })

  it('rejects a stale fail replay after the same worker reclaims a new budget version', async () => {
    await leftPool.query(`UPDATE control.dispatch_jobs SET usage_budget_state='released',
      usage_value_actual_micro_cents=NULL,usage_record_id=NULL,usage_value_source=NULL,
      usage_value_consumed_usd=0 WHERE usage_budget_state='settled'`)
    const mission = await saveMission(leftPool, 'fail-cas-replay', 0.5)
    const candidate = job(mission, 'fail-cas-replay')
    await left.enqueue(candidate)
    const firstClaim = await left.claim('same-worker', 60, 30)
    assert(firstClaim)
    await left.fail(
      candidate.job_id,
      'same-worker',
      'TRANSIENT_PRE_SPAWN',
      true,
      'not_started',
      firstClaim.usageBudget.version,
    )
    const secondClaim = await left.claim('same-worker', 60, 30)
    assert(secondClaim)
    assert.equal(secondClaim.usageBudget.version, firstClaim.usageBudget.version + 1)

    await assert.rejects(
      left.fail(
        candidate.job_id,
        'same-worker',
        'STALE_REPLAY',
        false,
        'not_started',
        firstClaim.usageBudget.version,
      ),
      /USAGE_BUDGET_CAS_CONFLICT/,
    )
    assert.deepEqual(
      (
        await leftPool.query(
          `SELECT status,lease_owner,usage_budget_state,usage_budget_version,
                  usage_value_reservation_micro_cents
             FROM control.dispatch_jobs WHERE job_id=$1`,
          [candidate.job_id],
        )
      ).rows[0],
      {
        status: 'leased',
        lease_owner: 'same-worker',
        usage_budget_state: 'reserved',
        usage_budget_version: '2',
        usage_value_reservation_micro_cents: '10000000',
      },
    )
    await left.fail(
      candidate.job_id,
      'same-worker',
      'TEST_DONE',
      false,
      'not_started',
      secondClaim.usageBudget.version,
    )
  })

  it('turns an expired probe lease into a conservative hold and rollback preserves the ledger', async () => {
    await leftPool.query(`UPDATE control.dispatch_jobs SET usage_budget_state='released',
      usage_value_actual_micro_cents=NULL,usage_record_id=NULL,usage_value_source=NULL,
      usage_value_consumed_usd=0 WHERE usage_budget_state='settled'`)
    const mission = await saveMission(leftPool, 'expiry', 0.5)
    const candidate = job(mission, 'expiry')
    await left.enqueue(candidate)
    assert(await left.claim('expiry-worker', 60, 30))
    await leftPool.query(`UPDATE control.dispatch_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=$1`, [candidate.job_id])
    await left.recover()
    assert.deepEqual((await leftPool.query(
      `SELECT status,usage_budget_state,usage_value_actual_micro_cents FROM control.dispatch_jobs WHERE job_id=$1`,
      [candidate.job_id],
    )).rows[0], { status: 'usage_unknown', usage_budget_state: 'held_uncertain', usage_value_actual_micro_cents: null })

    const constraintRollback = await readFile(new URL('../migrations/014_variable_usage_constraint.rollback.sql', import.meta.url), 'utf8')
    await leftPool.query(constraintRollback)
    const variableRollback = await readFile(new URL('../migrations/013_variable_usage_reservations.rollback.sql', import.meta.url), 'utf8')
    await leftPool.query(variableRollback)
    const rollback = await readFile(new URL('../migrations/007_usage_budget_ledger.rollback.sql', import.meta.url), 'utf8')
    await leftPool.query(rollback)
    assert.equal((await leftPool.query(
      `SELECT count(*)::int AS count FROM control.dispatch_jobs WHERE job_id=$1`, [candidate.job_id],
    )).rows[0].count, 1)
    assert.equal((await leftPool.query(
      `SELECT count(*)::int AS count FROM control.schema_migrations WHERE version='007_usage_budget_ledger'`,
    )).rows[0].count, 0)
    await assert.rejects(
      leftPool.query(`SET ROLE commercial_runtime; SELECT control.claim_dispatch('rollback',60,30); RESET ROLE`),
      /permission denied/,
    )
  })
})

async function saveMission(pool: Pool, key: string, maximum: number): Promise<string> {
  const missionId = randomUUID()
  const traceId = randomUUID()
  const payload = validateWorkOrder({
    ...validWorkOrder(), mission_id: missionId, trace_id: traceId,
    idempotency_key: `mission-${key}`, created_at: '2026-08-16T08:00:00Z',
    expires_at: '2099-08-16T09:00:00Z', budget_limit: { currency: 'USD', maximum },
    allowed_actions: ['research.public_sources'],
    prohibited_actions: ['prospect.contact'],
    approved_channels: ['public_web'],
    approved_tools: ['hermes.web'],
    autonomy_level: 'A1',
    authority: {
      issuer: 'codex',
      audience: 'hermes-commercial-orchestrator',
      key_id: 'integration-ed25519-1',
      algorithm: 'Ed25519',
      signature: 'a'.repeat(128),
    },
    dry_run: true,
  })
  await pool.query(`SELECT control.save_mission($1,$2,$3::jsonb)`, [
    missionId, `mission-${key}`, JSON.stringify({ ...payload, a3_enabled: false }),
  ])
  missionTraceIds.set(missionId, traceId)
  return missionId
}

function job(missionId: string, key: string, reservation = 0.1): EnqueueJob {
  return {
    job_id: randomUUID(), mission_id: missionId,
    trace_id: missionTraceIds.get(missionId) ?? (() => { throw new Error('MISSION_TRACE_NOT_FOUND') })(),
    idempotency_key: key, profile_id: 'market-account-intelligence',
    instruction: 'Analyze only supplied evidence.', evidence: 'untrusted evidence',
    dependencies: [], usage_value_reservation_usd: reservation,
    maximum_tokens: 100, maximum_api_calls: 2, max_attempts: 3,
  }
}

function completionEnvelope() {
  return {
    schema_version: '1.0', agent_result: { status: 'completed' },
    usage: { cost: { source: 'official_docs_snapshot', pricing_snapshot_id: 'opencode-go-2026-08-21-v2', cash_cost_usd: 0 } },
  }
}
