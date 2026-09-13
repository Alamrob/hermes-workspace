import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { dropTestDatabase } from './database-cleanup.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip

integration('PostgreSQL A0 behavior authority', () => {
  it('permits fresh execution and records one exact known result after expiry hold', async () => {
    const fixture = await databaseFixture('a0_behavior_authority')
    const { admin, pool, database } = fixture
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())
      const runId = randomUUID()
      const batchId = `a0:${runId}:t01`
      const source = 'a'.repeat(64)
      const batch = 'b'.repeat(64)
      const idempotency = `a0:${source}:${batch}`
      const taskContract = buildTaskContract()
      const usageRecords = [
        { usage_record_id: 'usage-late-known-6', usage_value_micro_cents: 5 },
        { usage_record_id: 'usage-late-known-1', usage_value_micro_cents: 999_999 },
        { usage_record_id: 'usage-late-known-5', usage_value_micro_cents: 999_999 },
        { usage_record_id: 'usage-late-known-2', usage_value_micro_cents: 999_999 },
        { usage_record_id: 'usage-late-known-4', usage_value_micro_cents: 999_999 },
        { usage_record_id: 'usage-late-known-3', usage_value_micro_cents: 999_999 },
      ]
      const expiresAt = new Date(Date.now() + 1_000).toISOString()
      const client = await pool.connect()
      try {
        await client.query('SET ROLE commercial_a0_behavior_ledger')
        const reserved = await client.query(
          `SELECT control.reserve_a0_behavior_batch(
            $1::text,$2::uuid,$3::text,$4::text,6000000,$5::timestamptz,
            $6::jsonb) AS value`,
          [idempotency, runId, batchId, batch, expiresAt, JSON.stringify(taskContract)],
        )
        assert.deepEqual(reserved.rows[0].value, {
          disposition: 'created',
          state: 'reserved',
          version: 1,
        })
        for (let check = 0; check < 2; check += 1) {
          const permit = await client.query(
            `SELECT control.acquire_a0_behavior_execution_permit(
              $1::uuid,$2::text,1) AS granted`,
            [runId, batchId],
          )
          assert.equal(permit.rows[0].granted, true)
        }
        await recordTaskResults(
          client,
          runId,
          batchId,
          taskContract,
          usageRecords,
        )
        await client.query('SELECT pg_sleep(1.1)')
        const settled = await client.query(
          `SELECT control.settle_a0_behavior_batch(
            $1::uuid,$2::text,1,5000000,$3::jsonb) AS applied`,
          [runId, batchId, JSON.stringify(usageRecords)],
        )
        assert.equal(settled.rows[0].applied, true)
        const exactReplay = await client.query(
          `SELECT control.settle_a0_behavior_batch(
            $1::uuid,$2::text,1,5000000,$3::jsonb) AS applied`,
          [runId, batchId, JSON.stringify([...usageRecords].reverse())],
        )
        assert.equal(exactReplay.rows[0].applied, true)
        const lookup = await client.query(
          `SELECT control.get_a0_behavior_batch_settlement(
            $1::uuid,$2::text,1,5000000,$3::jsonb) AS value`,
          [runId, batchId, JSON.stringify([...usageRecords].reverse())],
        )
        assert.deepEqual(lookup.rows[0].value, {
          status: 'confirmed',
          state: 'settled',
          version: 3,
        })
        const replay = await client.query(
          `SELECT control.reserve_a0_behavior_batch(
            $1::text,$2::uuid,$3::text,$4::text,6000000,$5::timestamptz,
            $6::jsonb) AS value`,
          [idempotency, runId, batchId, batch, expiresAt, JSON.stringify(taskContract)],
        )
        assert.deepEqual(replay.rows[0].value, {
          disposition: 'replayed',
          state: 'settled',
          version: 3,
        })
      } finally {
        await client.query('RESET ROLE')
        client.release()
      }
      const evidence = await pool.query(
        `SELECT
          (SELECT array_agg(version ORDER BY version) FROM control.a0_behavior_batch_ledger
            WHERE run_id=$1 AND batch_id=$2) AS versions,
          (SELECT count(*)::int FROM control.usage_record_registry
            WHERE provider_id='opencode-go' AND authority='a0_behavior'
              AND run_id=$1 AND batch_id=$2) AS registry_count,
          (SELECT jsonb_array_length(usage_records) FROM control.a0_behavior_batch_ledger
            WHERE run_id=$1 AND batch_id=$2 AND version=3) AS receipt_count,
          (SELECT usage_receipt_set_sha256~'^[a-f0-9]{64}$'
            FROM control.a0_behavior_batch_ledger
            WHERE run_id=$1 AND batch_id=$2 AND version=3) AS receipt_set_hash_valid,
          (SELECT count(*)::int FROM control.audit_events
            WHERE event->>'event'='a0_behavior_batch_settled'
              AND event->>'run_id'=$1::text AND event->>'batch_id'=$2) AS settlement_audits,
          (SELECT quarantined FROM control.usage_budget_control WHERE control_id=1) AS quarantined`,
        [runId, batchId],
      )
      assert.deepEqual(evidence.rows[0], {
        versions: ['1', '2', '3'],
        registry_count: 6,
        receipt_count: 6,
        receipt_set_hash_valid: true,
        settlement_audits: 1,
        quarantined: true,
      })
    } finally {
      await destroyDatabase(admin, pool, database)
    }
  })

  it('rejects a shared provider receipt before settlement while preserving prior task evidence', async () => {
    const fixture = await databaseFixture('a0_behavior_receipt_conflict')
    const { admin, pool, database } = fixture
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())
      const source = 'c'.repeat(64)
      const firstRun = randomUUID()
      const secondRun = randomUUID()
      const firstBatch = `a0:${firstRun}:t01`
      const secondBatch = `a0:${secondRun}:t01`
      const firstRecords = [
        { usage_record_id: 'receipt-z-conflict', usage_value_micro_cents: 1 },
        { usage_record_id: 'receipt-first-1', usage_value_micro_cents: 1 },
        { usage_record_id: 'receipt-first-2', usage_value_micro_cents: 1 },
        { usage_record_id: 'receipt-first-3', usage_value_micro_cents: 1 },
        { usage_record_id: 'receipt-first-4', usage_value_micro_cents: 1 },
        { usage_record_id: 'receipt-first-5', usage_value_micro_cents: 1 },
      ]
      const secondRecords = [
        { usage_record_id: 'receipt-second-a', usage_value_micro_cents: 1 },
        { usage_record_id: 'receipt-second-b', usage_value_micro_cents: 1 },
        { usage_record_id: 'receipt-second-c', usage_value_micro_cents: 1 },
        { usage_record_id: 'receipt-second-d', usage_value_micro_cents: 1 },
        { usage_record_id: 'receipt-second-e', usage_value_micro_cents: 1 },
        { usage_record_id: 'receipt-z-conflict', usage_value_micro_cents: 1 },
      ]
      const client = await pool.connect()
      const taskContract = buildTaskContract()
      try {
        await client.query('SET ROLE commercial_a0_behavior_ledger')
        const reserveAndPermit = async (
          runId: string,
          batchId: string,
          batchHash: string,
        ) => {
          const idempotency = `a0:${source}:${batchHash}`
          const reserved = await client.query(
            `SELECT control.reserve_a0_behavior_batch(
              $1::text,$2::uuid,$3::text,$4::text,6000000,
              clock_timestamp()+interval '5 minutes',$5::jsonb) AS value`,
            [idempotency, runId, batchId, batchHash, JSON.stringify(taskContract)],
          )
          assert.equal(reserved.rows[0].value.disposition, 'created')
          const permit = await client.query(
            `SELECT control.acquire_a0_behavior_execution_permit(
              $1::uuid,$2::text,1) AS granted`,
            [runId, batchId],
          )
          assert.equal(permit.rows[0].granted, true)
        }
        await reserveAndPermit(firstRun, firstBatch, 'd'.repeat(64))
        await recordTaskResults(
          client,
          firstRun,
          firstBatch,
          taskContract,
          firstRecords,
        )
        assert.equal(
          (
            await client.query(
              `SELECT control.settle_a0_behavior_batch(
                $1::uuid,$2::text,1,6,$3::jsonb) AS applied`,
              [firstRun, firstBatch, JSON.stringify(firstRecords)],
            )
          ).rows[0].applied,
          true,
        )
        await reserveAndPermit(secondRun, secondBatch, 'e'.repeat(64))
        await assert.rejects(
          recordTaskResults(
            client,
            secondRun,
            secondBatch,
            taskContract,
            secondRecords,
          ),
          /SHARED_USAGE_RECORD_CONFLICT/,
        )
      } finally {
        await client.query('RESET ROLE')
        client.release()
      }
      const evidence = await pool.query(
        `SELECT
          (SELECT array_agg(version ORDER BY version)
            FROM control.a0_behavior_batch_ledger WHERE run_id=$1) AS versions,
          (SELECT count(*)::int FROM control.usage_record_registry
            WHERE run_id=$1) AS second_registry_rows,
          (SELECT count(*)::int FROM control.a0_behavior_task_results
            WHERE run_id=$1) AS durable_task_results`,
        [secondRun],
      )
      assert.deepEqual(evidence.rows[0], {
        versions: ['1'],
        second_registry_rows: 0,
        durable_task_results: 5,
      })
    } finally {
      await destroyDatabase(admin, pool, database)
    }
  })
})

