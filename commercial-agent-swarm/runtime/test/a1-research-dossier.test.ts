import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { validateA1ResearchDossier } from '../src/a1-research-dossier.js'

const REVIEW = 'a2500000-0000-4500-8500-000000000053'

function dossier(status: 'review_incomplete' | 'no_eligible_accounts' | 'authorization_required' = 'review_incomplete'): any {
  const accounts = status === 'authorization_required' ? [
    { slot: 1, companyName: 'Cuenta Uno', sourceUrl: 'https://cuenta-uno.cl/', decision: 'accepted_internal', decisionVersion: 1 },
    { slot: 3, companyName: 'Cuenta Tres', sourceUrl: 'https://cuenta-tres.cl/', decision: 'revised_internal', decisionVersion: 2 },
  ] : []
  return {
    reviewId: REVIEW, projectId: 'proptimiza', offerId: 'operacion-sin-planillas', offerVersion: 'v1', status,
    reviewCompleted: status !== 'review_incomplete', eligibleAccountCount: accounts.length, accounts,
    autonomyLevel: 'A1', allowedActions: ['analysis.internal','research.public.read'],
    prohibitedActions: ['credit.consume','personal_contact.discover','personal_email.infer','crm.write','mail.send','message.send','campaign.activate','a3.enable'],
    approvedChannels: ['internal','public_web'], requestedTools: ['hermes.analysis','hermes.web'],
    allowedDataCategories: ['public_company_identity','public_business_information','public_source_provenance','published_role_based_corporate_channel'],
    maximumAccounts: accounts.length, maximumContacts: 0, maximumExternalActions: 0, maximumBudgetUsd: 0.5,
    providerCreditSpendAllowed: false, internetAccessAllowed: false, contactPermitted: false, crmWriteAllowed: false,
    authorizationRequired: status === 'authorization_required', missionCreated: false, productionGate: 'blocked', externalActions: 0,
    provenance: { source: 'control-broker', sourceId: `a1-research-dossier:${REVIEW}`, observedAt: '2026-08-28T15:00:00.000Z', synthetic: false },
  }
}

describe('dormant A1 corporate-channel research dossier', () => {
  it('projects only internally accepted or revised companies while keeping execution disabled', () => {
    const value = validateA1ResearchDossier(dossier('authorization_required'))
    assert.equal(value.eligibleAccountCount, 2)
    assert.deepEqual(value.accounts.map((account) => account.slot), [1,3])
    assert.equal(value.internetAccessAllowed, false)
    assert.equal(value.providerCreditSpendAllowed, false)
    assert.equal(value.maximumContacts, 0)
    assert.equal(value.maximumExternalActions, 0)
    assert.equal(value.contactPermitted, false)
    assert.equal(value.missionCreated, false)
  })

  it('fails closed for incomplete review and closes cleanly when every draft is rejected', () => {
    assert.equal(validateA1ResearchDossier(dossier()).status, 'review_incomplete')
    assert.equal(validateA1ResearchDossier(dossier('no_eligible_accounts')).authorizationRequired, false)
    for (const mutation of [
      { internetAccessAllowed: true }, { providerCreditSpendAllowed: true }, { maximumContacts: 1 },
      { maximumExternalActions: 1 }, { contactPermitted: true }, { crmWriteAllowed: true },
      { missionCreated: true }, { productionGate: 'open' },
    ]) assert.throws(() => validateA1ResearchDossier({ ...dossier('authorization_required'), ...mutation }), /A1_RESEARCH_DOSSIER_INVALID/)
  })

  it('migration is read-only, derives scope from human decisions and grants only the runtime reader', async () => {
    const sql = await readFile(new URL('../migrations/025_a1_research_dossier.sql', import.meta.url), 'utf8')
    assert.match(sql, /human_decision IN\('accepted_internal','revised_internal'\)/)
    assert.match(sql, /approval_state='internal_reviewed'/)
    assert.match(sql, /external_action_eligible=false/)
    assert.match(sql, /'providerCreditSpendAllowed',false/)
    assert.match(sql, /'internetAccessAllowed',false/)
    assert.match(sql, /'maximumContacts',0/)
    assert.match(sql, /'maximumExternalActions',0/)
    assert.match(sql, /GRANT EXECUTE ON FUNCTION control\.build_a1_research_dossier\(uuid\) TO commercial_runtime/)
    assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE|control\.save_mission|control\.enqueue_dispatch|control\.request_approval|mail\.external_actions/i)
    const rollback = await readFile(new URL('../migrations/025_a1_research_dossier.rollback.sql', import.meta.url), 'utf8')
    assert.match(rollback, /DELETE FROM control\.schema_migrations WHERE version='025_a1_research_dossier'/)
  })
})
