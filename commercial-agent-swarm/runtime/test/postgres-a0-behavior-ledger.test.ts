import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { QueryConfig, QueryResult, QueryResultRow } from 'pg'
import {
  PostgresA0BehaviorLedger,
  PostgresA0BehaviorLedgerError,
} from '../src/postgres-a0-behavior-ledger.js'
import type {
  A0TaskExecutionContract,
  A0UsageRecords,
} from '../src/a0-behavior-batch-admission.js'
import type { A0TaskResultObservation } from '../src/a0-behavior-manual-runner.js'

const RUN = 'a3800000-0000-4380-8380-000000000001'
const BATCH = `a0:${RUN}:t01`
const HASH = 'a'.repeat(64)
const IDEMPOTENCY = `a0:${'b'.repeat(64)}:${HASH}`
const PROFILES = [
  'sales-orchestrator',
  'market-account-intelligence',
  'contact-data-steward',
  'qualification-prioritization',
  'outreach-draft-manager',
  'commercial-qa-compliance',
] as const

function taskContract(): A0TaskExecutionContract[] {
  return PROFILES.map((agent_id, index) => ({
    sequence: index + 1,
    task_id: `a3800000-0000-4380-8380-${String(index + 101).padStart(12, '0')}`,
    fixture_id: `a3800000-0000-4380-8380-${String(index + 201).padStart(12, '0')}`,
    agent_id,
    critical: false,
    expected_status: 'completed',
    fixture_sha256: String(index + 1).repeat(64).slice(0, 64),
    maximum_tokens: 4096,
    maximum_model_calls: 1,
    reservation_micro_cents: 1_000_000,
  }))
}

function taskResult(): A0TaskResultObservation {
  const task = taskContract()[0]!
  return {
    run_id: RUN,
    batch_id: BATCH,
    reservation_version: 1,
    task_id: task.task_id,
    fixture_id: task.fixture_id,
    agent_id: task.agent_id,
    test_case: 'T01',
    critical: task.critical,
    expected_status: task.expected_status,
    actual_status: 'completed',
    agent_result: { status: 'completed' } as A0TaskResultObservation['agent_result'],
    behavior_passed: true,
    result_sha256: 'c'.repeat(64),
    usage_record_id: 'usage-task-result-1',
    usage_value_micro_cents: 100_000,
    external_actions: 0,
    real_connector_calls: 0,
  }
}

function usageRecords(
  totalMicroCents: number,
  prefix = 'usage',
): A0UsageRecords {
  return [
    { usage_record_id: `${prefix}-1`, usage_value_micro_cents: totalMicroCents - 5 },
    { usage_record_id: `${prefix}-2`, usage_value_micro_cents: 1 },
    { usage_record_id: `${prefix}-3`, usage_value_micro_cents: 1 },
    { usage_record_id: `${prefix}-4`, usage_value_micro_cents: 1 },
    { usage_record_id: `${prefix}-5`, usage_value_micro_cents: 1 },
    { usage_record_id: `${prefix}-6`, usage_value_micro_cents: 1 },
  ]
}

class FakeDatabase {
  readonly calls: QueryConfig[] = []
  value: unknown = { disposition: 'created', state: 'reserved', version: 1 }
  readyValue: Record<string, unknown> = {
    current_user: 'proptimiza_a0_behavior_ledger_login',
    database_name: 'proptimiza_commercial_authority',
    database_owner: 'proptimiza_commercial_authority_owner',
    can_connect: true,
    database_is_template: false,
    database_allows_connections: true,
    rolcanlogin: true,
    rolinherit: true,
    unsafe: false,
    memberships: ['commercial_a0_behavior_ledger'],
    unexpected_functions: [],
    missing_functions: [],
    unsafe_effective: false,
  }
  fail = false

  async query<T extends QueryResultRow>(
    config: QueryConfig,
  ): Promise<QueryResult<T>> {
    this.calls.push(structuredClone(config))
    if (this.fail) throw new Error('postgresql://secret-value')
    const row = config.text.includes('FROM pg_roles r')
      ? structuredClone(this.readyValue)
      : config.text.includes('acquire_a0_behavior_execution_permit')
        ? { granted: this.value }
        : config.text.includes('reserve_a0_behavior_batch') ||
          config.text.includes('get_a0_behavior_task_execution_permit') ||
          config.text.includes('get_a0_behavior_usage_budget_state') ||
          config.text.includes('record_a0_behavior_task_result') ||
          config.text.includes('get_a0_behavior_batch_settlement')
        ? { value: structuredClone(this.value) }
        : { applied: this.value }
    return { rows: [row as unknown as T], rowCount: 1 } as QueryResult<T>
  }
}

