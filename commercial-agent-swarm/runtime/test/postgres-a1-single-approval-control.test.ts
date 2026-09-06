import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { QueryConfig, QueryResult, QueryResultRow } from 'pg'
import {
  PostgresA1SingleApprovalControlCapability,
  PostgresA1SingleApprovalControlError,
} from '../src/postgres-a1-single-approval-control.js'
import type {
  A1SingleApprovalBrokerDispatchInput,
  A1SingleApprovalBrokerParentInput,
  A1SingleApprovalBrokerRecontainInput,
} from '../src/a1-single-approval-broker-adapter.js'

const MISSION = 'a3700000-0000-4370-8370-000000000001'
const TRACE = 'a3700000-0000-4370-8370-000000000002'
const HASH = 'a'.repeat(64)
const IDS = Array.from({ length: 6 }, (_, index) =>
  `a3700000-0000-4370-8370-${String(index + 10).padStart(12, '0')}`)

class FakeDatabase {
  readonly calls: QueryConfig[] = []
  parentValue: unknown = { consumed: true }
  recontainValue: unknown = { recontained: true }
  state: Record<string, unknown> = databaseState()
  fail = false

  async query<T extends QueryResultRow>(config: QueryConfig): Promise<QueryResult<T>> {
    this.calls.push(structuredClone(config))
    if (this.fail) throw new Error('postgresql://secret-value')
    let row: Record<string, unknown>
    if (config.text.includes('FROM pg_roles r')) {
      row = {
        current_user: 'proptimiza_a1_chain_runner_login',
        rolcanlogin: true,
        unsafe: false,
        memberships: ['commercial_a1_chain_runner'],
        unexpected_functions: [],
        missing_functions: [],
        unsafe_effective: false,
      }
    } else if (config.text.includes('get_a1_single_approval_chain_state')) {
      row = { value: structuredClone(this.state) }
    } else if (config.text.includes('consume_a1_single_approval_parent')) {
      row = { value: structuredClone(this.parentValue) }
    } else if (config.text.includes('recontain_a1_single_approval_chain')) {
      row = { value: structuredClone(this.recontainValue) }
    } else {
      throw new Error('UNEXPECTED_QUERY')
    }
    return { rows: [row as T], rowCount: 1 } as QueryResult<T>
  }
}

function create(options: {
  database?: FakeDatabase
  timer?: () => Promise<unknown>
  dispatcher?: () => Promise<unknown>
} = {}) {
  const database = options.database ?? new FakeDatabase()
  let dispatches = 0
  return {
    database,
    dispatches: () => dispatches,
    capability: new PostgresA1SingleApprovalControlCapability({
      database,
      expectedPrincipal: 'proptimiza_a1_chain_runner_login',
      timer: { inspect: options.timer ?? (async () => ({ enabled: false, active: false })) },
      dispatcher: { runOnce: async () => {
        dispatches += 1
        return (options.dispatcher ?? (async () => ({
          status: 'processed', processed: true, external_actions: 0,
        })))()
      } },
    }),
  }
}

function parentInput(): A1SingleApprovalBrokerParentInput {
  return {
    request_id: 'a3700000-0000-4370-8370-000000000003',
    mission_id: MISSION,
    trace_id: TRACE,
    authorization_digest_sha256: HASH,
    user_authorization_sha256: 'b'.repeat(64),
    expected_mission_sha256: 'c'.repeat(64),
    assignment_plan_sha256: 'd'.repeat(64),
    job_set_sha256: 'e'.repeat(64),
    assignment_ids: [...IDS],
    worker_id: 'broker-dispatcher-1',
    maximum_dispatch_ticks: 6,
    maximum_provider_credit_spend_usd: 0.06,
    reviewer_id: 'user:proptimizaspa@gmail.com',
    reviewer_email: 'proptimizaspa@gmail.com',
    reviewed_at: '2026-09-06T21:00:00.000Z',
    expires_at: '2026-09-06T21:30:00.000Z',
    stage_receipt_keys: { consume_parent_authorization: HASH },
    stage_receipt_key: HASH,
    idempotency_key: HASH,
  }
}

function dispatchInput(): A1SingleApprovalBrokerDispatchInput {
  return {
    mission_id: MISSION,
    worker_id: 'broker-dispatcher-1',
    tick: 1,
    stage_receipt_key: HASH,
    user_authorization_sha256: 'b'.repeat(64),
  }
}

function recontainInput(): A1SingleApprovalBrokerRecontainInput {
  return {
    mission_id: MISSION,
    reason: 'A1_SINGLE_APPROVAL_CHAIN_COMPLETED',
    stage_receipt_key: HASH,
    user_authorization_sha256: 'b'.repeat(64),
  }
}

