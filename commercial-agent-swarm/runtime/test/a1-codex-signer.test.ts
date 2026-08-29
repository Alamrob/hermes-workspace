import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'
import { signAuthorizedA1Order } from '../src/a1-codex-signer.js'
import { buildA1AuthorizedOrderCandidate } from '../src/a1-authorized-order-candidate.js'
import { buildA1ExactOrderCandidate } from '../src/a1-exact-order-candidate.js'
import { hashA1ResearchDossier, type A1ResearchAuthorizationState } from '../src/a1-research-authorization.js'
import type { A1ResearchDossier } from '../src/a1-research-dossier.js'
import type { A1ResearchOrderAuthorizationState } from '../src/a1-research-order-authorization.js'

const NOW = new Date('2026-08-28T20:15:00.000Z')
const EXPIRES = '2026-08-28T20:30:00.000Z'
const REVIEW = 'a2500000-0000-4500-8500-000000000053'
const pair = generateKeyPairSync('ed25519')
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const authority = { issuer: 'proptimiza-commercial-broker', audience: 'proptimiza-hermes-executor', keys: {}, ed25519PublicKeys: { 'codex-a1-ed25519-v1': publicKey } }

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
    authorization: { authorizationId: '62500000-0000-4500-8500-000000000053', decision: 'approved', rationale: 'Autoriza preparar la orden exacta para firma separada.', reviewerId: 'director', reviewerEmail: 'proptimizaspa@gmail.com', reviewedAt: '2026-08-28T20:05:00.000Z', expiresAt: EXPIRES, dossierSha256: digest, attestations: { noContact: true, noCrmWrite: true, noExternalActions: true, noProviderCreditSpend: true, separateSignedWorkOrderRequired: true } },
    executionAuthorized: false, missionCreated: false, internetAccessAllowed: false, providerCreditSpendAllowed: false, contactPermitted: false, crmWriteAllowed: false, maximumExternalActions: 0, productionGate: 'blocked', separateSignedWorkOrderRequired: true, nextRequiredGate: 'separate_signed_work_order',
    provenance: { source: 'control-broker', sourceId: `a1-research-authorization:${REVIEW}`, observedAt: NOW.toISOString(), synthetic: false },
  }
}

function candidate() {
  const exact = buildA1ExactOrderCandidate(dossier(), parent(), authority, NOW)
  const orderAuthorization: A1ResearchOrderAuthorizationState = {
    orderAuthorizationId: exact.orderAuthorizationId, reviewId: REVIEW, parentAuthorizationId: exact.parentAuthorizationId,
    decision: 'approved', rationale: 'Autoriza únicamente la orden exacta para firma Codex separada.', reviewerId: 'director', reviewerEmail: 'proptimizaspa@gmail.com', reviewedAt: '2026-08-28T20:10:00.000Z', expiresAt: EXPIRES,
    dossierSha256: exact.dossierSha256, unsignedWorkOrderSha256: exact.unsignedWorkOrderSha256, missionId: exact.missionId, userAuthorizationSha256: 'd'.repeat(64),
    attestations: { exactWorkOrderConfirmed: true, noContact: true, noCrmWrite: true, noExternalActions: true, noProviderCreditSpend: true }, idempotencyKey: 'a1-order-auth:codex-signer-test',
    executionAuthorized: false, missionCreated: false, dispatchQueued: false, internetAccessAllowed: false, providerCreditSpendAllowed: false, contactPermitted: false, crmWriteAllowed: false, maximumExternalActions: 0, productionGate: 'blocked', nextRequiredGate: 'sign_exact_work_order',
    provenance: { source: 'control-broker', sourceId: `a1-research-order-authorization:${exact.orderAuthorizationId}`, observedAt: NOW.toISOString(), synthetic: false },
  }
  return buildA1AuthorizedOrderCandidate(dossier(), parent(), orderAuthorization, authority, NOW)
}

function expectation(value = candidate()) {
  return { orderAuthorizationId: value.orderAuthorizationId, reviewId: value.reviewId, parentAuthorizationId: value.parentAuthorizationId, missionId: value.missionId, dossierSha256: value.dossierSha256, unsignedWorkOrderSha256: value.unsignedWorkOrderSha256, keyId: 'codex-a1-ed25519-v1' }
}

describe('offline Codex A1 signer', () => {
  it('signs only the exact authorized projection and still performs no persistence or dispatch', () => {
    const value = candidate()
    const signed = signAuthorizedA1Order(value, expectation(value), privateKey, publicKey, authority, NOW)
    assert.match((signed.workOrder.authority as any).signature, /^[a-f0-9]{128}$/)
    assert.notEqual((signed.workOrder.authority as any).signature, '0'.repeat(128))
    assert.equal(signed.persisted, false)
    assert.equal(signed.missionCreated, false)
    assert.equal(signed.dispatchQueued, false)
    assert.equal(signed.nextRequiredGate, 'submit_signed_order_separately')
  })

  it('rejects stale, altered, mismatched-key or expanded candidates', () => {
    const value = candidate()
    assert.throws(() => signAuthorizedA1Order(value, expectation(value), privateKey, publicKey, authority, new Date(EXPIRES)), /A1_CODEX_SIGNING_GATE_CLOSED/)
    const changed = candidate(); changed.workOrder.objective = 'changed'
    assert.throws(() => signAuthorizedA1Order(changed, expectation(changed), privateKey, publicKey, authority, NOW), /A1_CODEX_SIGNING_GATE_CLOSED/)
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    assert.throws(() => signAuthorizedA1Order(value, expectation(value), privateKey, other, authority, NOW), /A1_CODEX_SIGNING_GATE_CLOSED/)
    const expanded = candidate(); (expanded as any).maximumExternalActions = 1
    assert.throws(() => signAuthorizedA1Order(expanded, expectation(expanded), privateKey, publicKey, authority, NOW), /A1_CODEX_SIGNING_GATE_CLOSED/)
  })
})
