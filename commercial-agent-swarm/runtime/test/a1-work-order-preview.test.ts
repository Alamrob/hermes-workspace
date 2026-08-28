import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildA1WorkOrderPreview } from '../src/a1-work-order-preview.js'
import { hashA1ResearchDossier, type A1ResearchAuthorizationState } from '../src/a1-research-authorization.js'
import type { A1ResearchDossier } from '../src/a1-research-dossier.js'

const REVIEW = 'a2500000-0000-4500-8500-000000000053'
const NOW = new Date('2026-08-28T15:00:00.000Z')

function dossier(): A1ResearchDossier {
  return {
    reviewId: REVIEW, projectId: 'proptimiza', offerId: 'operacion-sin-planillas', offerVersion: 'v1',
    status: 'authorization_required', reviewCompleted: true, eligibleAccountCount: 1,
    accounts: [{ slot: 1, companyName: 'Cuenta Uno', sourceUrl: 'https://cuenta-uno.cl/', decision: 'accepted_internal', decisionVersion: 1 }],
    autonomyLevel: 'A1', allowedActions: ['analysis.internal','research.public.read'],
    prohibitedActions: ['credit.consume','personal_contact.discover','personal_email.infer','crm.write','mail.send','message.send','campaign.activate','a3.enable'],
    approvedChannels: ['internal','public_web'], requestedTools: ['hermes.analysis','hermes.web'],
    allowedDataCategories: ['public_company_identity','public_business_information','public_source_provenance','published_role_based_corporate_channel'],
    maximumAccounts: 1, maximumContacts: 0, maximumExternalActions: 0, maximumBudgetUsd: 0.5,
    providerCreditSpendAllowed: false, internetAccessAllowed: false, contactPermitted: false, crmWriteAllowed: false,
    authorizationRequired: true, missionCreated: false, productionGate: 'blocked', externalActions: 0,
    provenance: { source: 'control-broker', sourceId: `a1-research-dossier:${REVIEW}`, observedAt: NOW.toISOString(), synthetic: false },
  }
}

function authorization(expiresAt = '2026-08-28T15:30:00.000Z'): A1ResearchAuthorizationState {
  const sha = hashA1ResearchDossier(dossier())
  return {
    reviewId: REVIEW, projectId: 'proptimiza', offerId: 'operacion-sin-planillas', offerVersion: 'v1', dossierSha256: sha,
    dossierStatus: 'authorization_required', eligibleAccountCount: 1, authorizationRecorded: true, dossierCurrent: true,
    authorization: { authorizationId: '62500000-0000-4500-8500-000000000053', decision: 'approved', rationale: 'Aprobación inerte para preparar una orden separada sin ejecutarla.', reviewerId: 'director', reviewerEmail: 'proptimizaspa@gmail.com', reviewedAt: NOW.toISOString(), expiresAt, dossierSha256: sha, attestations: { noContact: true, noCrmWrite: true, noExternalActions: true, noProviderCreditSpend: true, separateSignedWorkOrderRequired: true } },
    executionAuthorized: false, missionCreated: false, internetAccessAllowed: false, providerCreditSpendAllowed: false,
    contactPermitted: false, crmWriteAllowed: false, maximumExternalActions: 0, productionGate: 'blocked',
    separateSignedWorkOrderRequired: true, nextRequiredGate: 'separate_signed_work_order',
    provenance: { source: 'control-broker', sourceId: `a1-research-authorization:${REVIEW}`, observedAt: NOW.toISOString(), synthetic: false },
  }
}

function emptyAuthorizationState(): A1ResearchAuthorizationState {
  const sha = hashA1ResearchDossier(dossier())
  return {
    reviewId: REVIEW, projectId: 'proptimiza', offerId: 'operacion-sin-planillas', offerVersion: 'v1', dossierSha256: sha,
    dossierStatus: 'authorization_required', eligibleAccountCount: 1, authorizationRecorded: false, dossierCurrent: true,
    authorization: null, executionAuthorized: false, missionCreated: false, internetAccessAllowed: false,
    providerCreditSpendAllowed: false, contactPermitted: false, crmWriteAllowed: false, maximumExternalActions: 0,
    productionGate: 'blocked', separateSignedWorkOrderRequired: true, nextRequiredGate: 'human_authorization',
    provenance: { source: 'control-broker', sourceId: `a1-research-authorization:${REVIEW}`, observedAt: NOW.toISOString(), synthetic: false },
  }
}

describe('A1 work-order preview', () => {
  it('produces a stable, unsigned and undispatchable preview after a current human authorization', () => {
    const preview = buildA1WorkOrderPreview(dossier(), authorization(), NOW)
    assert.equal(preview.nextRequiredGate, 'separate_signed_work_order')
    assert.equal(preview.signedWorkOrderPresent, false)
    assert.equal(preview.workOrderPersisted, false)
    assert.equal(preview.missionCreated, false)
    assert.equal(preview.dispatchQueued, false)
    assert.equal(preview.executionAuthorized, false)
    assert.equal(preview.internetAccessAllowed, false)
    assert.equal(preview.providerCreditSpendAllowed, false)
    assert.equal(preview.maximumExternalActions, 0)
    assert.match(preview.previewSha256, /^[a-f0-9]{64}$/)
    assert.equal(buildA1WorkOrderPreview(dossier(), authorization(), new Date('2026-08-28T15:01:00.000Z')).previewSha256, preview.previewSha256)
  })

  it('fails closed when authorization is missing or expired', () => {
    assert.equal(buildA1WorkOrderPreview(dossier(), null, NOW).nextRequiredGate, 'human_authorization')
    assert.equal(buildA1WorkOrderPreview(dossier(), emptyAuthorizationState(), NOW).nextRequiredGate, 'human_authorization')
    const expired = buildA1WorkOrderPreview(dossier(), authorization('2026-08-28T14:59:59.000Z'), NOW)
    assert.equal(expired.nextRequiredGate, 'authorization_expired')
    assert.equal(expired.executionAuthorized, false)
  })
})
