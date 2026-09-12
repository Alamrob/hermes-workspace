import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { QueryConfig, QueryResult, QueryResultRow } from 'pg'
import {
  PostgresA0BehaviorLedger,
  PostgresA0BehaviorLedgerError,
} from '../src/postgres-a0-behavior-ledger.js'

const RUN = 'a3800000-0000-4380-8380-000000000001'
const BATCH = `a0:${RUN}:t01`
const HASH = 'a'.repeat(64)
const IDEMPOTENCY = `a0:${'b'.repeat(64)}:${HASH}`

class FakeDatabase {
  readonly calls: QueryConfig[] = []
  value: unknown = { disposition: 'created', state: 'reserved', version: 1 }
  fail = false

  async query<T extends QueryResultRow>(
    config: QueryConfig,
  ): Promise<QueryResult<T>> {
    this.calls.push(structuredClone(config))
    if (this.fail) throw new Error('postgresql://secret-value')
    const row = config.text.includes('FROM pg_roles r')
      ? {
          current_user: 'proptimiza_a0_behavior_ledger_login',
          rolcanlogin: true,
          unsafe: false,
          memberships: ['commercial_a0_behavior_ledger'],
          unexpected_functions: [],
          missing_functions: [],
          unsafe_effective: false,
        }
      : config.text.includes('reserve_a0_behavior_batch')
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
  it('verifies an exact function-only principal', async () => {
    const { ledger, database } = create()
    await ledger.ready()
    assert.deepEqual(database.calls[0]?.values, [
      [
        'control.hold_a0_behavior_batch_unknown(uuid,text,bigint,text)',
        'control.reserve_a0_behavior_batch(text,uuid,text,text,bigint)',
        'control.settle_a0_behavior_batch(uuid,text,bigint,bigint,text)',
      ],
    ])
    assert.equal(database.calls.length, 1)
  })

  it('reserves and replays only through the fixed reservation function', async () => {
    const { ledger, database } = create()
    const input = {
      idempotency_key: IDEMPOTENCY,
      run_id: RUN,
      batch_id: BATCH,
      batch_sha256: HASH,
      reservation_micro_cents: 6_000_000 as const,
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
    ])
    assert.match(database.calls[0]?.text ?? '', /reserve_a0_behavior_batch/)
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
        usage_record_id: 'usage-known-overrun',
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
        usage_value_micro_cents: 1,
        usage_record_id: 'usage-1',
      }),
      (error) =>
        error instanceof PostgresA0BehaviorLedgerError &&
        error.code === 'A0_LEDGER_SETTLEMENT_UNCONFIRMED' &&
        !error.message.includes('secret'),
    )
    assert.equal(database.calls.length, 1)
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
      }),
      /A0_LEDGER_RESERVATION_INPUT_INVALID/,
    )
    assert.equal(database.calls.length, 0)
  })
})
