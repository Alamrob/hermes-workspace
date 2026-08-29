import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildA1AuthorizedOrderCandidate } from '../src/a1-authorized-order-candidate.js'
import { buildA1ExactOrderCandidate } from '../src/a1-exact-order-candidate.js'
import { hashUnsignedA1ResearchWorkOrder, type A1ResearchOrderAuthorizationState } from '../src/a1-research-order-authorization.js'
import { hashA1ResearchDossier, type A1ResearchAuthorizationState } from '../src/a1-research-authorization.js'
import type { A1ResearchDossier } from '../src/a1-research-dossier.js'

const REVIEW = 'a2500000-0000-4500-8500-000000000053'
const NOW = new Date('2026-08-28T20:15:00.000Z')
const EXPIRES = '2026-08-28T20:30:00.000Z'
const authority = { issuer: 'codex', audience: 'hermes-commercial-orchestrator', keys: { 'control-key-1': 'test-control-key-with-at-least-32-bytes' } }

function dossier(): A1ResearchDossier {
  return {
    reviewId: REVIEW, projectId: 'proptimiza', offerId: 'operacion-sin-planillas', offerVersion: 'v1',
    status: 'authorization_required', reviewCompleted: true, eligibleAccountCount: 1,
    accounts: [{ slot: 1, companyName: 'Cuenta Uno', sourceUrl: 'https://cuenta-uno.cl/', decision: 'accepted_internal', decisionVersion: 2 }],
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

function parent(): A1ResearchAuthorizationState {
  const digest = hashA1ResearchDossier(dossier())
  return {
    reviewId: REVIEW, projectId: 'proptimiza', offerId: 'operacion-sin-planillas', offerVersion: 'v1', dossierSha256: digest,
    dossierStatus: 'authorization_required', eligibleAccountCount: 1, authorizationRecorded: true, dossierCurrent: true,
    authorization: { authorizationId: '62500000-0000-4500-8500-000000000053', decision: 'approved', rationale: 'Autoriza preparar una orden A1 exacta y separada.', reviewerId: 'director', reviewerEmail: 'proptimizaspa@gmail.com', reviewedAt: '2026-08-28T20:05:00.000Z', expiresAt: EXPIRES, dossierSha256: digest, attestations: { noContact: true, noCrmWrite: true, noExternalActions: true, noProviderCreditSpend: true, separateSignedWorkOrderRequired: true } },
    executionAuthorized: false, missionCreated: false, internetAccessAllowed: false, providerCreditSpendAllowed: false,
    contactPermitted: false, crmWriteAllowed: false, maximumExternalActions: 0, productionGate: 'blocked',
    separateSignedWorkOrderRequired: true, nextRequiredGate: 'separate_signed_work_order',
    provenance: { source: 'control-broker', sourceId: `a1-research-authorization:${REVIEW}`, observedAt: NOW.toISOString(), synthetic: false },
  }
}

function orderAuthorization(): A1ResearchOrderAuthorizationState {
  const candidate = buildA1ExactOrderCandidate(dossier(), parent(), authority, NOW)
  return {
    orderAuthorizationId: candidate.orderAuthorizationId, reviewId: REVIEW, parentAuthorizationId: candidate.parentAuthorizationId,
    decision: 'approved', rationale: 'Autoriza solamente esta orden A1 exacta y sus límites internos.', reviewerId: 'director',
    reviewerEmail: 'proptimizaspa@gmail.com', reviewedAt: '2026-08-28T20:10:00.000Z', expiresAt: EXPIRES,
    dossierSha256: candidate.dossierSha256, unsignedWorkOrderSha256: candidate.unsignedWorkOrderSha256,
    missionId: candidate.missionId, userAuthorizationSha256: 'c'.repeat(64),
    attestations: { exactWorkOrderConfirmed: true, noContact: true, noCrmWrite: true, noExternalActions: true, noProviderCreditSpend: true },
    idempotencyKey: 'a1-order-auth:authorized-candidate-00053', executionAuthorized: false, missionCreated: false,
    dispatchQueued: false, internetAccessAllowed: false, providerCreditSpendAllowed: false, contactPermitted: false,
    crmWriteAllowed: false, maximumExternalActions: 0, productionGate: 'blocked', nextRequiredGate: 'sign_exact_work_order',
    provenance: { source: 'control-broker', sourceId: `a1-research-order-authorization:${candidate.orderAuthorizationId}`, observedAt: NOW.toISOString(), synthetic: false },
  }
}

describe('A1 authorized exact work-order candidate', () => {
  it('projects a fully bound but still unsigned and unpersisted order for Codex signing', () => {
    const authorization = orderAuthorization()
    const value = buildA1AuthorizedOrderCandidate(dossier(), parent(), authorization, authority, NOW)
    const metadata = value.workOrder.metadata!
    assert.equal(value.orderAuthorizationId, authorization.orderAuthorizationId)
    assert.equal(value.exactOrderAuthorizationRecorded, true)
    assert.equal(value.signedWorkOrderPresent, false)
    assert.equal(value.workOrderPersisted, false)
    assert.equal(value.missionCreated, false)
    assert.equal(value.dispatchQueued, false)
    assert.equal(value.nextRequiredGate, 'codex_signature')
    assert.equal((value.workOrder.authority as any).signature, '0'.repeat(64))
    assert.equal(metadata.a1_research_order_authorization_sha256, authorization.userAuthorizationSha256)
    assert.equal(metadata.a1_research_order_authorized_at, authorization.reviewedAt)
    assert.equal(metadata.a1_research_order_authorized_by, 'proptimizaspa@gmail.com')
    assert.equal(hashUnsignedA1ResearchWorkOrder(value.workOrder), authorization.unsignedWorkOrderSha256)
  })

  it('fails closed for rejected, expired or mismatched exact authorization', () => {
    const rejected = orderAuthorization(); rejected.decision = 'rejected'
    assert.throws(() => buildA1AuthorizedOrderCandidate(dossier(), parent(), rejected, authority, NOW), /A1_AUTHORIZED_ORDER_CANDIDATE_GATE_CLOSED/)
    const expired = orderAuthorization(); expired.expiresAt = '2026-08-28T20:14:59.000Z'
    assert.throws(() => buildA1AuthorizedOrderCandidate(dossier(), parent(), expired, authority, NOW), /A1_AUTHORIZED_ORDER_CANDIDATE_GATE_CLOSED/)
    const changed = orderAuthorization(); changed.unsignedWorkOrderSha256 = 'f'.repeat(64)
    assert.throws(() => buildA1AuthorizedOrderCandidate(dossier(), parent(), changed, authority, NOW), /A1_AUTHORIZED_ORDER_CANDIDATE_GATE_CLOSED/)
  })
})
