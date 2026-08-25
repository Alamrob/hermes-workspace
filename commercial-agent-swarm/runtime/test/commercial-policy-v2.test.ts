import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('commercial policy v2 draft', () => {
  it('locks the reviewed document exactly while leaving every activation false', async () => {
    const policy = JSON.parse(await readFile(
      new URL('../policies/proptimiza-commercial-policy-v2.json', import.meta.url),
      'utf8',
    ))
    const migration = await readFile(
      new URL('../migrations/021_commercial_policy_v2_draft.sql', import.meta.url),
      'utf8',
    )
    const embedded = migration.match(/\$policy\$(\{[\s\S]*?\})\$policy\$::jsonb/)
    assert.ok(embedded)
    assert.deepEqual(JSON.parse(embedded[1]), policy)
    assert.equal(policy.status, 'draft_human_approval_required')
    assert.equal(policy.effective, false)
    assert.equal(policy.external_contact, false)
    assert.equal(policy.human_review.completed, false)
    assert.equal(policy.human_review.activation_requires_new_immutable_record, true)
    assert.equal(policy.contact_policy.maximum_companies, 10)
    assert.equal(policy.contact_policy.maximum_initial_messages_per_company, 1)
    assert.equal(policy.contact_policy.automatic_follow_up, false)
    assert.equal(policy.contact_policy.tracking_pixels, false)
    assert.equal(policy.contact_policy.tracking_links, false)
    assert.equal(policy.approval_policy.human_approval_per_external_action, true)
    assert.equal(policy.approval_policy.approval_token_single_use, true)
    assert.equal(policy.activation_conditions.internal_mail_attested, false)
    assert.equal(policy.activation_conditions.external_pilot_authorized, false)
    assert.equal(policy.activation_conditions.delivery_policy_created, false)
    assert.equal(policy.activation_conditions.version_activation_created, false)
    assert.deepEqual(
      policy.legal_snapshot.sources.map((source: { url: string }) => new URL(source.url).hostname),
      ['www.bcn.cl', 'www.bcn.cl', 'www.bcn.cl'],
    )
    assert.doesNotMatch(migration, /INSERT INTO\s+(?:mail\.delivery_policies|mail\.delivery_policy_activations|catalog\.version_activations)/i)
  })
})
