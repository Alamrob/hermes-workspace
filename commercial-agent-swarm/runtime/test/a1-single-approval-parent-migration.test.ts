import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const migrationUrl = new URL('../migrations/037_a1_single_approval_parent.sql', import.meta.url)
const rollbackUrl = new URL('../migrations/037_a1_single_approval_parent.rollback.sql', import.meta.url)

describe('A1 single-approval parent persistence migration', () => {
  it('records one immutable byte-bound parent under a dedicated capability', async () => {
    const sql = await readFile(migrationUrl, 'utf8')
    assert.match(sql, /CREATE ROLE commercial_a1_chain_runner NOLOGIN NOSUPERUSER/)
    assert.match(sql, /CREATE TABLE control\.a1_single_approval_parent_consumptions/)
    assert.match(sql, /CREATE TRIGGER a1_single_approval_parent_immutable/)
    assert.match(sql, /A1_SINGLE_APPROVAL_PARENT_ALREADY_CONSUMED/)
    assert.match(sql, /consume_stage_receipt_key=idempotency_key/)
    assert.match(sql, /cardinality\(assignment_ids\)=6/)
    assert.match(sql, /maximum_dispatch_ticks=6/)
    assert.match(sql, /reviewer_email='proptimizaspa@gmail\.com'/)
    assert.match(sql, /control\.external_actions_blocked\(\)/)
    assert.match(sql, /scope='channel' AND active/)
    assert.match(sql, /status IN\('pending','leased','outcome_unknown'\)/)
  })

  it('exposes only consume, inspect and recontain to the chain runner', async () => {
    const sql = await readFile(migrationUrl, 'utf8')
    const grant = sql.slice(sql.lastIndexOf('GRANT EXECUTE ON FUNCTION'))
    assert.match(grant, /consume_a1_single_approval_parent\(jsonb\)/)
    assert.match(grant, /get_a1_single_approval_chain_state\(uuid\)/)
    assert.match(grant, /recontain_a1_single_approval_chain\(uuid,text\)/)
    assert.match(grant, /TO commercial_a1_chain_runner/)
    assert.doesNotMatch(grant, /enqueue_dispatch|claim_dispatch|mail\.|integration\.|activate_a1_dispatch_execution_window/)
    assert.doesNotMatch(sql, /GRANT (SELECT|INSERT|UPDATE|DELETE|ALL) ON control\.a1_single_approval_parent_consumptions/)
  })

  it('fails closed on uncontained migration or rollback after any consumption', async () => {
    const [sql, rollback] = await Promise.all([
      readFile(migrationUrl, 'utf8'),
      readFile(rollbackUrl, 'utf8'),
    ])
    assert.match(sql, /A1_SINGLE_APPROVAL_MIGRATION_REQUIRES_CONTAINMENT/)
    assert.match(sql, /status='leased' OR usage_budget_state='held_uncertain'/)
    assert.match(rollback, /A1_SINGLE_APPROVAL_ROLLBACK_REQUIRES_EMPTY_CONTAINED_LEDGER/)
    assert.match(rollback, /IF EXISTS\(SELECT 1 FROM control\.a1_single_approval_parent_consumptions\)/)
    assert.doesNotMatch(rollback, /DELETE FROM control\.a1_single_approval_parent_consumptions/)
  })

  it('can only close an existing window and never opens a channel or creates work', async () => {
    const sql = await readFile(migrationUrl, 'utf8')
    assert.match(sql, /recontain_a1_dispatch_execution_window\(\$1,\$2\)/)
    assert.match(sql, /set_kill_switch\('global','\*',true\)/)
    assert.doesNotMatch(sql, /set_kill_switch\('global','\*',false\)/)
    assert.doesNotMatch(sql, /enqueue_dispatch\(|claim_dispatch\(|save_mission|INSERT INTO control\.missions/)
    assert.doesNotMatch(sql, /mail\.send|integration\.enqueue_crm_change/)
  })
})