const A0_PROFILES = [
  'sales-orchestrator',
  'market-account-intelligence',
  'contact-data-steward',
  'qualification-prioritization',
  'outreach-draft-manager',
  'commercial-qa-compliance',
] as const

function buildTaskContract() {
  return A0_PROFILES.map((agentId, index) => ({
    sequence: index + 1,
    task_id: randomUUID(),
    fixture_id: randomUUID(),
    agent_id: agentId,
    critical: false,
    expected_status: 'completed',
    fixture_sha256: String(index + 1).repeat(64),
    maximum_tokens: 4096,
    maximum_model_calls: 1,
    reservation_micro_cents: 1_000_000,
  }))
}

async function recordTaskResults(
  client: { query: Pool['query'] },
  runId: string,
  batchId: string,
  taskContract: ReturnType<typeof buildTaskContract>,
  usageRecords: Array<{
    usage_record_id: string
    usage_value_micro_cents: number
  }>,
) {
  for (let index = 0; index < taskContract.length; index += 1) {
    const task = taskContract[index]!
    const usage = usageRecords[index]!
    const recorded = await client.query(
      `SELECT control.record_a0_behavior_task_result(
        $1::uuid,$2::text,1,$3::uuid,$4::uuid,$5::text,'T01'::text,
        $6::boolean,$7::text,'completed'::text,$8::jsonb,true,
        $9::text,$10::text,$11::bigint,0,0) AS value`,
      [
        runId,
        batchId,
        task.task_id,
        task.fixture_id,
        task.agent_id,
        task.critical,
        task.expected_status,
        JSON.stringify({ status: 'completed' }),
        String(index + 1).repeat(64).slice(0, 64),
        usage.usage_record_id,
        usage.usage_value_micro_cents,
      ],
    )
    assert.equal(recorded.rows[0].value, 'inserted')
  }
}

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
  await dropTestDatabase(admin, database)
  await admin.end()
}