function create(database = new FakeDatabase()) {
  return {
    database,
    ledger: new PostgresA0BehaviorLedger({
      database,
      expectedPrincipal: 'proptimiza_a0_behavior_ledger_login',
    }),
  }
}

describe('PostgreSQL A0 behavior ledger capability', () => {
  it('accepts only the fixed deployable LOGIN principal', () => {
    assert.throws(
      () =>
        new PostgresA0BehaviorLedger({
          database: new FakeDatabase(),
          expectedPrincipal: 'some_other_login',
        }),
      /A0_LEDGER_CONFIGURATION_INVALID/,
    )
  })

  it('verifies an exact function-only principal', async () => {
    const { ledger, database } = create()
    await ledger.ready()
    assert.deepEqual(database.calls[0]?.values, [
      [
        'control.acquire_a0_behavior_execution_permit(uuid,text,bigint)',
        'control.get_a0_behavior_task_execution_permit(uuid,text,bigint,uuid,text,text)',
        'control.get_a0_behavior_usage_budget_state(uuid,text,bigint)',
        'control.record_a0_behavior_task_result(uuid,text,bigint,uuid,uuid,text,text,boolean,text,text,jsonb,boolean,text,text,bigint,integer,integer)',
        'control.hold_a0_behavior_batch_unknown(uuid,text,bigint,text)',
        'control.get_a0_behavior_batch_settlement(uuid,text,bigint,bigint,jsonb)',
        'control.reserve_a0_behavior_batch(text,uuid,text,text,bigint,timestamptz,jsonb)',
        'control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)',
      ],
    ])
    assert.equal(database.calls.length, 1)
    assert.match(database.calls[0]?.text ?? '', /current_database\(\)::text/)
    assert.match(database.calls[0]?.text ?? '', /pg_get_userbyid\(d\.datdba\)/)
    assert.match(database.calls[0]?.text ?? '', /has_database_privilege/)
    assert.match(database.calls[0]?.text ?? '', /owned\.relowner=r\.oid/)
    assert.doesNotMatch(database.calls[0]?.text ?? '', /\b(?:SET|RESET)\b/)
  })

  it('fails closed on database identity or effective database privilege drift', async () => {
    const unsafe: Array<[string, unknown]> = [
      ['database_name', 'runtime'],
      ['database_owner', 'postgres'],
      ['can_connect', false],
      ['database_is_template', true],
      ['database_allows_connections', false],
      ['unsafe_effective', true],
    ]
    for (const [field, value] of unsafe) {
      const database = new FakeDatabase()
      database.readyValue[field] = value
      await assert.rejects(create(database).ledger.ready(), /A0_LEDGER_PRINCIPAL_UNVERIFIED/)
      assert.equal(database.calls.length, 1)
    }
  })

  it('acquires a fresh execution permit only through the fixed CAS function', async () => {
    const { ledger, database } = create()
    database.value = true
    assert.equal(
      await ledger.acquireExecutionPermit({
        run_id: RUN,
        batch_id: BATCH,
        reservation_version: 1,
      }),
      true,
    )
    assert.deepEqual(database.calls[0]?.values, [RUN, BATCH, 1])
    assert.match(
      database.calls[0]?.text ?? '',
      /acquire_a0_behavior_execution_permit/,
    )
  })

  it('reads a task-bound renewable lease and exact shared budget state', async () => {
    const { ledger, database } = create()
    const task = taskContract()[0]!
    database.value = {
      allowed: true,
      job_id: task.task_id,
      mission_id: RUN,
      worker_id: 'a0-manual-runner-1',
      window_id: 'b3800000-0000-4380-8380-000000000001',
      epoch_id: 'c3800000-0000-4380-8380-000000000001',
      budget_version: 1,
      valid_for_ms: 5_000,
    }
    assert.equal(
      (
        await ledger.readTaskExecutionPermit({
          run_id: RUN,
          batch_id: BATCH,
          reservation_version: 1,
          task_id: task.task_id,
          profile_id: task.agent_id,
          worker_id: 'a0-manual-runner-1',
        })
      ).job_id,
      task.task_id,
    )
    assert.match(
      database.calls.at(-1)?.text ?? '',
      /get_a0_behavior_task_execution_permit/,
    )

    database.value = {
      total_committed_excluding_batch_micro_cents: 12_000_000,
    }
    assert.deepEqual(
      await ledger.readUsageBudgetState({
        run_id: RUN,
        batch_id: BATCH,
        reservation_version: 1,
      }),
      { total_committed_excluding_batch_micro_cents: 12_000_000 },
    )
    assert.match(
      database.calls.at(-1)?.text ?? '',
      /get_a0_behavior_usage_budget_state/,
    )
  })

  it('rejects a task lease with mismatched authority or worker before use', async () => {
    const { ledger, database } = create()
    const task = taskContract()[0]!
    database.value = {
      allowed: true,
      job_id: taskContract()[1]!.task_id,
      mission_id: RUN,
      worker_id: 'a0-manual-runner-1',
      window_id: 'b3800000-0000-4380-8380-000000000001',
      epoch_id: 'c3800000-0000-4380-8380-000000000001',
      budget_version: 1,
      valid_for_ms: 5_000,
    }
    await assert.rejects(
      ledger.readTaskExecutionPermit({
        run_id: RUN,
        batch_id: BATCH,
        reservation_version: 1,
        task_id: task.task_id,
        profile_id: task.agent_id,
        worker_id: 'a0-manual-runner-1',
      }),
      /A0_LEDGER_TASK_PERMIT_UNCONFIRMED/,
    )
    await assert.rejects(
      ledger.readTaskExecutionPermit({
        run_id: RUN,
        batch_id: BATCH,
        reservation_version: 1,
        task_id: task.task_id,
        profile_id: task.agent_id,
        worker_id: 'wrong-worker',
      }),
      /A0_LEDGER_TASK_PERMIT_INPUT_INVALID/,
    )
  })

  it('reserves and replays only through the fixed reservation function', async () => {
    const { ledger, database } = create()
    const input = {
      idempotency_key: IDEMPOTENCY,
      run_id: RUN,
      batch_id: BATCH,
      batch_sha256: HASH,
      reservation_micro_cents: 6_000_000 as const,
      expires_at: '2026-09-12T12:20:00.000Z',
      task_contract: taskContract(),
    }
    assert.deepEqual(await ledger.reserve(input), {
      disposition: 'created',
      state: 'reserved',
      version: 1,
    })
    database.value = {
      disposition: 'replayed',
      state: 'budget_exceeded',
      version: 2,
    }
    assert.deepEqual(await ledger.reserve(input), {
      disposition: 'replayed',
      state: 'budget_exceeded',
      version: 2,
    })
    assert.deepEqual(database.calls[0]?.values, [
      IDEMPOTENCY,
      RUN,
      BATCH,
      HASH,
      6_000_000,
      '2026-09-12T12:20:00.000Z',
      JSON.stringify(taskContract()),
    ])
    assert.match(database.calls[0]?.text ?? '', /reserve_a0_behavior_batch/)
  })

  it('records one exact durable task result through the fixed idempotent function', async () => {
    const { ledger, database } = create()
    const input = taskResult()
    database.value = 'inserted'
    assert.equal(await ledger.recordTaskResult(input), 'inserted')
    assert.deepEqual(database.calls[0]?.values, [
      input.run_id,
      input.batch_id,
      input.reservation_version,
      input.task_id,
      input.fixture_id,
      input.agent_id,
      input.test_case,
      input.critical,
      input.expected_status,
      input.actual_status,
      JSON.stringify(input.agent_result),
      input.behavior_passed,
      input.result_sha256,
      input.usage_record_id,
      input.usage_value_micro_cents,
      0,
      0,
    ])
    assert.match(
      database.calls[0]?.text ?? '',
      /record_a0_behavior_task_result/,
    )

    database.value = 'existing'
    assert.equal(await ledger.recordTaskResult(input), 'existing')
  })

  it('rejects malformed or externally active task results before SQL', async () => {
    for (const input of [
      { ...taskResult(), usage_record_id: 'bad receipt' },
      { ...taskResult(), external_actions: 1 },
      { ...taskResult(), agent_id: 'unapproved-agent' },
      { ...taskResult(), usage_value_micro_cents: 1_000_001 },
      { ...taskResult(), extra: true },
    ]) {
      const { ledger, database } = create()
      await assert.rejects(
        ledger.recordTaskResult(input as A0TaskResultObservation),
        /A0_LEDGER_TASK_RESULT_INPUT_INVALID/,
      )
      assert.equal(database.calls.length, 0)
    }
  })

  it('reconciles one exact known settlement with a read-only function', async () => {
    const { ledger, database } = create()
    database.value = {
      status: 'confirmed',
      state: 'budget_exceeded',
      version: 2,
    }
    assert.deepEqual(
      await ledger.getSettlement({
        run_id: RUN,
        batch_id: BATCH,
        reservation_version: 1,
        usage_value_micro_cents: 6_000_001,
        usage_records: usageRecords(6_000_001, 'usage-known-overrun'),
      }),
      { status: 'confirmed', state: 'budget_exceeded', version: 2 },
    )
    assert.equal(database.calls.length, 1)
    assert.match(
      database.calls[0]?.text ?? '',
      /get_a0_behavior_batch_settlement/,
    )

    database.value = { status: 'confirmed', state: 'settled', version: 3 }
    assert.deepEqual(
      await ledger.getSettlement({
        run_id: RUN,
        batch_id: BATCH,
        reservation_version: 1,
        usage_value_micro_cents: 5_000_000,
        usage_records: usageRecords(5_000_000, 'usage-late-known'),
      }),
      { status: 'confirmed', state: 'settled', version: 3 },
    )

    database.value = {
      status: 'confirmed',
      state: 'settled',
      version: 2,
      extra: true,
    }
    await assert.rejects(
      ledger.getSettlement({
        run_id: RUN,
        batch_id: BATCH,
        reservation_version: 1,
        usage_value_micro_cents: 6_000_001,
        usage_records: usageRecords(6_000_001, 'usage-known-overrun'),
      }),
      /A0_LEDGER_RECONCILIATION_INVALID/,
    )
  })

  it('settles known overrun and holds unknown through one fixed call each', async () => {
    const { ledger, database } = create()
    database.value = true
    assert.equal(
      await ledger.settle({
        run_id: RUN,
        batch_id: BATCH,
        reservation_version: 1,
        usage_value_micro_cents: 6_000_001,
        usage_records: usageRecords(6_000_001, 'usage-known-overrun'),
      }),
      true,
    )
    assert.equal(
      await ledger.holdUnknown({
        run_id: RUN,
        batch_id: BATCH,
        reservation_version: 1,
        reason: 'A0_USAGE_UNKNOWN',
      }),
      true,
    )
    assert.equal(database.calls.length, 2)
    assert.match(database.calls[0]?.text ?? '', /settle_a0_behavior_batch/)
    assert.match(database.calls[0]?.text ?? '', /\$5::jsonb/)
    assert.deepEqual(
      JSON.parse(String(database.calls[0]?.values?.[4])),
      usageRecords(6_000_001, 'usage-known-overrun'),
    )
    assert.match(
      database.calls[1]?.text ?? '',
      /hold_a0_behavior_batch_unknown/,
    )
  })

  it('fails closed without retry or database error disclosure', async () => {
    const database = new FakeDatabase()
    database.fail = true
    await assert.rejects(
      create(database).ledger.settle({
        run_id: RUN,
        batch_id: BATCH,
        reservation_version: 1,
        usage_value_micro_cents: 6,
        usage_records: usageRecords(6),
      }),
      (error) =>
        error instanceof PostgresA0BehaviorLedgerError &&
        error.code === 'A0_LEDGER_SETTLEMENT_UNCONFIRMED' &&
        !error.message.includes('secret'),
    )
    assert.equal(database.calls.length, 1)
  })

  it('rejects non-six, duplicate, unsafe or mismatched receipt sets before SQL', async () => {
    const invalid: unknown[] = [
      usageRecords(6).slice(0, 5),
      usageRecords(6).map((record, index) =>
        index === 1 ? { ...record, usage_record_id: 'usage-1' } : record,
      ),
      usageRecords(6).map((record, index) =>
        index === 0 ? { ...record, usage_value_micro_cents: 2 } : record,
      ),
      usageRecords(6).map((record, index) =>
        index === 0 ? { ...record, extra: true } : record,
      ),
    ]
    for (const usage_records of invalid) {
      const { ledger, database } = create()
      await assert.rejects(
        ledger.settle({
          run_id: RUN,
          batch_id: BATCH,
          reservation_version: 1,
          usage_value_micro_cents: 6,
          usage_records: usage_records as A0UsageRecords,
        }),
        /A0_LEDGER_SETTLEMENT_INPUT_INVALID/,
      )
      assert.equal(database.calls.length, 0)
    }
  })

  it('rejects malformed authority before issuing SQL', async () => {
    const { ledger, database } = create()
    await assert.rejects(
      ledger.reserve({
        idempotency_key: IDEMPOTENCY,
        run_id: RUN,
        batch_id: `${BATCH}-expanded`,
        batch_sha256: HASH,
        reservation_micro_cents: 6_000_000,
        expires_at: '2026-09-12T12:20:00.000Z',
        task_contract: taskContract(),
      }),
      /A0_LEDGER_RESERVATION_INPUT_INVALID/,
    )
    await assert.rejects(
      ledger.reserve({
        idempotency_key: IDEMPOTENCY,
        run_id: RUN,
        batch_id: BATCH,
        batch_sha256: HASH,
        reservation_micro_cents: 6_000_000,
        expires_at: {} as string,
        task_contract: taskContract(),
      }),
      /A0_LEDGER_RESERVATION_INPUT_INVALID/,
    )
    assert.equal(database.calls.length, 0)
  })
})
