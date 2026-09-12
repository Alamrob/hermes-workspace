import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const migration = new URL(
  '../migrations/038_a0_behavior_authority.sql',
  import.meta.url,
)
const rollback = new URL(
  '../migrations/038_a0_behavior_authority.rollback.sql',
  import.meta.url,
)

describe('A0 behavior authority migration', () => {
  it('creates an append-only 6x16 microcent ledger with known-overrun state', async () => {
    const sql = await readFile(migration, 'utf8')
    assert.match(
      sql,
      /CREATE ROLE commercial_a0_behavior_ledger NOLOGIN NOSUPERUSER/,
    )
    assert.match(sql, /CREATE TABLE control\.a0_behavior_batch_ledger/)
    assert.match(sql, /CREATE TRIGGER a0_behavior_batch_ledger_immutable/)
    assert.match(sql, /reservation_micro_cents=6000000/)
    assert.match(sql, /96000000/)
    assert.match(sql, /budget_exceeded/)
    assert.match(sql, /9007199254740991/)
    assert.match(sql, /expires_at timestamptz NOT NULL/)
    assert.match(sql, /expire_a0_behavior_reservations\(\)/)
    assert.match(sql, /A0_RESERVATION_EXPIRED_USAGE_UNKNOWN/)
  })

  it('exposes only reserve, settle, exact read and hold functions', async () => {
    const sql = await readFile(migration, 'utf8')
    const grants = sql.slice(sql.lastIndexOf('GRANT EXECUTE ON FUNCTION'))
    assert.match(
      grants,
      /reserve_a0_behavior_batch\(text,uuid,text,text,bigint,timestamptz\)/,
    )
    assert.match(
      grants,
      /settle_a0_behavior_batch\(uuid,text,bigint,bigint,text\)/,
    )
    assert.match(
      grants,
      /hold_a0_behavior_batch_unknown\(uuid,text,bigint,text\)/,
    )
    assert.match(
      grants,
      /get_a0_behavior_batch_settlement\(uuid,text,bigint,bigint,text\)/,
    )
    assert.match(grants, /TO commercial_a0_behavior_ledger/)
    assert.doesNotMatch(
      grants,
      /enqueue_dispatch|claim_dispatch|mail\.|integration\./,
    )
    assert.doesNotMatch(
      sql,
      /GRANT (SELECT|INSERT|UPDATE|DELETE|ALL) ON control\.a0_behavior_batch_ledger/,
    )
  })

  it('shares receipt uniqueness with future A1 settlement and restores the exact wrapper', async () => {
    const [sql, undo] = await Promise.all([
      readFile(migration, 'utf8'),
      readFile(rollback, 'utf8'),
    ])
    assert.match(sql, /CREATE TABLE control\.usage_record_registry/)
    assert.match(sql, /PRIMARY KEY\(provider_id,usage_record_id\)/)
    assert.match(sql, /usage_fingerprint_sha256 text NOT NULL/)
    assert.match(sql, /usage_value_micro_cents bigint NOT NULL/)
    assert.match(sql, /FROM control\.dispatch_settlement_receipts/)
    assert.match(sql, /RENAME TO legacy_038_stage_dispatch_settlement/)
    assert.match(
      sql,
      /CREATE FUNCTION control\.stage_dispatch_settlement\(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer\)/,
    )
    assert.match(sql, /SHARED_USAGE_RECORD_CONFLICT/)
    assert.match(sql, /RENAME TO legacy_038_claim_dispatch/)
    assert.match(sql, /SHARED_ACTIVATION_CEILING_EXCEEDED/)
    assert.match(sql, /A0_ACTIVE_ATTEMPT_EXCLUDES_A1/)
    assert.match(
      sql,
      /RENAME TO legacy_038_activate_a1_dispatch_execution_window/,
    )
    assert.match(
      undo,
      /DROP FUNCTION control\.stage_dispatch_settlement\(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer\)/,
    )
    assert.match(
      undo,
      /ALTER FUNCTION control\.legacy_038_stage_dispatch_settlement\(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer\)[\s\S]*RENAME TO stage_dispatch_settlement/,
    )
    assert.match(
      undo,
      /ALTER FUNCTION control\.legacy_038_claim_dispatch\(text,integer,integer\)[\s\S]*RENAME TO claim_dispatch/,
    )
    assert.match(
      undo,
      /ALTER FUNCTION control\.legacy_038_activate_a1_dispatch_execution_window/,
    )
    assert.match(
      undo,
      /GRANT EXECUTE ON FUNCTION control\.stage_dispatch_settlement\(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer\)[\s\S]*TO commercial_runtime/,
    )
    assert.match(
      undo,
      /GRANT EXECUTE ON FUNCTION control\.claim_dispatch\(text,integer,integer\)[\s\S]*TO commercial_runtime/,
    )
    assert.match(
      undo,
      /GRANT EXECUTE ON FUNCTION control\.activate_a1_dispatch_execution_window\([\s\S]*TO commercial_safety_operator/,
    )
    assert.match(
      undo,
      /registry\.provider_id='opencode-go'[\s\S]*registry\.usage_value_micro_cents=receipt\.usage_value_micro_cents[\s\S]*registry\.usage_fingerprint_sha256=encode/,
    )
  })

  it('serializes shared budget and attempt state in one lock order and quarantines overruns', async () => {
    const sql = await readFile(migration, 'utf8')
    for (const name of [
      'reserve_a0_behavior_batch',
      'settle_a0_behavior_batch',
      'hold_a0_behavior_batch_unknown',
    ]) {
      const body = functionBody(sql, name)
      assert.ok(
        body.indexOf('control.kill_switch_guard') <
          body.indexOf('control.usage_budget_control'),
      )
      assert.ok(
        body.indexOf('control.usage_budget_control') <
          body.indexOf('control.a0_behavior_batch_ledger'),
      )
    }
    const stage = functionBody(sql, 'stage_dispatch_settlement')
    assertOrdered(stage, [
      'control.kill_switch_guard',
      'control.usage_budget_control',
      'control.legacy_038_stage_dispatch_settlement',
      'control.usage_record_registry',
    ])
    const claim = functionBody(sql, 'claim_dispatch')
    assertOrdered(claim, [
      'control.kill_switch_guard',
      'control.usage_budget_control',
      'control.legacy_038_claim_dispatch',
    ])
    const activation = functionBody(
      sql,
      'activate_a1_dispatch_execution_window',
    )
    assertOrdered(activation, [
      'control.kill_switch_guard',
      'control.usage_budget_control',
      'control.legacy_038_activate_a1_dispatch_execution_window',
    ])
    assert.match(sql, /activation_ceiling_micro_cents<>1000000000/)
    assert.match(sql, /a0_committed\+a1_committed/)
    assert.match(sql, /A0_KNOWN_USAGE_BUDGET_EXCEEDED/)
    assert.match(sql, /A0_RESERVATION_EXPIRED_USAGE_UNKNOWN/)
    assert.match(sql, /quarantined=true/)
  })

  it('requires containment and an empty ledger for rollback', async () => {
    const [sql, undo] = await Promise.all([
      readFile(migration, 'utf8'),
      readFile(rollback, 'utf8'),
    ])
    assert.match(sql, /A0_BEHAVIOR_AUTHORITY_MIGRATION_REQUIRES_CONTAINMENT/)
    assert.match(sql, /control\.external_actions_blocked\(\)/)
    assert.match(sql, /scope='channel' AND active/)
    assert.match(
      sql,
      /integration\.crm_outbox WHERE status IN\('pending','leased','outcome_unknown'\)/,
    )
    assert.match(
      undo,
      /A0_BEHAVIOR_AUTHORITY_ROLLBACK_REQUIRES_EMPTY_CONTAINED_LEDGER/,
    )
    assert.match(
      undo,
      /IF EXISTS\(SELECT 1 FROM control\.a0_behavior_batch_ledger\)/,
    )
    assert.match(
      undo,
      /FROM control\.dispatch_settlement_receipts receipt[\s\S]*NOT EXISTS\([\s\S]*control\.usage_record_registry registry/,
    )
    assert.match(undo, /scope='channel' AND active/)
    assert.doesNotMatch(undo, /DELETE FROM control\.a0_behavior_batch_ledger/)
  })
})

function functionBody(sql: string, name: string): string {
  const declaration = sql.indexOf(`CREATE FUNCTION control.${name}`)
  assert.notEqual(declaration, -1, `missing ${name}`)
  const begin = sql.indexOf('BEGIN', declaration)
  const end = sql.indexOf('END $$;', begin)
  assert.notEqual(begin, -1, `missing BEGIN for ${name}`)
  assert.notEqual(end, -1, `missing END for ${name}`)
  return sql.slice(begin, end)
}

function assertOrdered(value: string, terms: readonly string[]): void {
  let cursor = -1
  for (const term of terms) {
    const next = value.indexOf(term, cursor + 1)
    assert.ok(next > cursor, `${term} is missing or out of order`)
    cursor = next
  }
}
