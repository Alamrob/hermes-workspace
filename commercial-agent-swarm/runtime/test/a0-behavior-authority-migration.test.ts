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
  })

  it('exposes only reserve, settle and hold functions', async () => {
    const sql = await readFile(migration, 'utf8')
    const grants = sql.slice(sql.lastIndexOf('GRANT EXECUTE ON FUNCTION'))
    assert.match(
      grants,
      /reserve_a0_behavior_batch\(text,uuid,text,text,bigint\)/,
    )
    assert.match(
      grants,
      /settle_a0_behavior_batch\(uuid,text,bigint,bigint,text\)/,
    )
    assert.match(
      grants,
      /hold_a0_behavior_batch_unknown\(uuid,text,bigint,text\)/,
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
    assert.match(sql, /FROM control\.dispatch_settlement_receipts/)
    assert.match(sql, /RENAME TO legacy_038_stage_dispatch_settlement/)
    assert.match(
      sql,
      /CREATE FUNCTION control\.stage_dispatch_settlement\(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer\)/,
    )
    assert.match(sql, /SHARED_USAGE_RECORD_CONFLICT/)
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
      /GRANT EXECUTE ON FUNCTION control\.stage_dispatch_settlement\(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer\)[\s\S]*TO commercial_runtime/,
    )
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
