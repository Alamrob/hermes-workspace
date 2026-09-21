import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const migrationUrl = new URL(
  '../migrations/041_policy_v2_recipient_contract.sql',
  import.meta.url,
)
const rollbackUrl = new URL(
  '../migrations/041_policy_v2_recipient_contract.rollback.sql',
  import.meta.url,
)

describe('policy-v2 bounded recipient contract', () => {
  it('binds at most ten role-based recipients to the inert R43 preparation gate', async () => {
    const sql = await readFile(migrationUrl, 'utf8')
    assert.match(sql, /expected_recipient_count BETWEEN 1 AND 10/)
    assert.match(sql, /maximum_initial_messages_per_company=1/)
    assert.match(sql, /contact_type='role_based_corporate_email_published_by_the_account'/)
    assert.match(sql, /split_part\(recipient,'@',1\)=recipient_role/)
    assert.match(sql, /source_confidence='high'/)
    assert.match(sql, /UNIQUE\(preparation_authorization_id\)/)
    assert.match(sql, /POLICY_V2_PREPARATION_GATE_REQUIRED/)
    assert.match(sql, /POLICY_V2_RECIPIENT_SUPPRESSED/)
    assert.match(sql, /POLICY_V2_RECIPIENT_LIMIT_EXCEEDED/)
  })

  it('creates no target, activation, delivery policy, mission, or external action', async () => {
    const sql = await readFile(migrationUrl, 'utf8')
    assert.doesNotMatch(
      sql,
      /INSERT\s+INTO\s+(?:control\.pilot_cohorts|control\.pilot_targets|catalog\.version_activations|mail\.delivery_policies|mail\.delivery_policy_activations|control\.missions|control\.approvals|mail\.external_actions)/i,
    )
    assert.doesNotMatch(sql, /mail\.send|control\.enqueue_dispatch|integration\.enqueue_crm_change/i)
    assert.match(sql, /'activationAuthorizationRecorded',false/)
    assert.match(sql, /'activationAllowed',false/)
    assert.match(sql, /'targetCreationAllowed',false/)
    assert.match(sql, /'sendAllowed',false/)
  })

  it('keeps recipient evidence immutable and unavailable to runtime readers or writers', async () => {
    const sql = await readFile(migrationUrl, 'utf8')
    assert.match(sql, /POLICY_V2_DELIVERY_CONTRACT_IMMUTABLE/)
    assert.doesNotMatch(
      sql,
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE).*policy_v2_delivery_(?:contracts|recipients)/is,
    )
    assert.match(sql, /GRANT EXECUTE ON FUNCTION control\.build_policy_v2_delivery_contract_state\(uuid\) TO commercial_runtime/)
  })

  it('requires current transport readiness before a contract is complete', async () => {
    const sql = await readFile(migrationUrl, 'utf8')
    assert.match(sql, /policy_v2_external_transport_readiness/)
    assert.match(sql, /AND external_transport_ready/)
    assert.match(sql, /WHEN NOT external_transport_ready THEN 'external_transport_readiness'/)
  })

  it('rolls back only before any contract or recipient history exists', async () => {
    const rollback = await readFile(rollbackUrl, 'utf8')
    assert.match(rollback, /POLICY_V2_DELIVERY_CONTRACT_HISTORY_PRESENT/)
    assert.match(rollback, /DELETE FROM control\.schema_migrations\s+WHERE version='041_policy_v2_recipient_contract'/)
  })
})
