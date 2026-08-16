import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { Pool } from 'pg'
import { validWorkOrder } from '../test/fixtures.js'
import { validateWorkOrder } from '../src/work-orders.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip

integration('PostgreSQL Usage budget upgrade safety', { concurrency: 1 }, () => {
  const database = `usage_upgrade_${randomUUID().replaceAll('-', '')}`
  let admin: Pool
  let pool: Pool
  let jobId: string

  before(async () => {
    admin = new Pool({ connectionString: ADMIN })
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.toString() })
    for (const version of [
      '001_runtime',
      '002_commercial_control_plane',
      '003_dispatch_queue',
    ])
      await pool.query(
        await readFile(
          new URL(`../migrations/${version}.sql`, import.meta.url),
          'utf8',
        ),
      )

    const missionId = randomUUID()
    const traceId = randomUUID()
    jobId = randomUUID()
    const payload = validateWorkOrder({
      ...validWorkOrder(),
      mission_id: missionId,
      trace_id: traceId,
      idempotency_key: 'pre-007-upgrade-mission',
      created_at: '2026-08-16T08:00:00Z',
      expires_at: '2099-08-16T09:00:00Z',
      budget_limit: { currency: 'USD', maximum: 0.5 },
    })
    await pool.query(`SELECT control.save_mission($1,$2,$3::jsonb)`, [
      missionId,
      'pre-007-upgrade-mission',
      JSON.stringify({ ...payload, a3_enabled: true }),
    ])
    await pool.query(
      `SELECT control.enqueue_dispatch(
        $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid[],$9::numeric,$10::bigint,$11,$12
      )`,
      [
        jobId,
        missionId,
        traceId,
        'pre-007-upgrade-job',
        'market-account-intelligence',
        'Analyze evidence.',
        'untrusted evidence',
        [],
        0.02,
        100,
        2,
        3,
      ],
    )
    assert.equal(
      (
        await pool.query(
          `SELECT status FROM control.claim_dispatch('upgrade-worker',60,30)`,
        )
      ).rows[0].status,
      'leased',
    )
  })

  after(async () => {
    await pool.end()
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1',
      [database],
    )
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    await admin.end()
  })

  it('upgrades a pre-007 lease into a durable uncertain hold and preserves it across rollback/reapply', async () => {
    const migration = await readFile(
      new URL('../migrations/007_usage_budget_ledger.sql', import.meta.url),
      'utf8',
    )
    await pool.query(migration)
    assert.deepEqual(
      (
        await pool.query(
          `SELECT status,lease_owner,lease_until,child_timeout_seconds,error,
                  usage_budget_state,usage_value_reservation_micro_cents,
                  usage_budget_version
             FROM control.dispatch_jobs WHERE job_id=$1`,
          [jobId],
        )
      ).rows[0],
      {
        status: 'usage_unknown',
        lease_owner: null,
        lease_until: null,
        child_timeout_seconds: null,
        error: 'PRE_USAGE_LEDGER_LEASE_UNKNOWN',
        usage_budget_state: 'held_uncertain',
        usage_value_reservation_micro_cents: '10000000',
        usage_budget_version: '1',
      },
    )
    assert.deepEqual(
      (
        await pool.query(
          `SELECT quarantined,quarantine_reason
             FROM control.usage_budget_control WHERE control_id=1`,
        )
      ).rows[0],
      {
        quarantined: true,
        quarantine_reason: 'PRE_USAGE_LEDGER_HISTORY',
      },
    )

    await pool.query(
      await readFile(
        new URL('../migrations/007_usage_budget_ledger.rollback.sql', import.meta.url),
        'utf8',
      ),
    )
    await pool.query(migration)
    assert.deepEqual(
      (
        await pool.query(
          `SELECT status,usage_budget_state,usage_value_reservation_micro_cents,
                  usage_value_actual_micro_cents,usage_budget_version
             FROM control.dispatch_jobs WHERE job_id=$1`,
          [jobId],
        )
      ).rows[0],
      {
        status: 'usage_unknown',
        usage_budget_state: 'held_uncertain',
        usage_value_reservation_micro_cents: '10000000',
        usage_value_actual_micro_cents: null,
        usage_budget_version: '1',
      },
    )
    assert.equal(
      (
        await pool.query(
          `SELECT has_function_privilege(
            'commercial_runtime',
            'control.fail_dispatch(uuid,text,text,boolean,text,bigint)',
            'EXECUTE'
          ) AS allowed`,
        )
      ).rows[0].allowed,
      true,
    )
  })
})
