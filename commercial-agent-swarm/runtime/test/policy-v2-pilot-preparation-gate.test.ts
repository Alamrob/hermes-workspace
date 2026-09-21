import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const migrationUrl = new URL(
  '../migrations/040_policy_v2_pilot_preparation_gate.sql',
  import.meta.url,
)
const rollbackUrl = new URL(
  '../migrations/040_policy_v2_pilot_preparation_gate.rollback.sql',
  import.meta.url,
)

describe('policy-v2 pilot preparation gate', () => {
  it('recognizes only the exact preparation-only R43 scope', async () => {
    const sql = await readFile(migrationUrl, 'utf8')
    assert.match(sql, /fc14a614af12611fc287fc4581cce819f05eaedab13d2882505034616e210954/)
    assert.match(sql, /"preparation_only":true/)
    assert.match(sql, /"external_actions_authorized":false/)
    assert.match(sql, /"maximum_companies":10/)
    assert.match(sql, /"maximum_initial_messages_per_company":1/)
    assert.match(sql, /"tracking":false/)
    assert.match(sql, /"automatic_follow_up":false/)
    assert.match(sql, /"a3_enabled":false/)
  })

  it('creates no cohort, target, activation, delivery policy, mission, approval, or external action', async () => {
    const sql = await readFile(migrationUrl, 'utf8')
    assert.doesNotMatch(
      sql,
      /INSERT\s+INTO\s+(?:control\.pilot_cohorts|control\.pilot_targets|catalog\.version_activations|mail\.delivery_policies|mail\.delivery_policy_activations|control\.missions|control\.approvals|mail\.external_actions)/i,
    )
    assert.doesNotMatch(sql, /mail\.send|integration\.enqueue_crm_change/i)
    assert.match(sql, /'activationAuthorizationRecorded',false/)
    assert.match(sql, /'targetCreationAllowed',false/)
    assert.match(sql, /'sendAllowed',false/)
    assert.match(sql, /'activationAllowed',false/)
  })

  it('keeps transport evidence immutable, secret-free, and unavailable to runtime writers', async () => {
    const sql = await readFile(migrationUrl, 'utf8')
    assert.match(sql, /provider_calls integer NOT NULL CHECK \(provider_calls=0\)/)
    assert.match(sql, /secret_values_disclosed boolean NOT NULL CHECK \(NOT secret_values_disclosed\)/)
    assert.match(sql, /POLICY_V2_TRANSPORT_READINESS_IMMUTABLE/)
    assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|DELETE).*policy_v2_external_transport_readiness/is)
    assert.doesNotMatch(
      sql,
      /(?:credential|token|password|secret)_value\s+text|password\s+text/i,
    )
  })

  it('rolls back only while the readiness ledger is empty', async () => {
    const rollback = await readFile(rollbackUrl, 'utf8')
    assert.match(rollback, /POLICY_V2_TRANSPORT_READINESS_HISTORY_PRESENT/)
    assert.match(rollback, /DELETE FROM control\.schema_migrations\s+WHERE version='040_policy_v2_pilot_preparation_gate'/)
  })
})