function databaseState(): Record<string, unknown> {
  return {
    mission_id: MISSION,
    channel_kills: 7,
    external_actions_blocked: true,
    external_actions: 0,
    crm_writes: 0,
    crm_outbox: 0,
    global_kill: false,
    execution_window_open: true,
    dispatch_claiming_permitted: true,
    active_or_uncertain_jobs: 0,
    parent_authorization_consumed: true,
    completed_jobs: 0,
    usage_value_consumed_usd: 0,
  }
}

describe('PostgreSQL A1 single-approval control capability', () => {
  it('verifies an exact function-only login principal', async () => {
    const { capability, database } = create()
    await capability.ready()
    assert.equal(database.calls.length, 1)
    assert.deepEqual(database.calls[0].values, [[
      'control.consume_a1_single_approval_parent(jsonb)',
      'control.get_a1_single_approval_chain_state(uuid)',
      'control.recontain_a1_single_approval_chain(uuid,text)',
    ]])
    assert.equal(JSON.stringify(database.calls[0].values).includes('secret'), false)
  })

  it('merges a strict disabled host timer with the closed database projection', async () => {
    const { capability, database } = create()
    const result = await capability.inspect(MISSION)
    assert.equal(result.timer_enabled, false)
    assert.equal(result.timer_active, false)
    assert.equal(result.channel_kills, 7)
    assert.equal(database.calls.length, 1)
    assert.match(database.calls[0].text, /get_a1_single_approval_chain_state/)
  })

  it('consumes and recontains only through the two fixed functions', async () => {
    const { capability, database } = create()
    assert.deepEqual(await capability.consumeParentAuthorization(parentInput()), { consumed: true })
    assert.deepEqual(await capability.recontain(recontainInput()), { recontained: true })
    assert.deepEqual(database.calls.map((call) =>
      call.text.includes('consume_a1') ? 'consume' : 'recontain'), ['consume', 'recontain'])
  })

  it('runs exactly one manual dispatch after proving every inert guardrail', async () => {
    const { capability, dispatches } = create()
    assert.deepEqual(await capability.dispatchOnce(dispatchInput()), {
      status: 'processed', processed: true, external_actions: 0, retry_attempted: false,
    })
    assert.equal(dispatches(), 1)
  })

  it('does not dispatch when the timer, channel state, or database state is unsafe', async () => {
    const activeTimer = create({ timer: async () => ({ enabled: false, active: true }) })
    await assert.rejects(activeTimer.capability.dispatchOnce(dispatchInput()), /A1_CONTROL_TIMER_UNVERIFIED/)
    assert.equal(activeTimer.dispatches(), 0)
    const database = new FakeDatabase()
    database.state.channel_kills = 6
    const unsafeState = create({ database })
    await assert.rejects(unsafeState.capability.dispatchOnce(dispatchInput()), /A1_CONTROL_STATE_INVALID/)
    assert.equal(unsafeState.dispatches(), 0)
  })

  it('never retries or leaks a failed dispatcher or database error', async () => {
    const dispatchFailure = create({ dispatcher: async () => { throw new Error('Bearer secret') } })
    await assert.rejects(
      dispatchFailure.capability.dispatchOnce(dispatchInput()),
      (error) => error instanceof PostgresA1SingleApprovalControlError &&
        error.code === 'A1_CONTROL_DISPATCH_UNCERTAIN' && !error.message.includes('secret'),
    )
    assert.equal(dispatchFailure.dispatches(), 1)
    const database = new FakeDatabase()
    database.fail = true
    await assert.rejects(
      create({ database }).capability.inspect(MISSION),
      (error) => error instanceof PostgresA1SingleApprovalControlError &&
        error.code === 'A1_CONTROL_INSPECTION_FAILED' && !error.message.includes('secret'),
    )
    assert.equal(database.calls.length, 1)
  })

  it('rejects expanded projections and malformed authority before mutation', async () => {
    const database = new FakeDatabase()
    database.state.untrusted = true
    await assert.rejects(create({ database }).capability.inspect(MISSION), /A1_CONTROL_STATE_INVALID/)
    const invalid = parentInput()
    invalid.assignment_ids[5] = invalid.assignment_ids[0]
    const guarded = create()
    await assert.rejects(
      guarded.capability.consumeParentAuthorization(invalid),
      /A1_CONTROL_PARENT_INPUT_INVALID/,
    )
    assert.equal(guarded.database.calls.length, 0)
  })
})
