import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  hashA1ResearchDossier,
  validateA1ResearchAuthorizationRequest,
  validateA1ResearchAuthorizationState,
} from '../src/a1-research-authorization.js'
import type { A1ResearchDossier } from '../src/a1-research-dossier.js'

const REVIEW = 'a2500000-0000-4500-8500-000000000053'
const NOW = new Date('2026-08-28T15:00:00.000Z')

function dossier(observedAt = NOW.toISOString()): A1ResearchDossier {
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
    provenance: { source: 'control-broker', sourceId: `a1-research-dossier:${REVIEW}`, observedAt, synthetic: false },
  }
}

function request() {
  return {
    decision: 'approved',
    rationale: 'Autorizo registrar el gate interno sin crear ni ejecutar una misión.',
    reviewer_id: 'cloudflare-director-subject',
    reviewer_email: 'proptimizaspa@gmail.com',
    reviewed_at: NOW.toISOString(),
    expires_at: '2026-08-28T15:30:00.000Z',
    expected_dossier_sha256: hashA1ResearchDossier(dossier()),
    attestations: {
      no_contact: true, no_crm_write: true, no_external_actions: true,
      no_provider_credit_spend: true, separate_signed_work_order_required: true,
    },
    idempotency_key: 'a1-research-auth:review-00000053',
  }
}

describe('dormant A1 research authorization gate', () => {
  it('hashes only the stable, decision-relevant dossier', () => {
    const first = hashA1ResearchDossier(dossier('2026-08-28T15:00:00.000Z'))
    const second = hashA1ResearchDossier(dossier('2026-08-28T15:01:00.000Z'))
    assert.equal(first, second)
    assert.notEqual(first, hashA1ResearchDossier({ ...dossier(), maximumAccounts: 0, eligibleAccountCount: 0, accounts: [] }))
  })

  it('requires the exact operator, five restrictive attestations and a 30-minute TTL', () => {
    const value = validateA1ResearchAuthorizationRequest(request(), NOW)
    assert.equal(value.reviewerEmail, 'proptimizaspa@gmail.com')
    assert.equal(value.attestations.separateSignedWorkOrderRequired, true)
    assert.throws(() => validateA1ResearchAuthorizationRequest({ ...request(), reviewer_email: 'lamrobcompany@gmail.com' }, NOW), /A1_RESEARCH_AUTHORIZATION_INVALID/)
    assert.throws(() => validateA1ResearchAuthorizationRequest({ ...request(), expires_at: '2026-08-28T15:30:01.000Z' }, NOW), /A1_RESEARCH_AUTHORIZATION_INVALID/)
    assert.throws(() => validateA1ResearchAuthorizationRequest({ ...request(), attestations: { ...request().attestations, no_contact: false } }, NOW), /A1_RESEARCH_AUTHORIZATION_INVALID/)
  })

  it('validates an approved record while keeping every execution capability closed', () => {
    const sha = hashA1ResearchDossier(dossier())
    const value = validateA1ResearchAuthorizationState({
      reviewId: REVIEW, projectId: 'proptimiza', offerId: 'operacion-sin-planillas', offerVersion: 'v1',
      dossierSha256: sha, dossierStatus: 'authorization_required', eligibleAccountCount: 1,
      authorizationRecorded: true, dossierCurrent: true,
      authorization: {
        authorizationId: '62500000-0000-4500-8500-000000000053', decision: 'approved',
        rationale: 'Autorizo registrar el gate interno sin crear ni ejecutar una misión.',
        reviewerId: 'cloudflare-director-subject', reviewerEmail: 'proptimizaspa@gmail.com',
        reviewedAt: NOW.toISOString(), expiresAt: '2026-08-28T15:30:00.000Z', dossierSha256: sha,
        attestations: { noContact: true, noCrmWrite: true, noExternalActions: true, noProviderCreditSpend: true, separateSignedWorkOrderRequired: true },
      },
      executionAuthorized: false, missionCreated: false, internetAccessAllowed: false,
      providerCreditSpendAllowed: false, contactPermitted: false, crmWriteAllowed: false,
      maximumExternalActions: 0, productionGate: 'blocked', separateSignedWorkOrderRequired: true,
      nextRequiredGate: 'separate_signed_work_order',
      provenance: { source: 'control-broker', sourceId: `a1-research-authorization:${REVIEW}`, observedAt: NOW.toISOString(), synthetic: false },
    })
    assert.equal(value.executionAuthorized, false)
    assert.equal(value.missionCreated, false)
    assert.equal(value.nextRequiredGate, 'separate_signed_work_order')
  })

  it('projects an expired authorization as renewable instead of executable', () => {
    const sha = hashA1ResearchDossier(dossier())
    const state = validateA1ResearchAuthorizationState({
      reviewId: REVIEW, projectId: 'proptimiza', offerId: 'operacion-sin-planillas', offerVersion: 'v1',
      dossierSha256: sha, dossierStatus: 'authorization_required', eligibleAccountCount: 1,
      authorizationRecorded: true, dossierCurrent: true,
      authorization: {
        authorizationId: '62500000-0000-4500-8500-000000000053', decision: 'approved',
        rationale: 'Autorización anterior conservada únicamente como evidencia histórica.',
        reviewerId: 'cloudflare-director-subject', reviewerEmail: 'proptimizaspa@gmail.com',
        reviewedAt: '2026-08-28T14:00:00.000Z', expiresAt: '2026-08-28T14:30:00.000Z', dossierSha256: sha,
        attestations: { noContact: true, noCrmWrite: true, noExternalActions: true, noProviderCreditSpend: true, separateSignedWorkOrderRequired: true },
      },
      executionAuthorized: false, missionCreated: false, internetAccessAllowed: false,
      providerCreditSpendAllowed: false, contactPermitted: false, crmWriteAllowed: false,
      maximumExternalActions: 0, productionGate: 'blocked', separateSignedWorkOrderRequired: true,
      nextRequiredGate: 'authorization_expired',
      provenance: { source: 'control-broker', sourceId: `a1-research-authorization:${REVIEW}`, observedAt: NOW.toISOString(), synthetic: false },
    })
    assert.equal(state.nextRequiredGate, 'authorization_expired')
    assert.equal(state.executionAuthorized, false)
  })

  it('migration is immutable, idempotent and cannot create missions or external actions', async () => {
    const sql = await readFile(new URL('../migrations/026_a1_research_authorization.sql', import.meta.url), 'utf8')
    assert.match(sql, /CREATE TABLE control\.a1_research_authorizations/)
    assert.match(sql, /UNIQUE REFERENCES control\.draft_review_sessions/)
    assert.match(sql, /A1_RESEARCH_AUTHORIZATION_IMMUTABLE_CONFLICT/)
    assert.match(sql, /'executionAuthorized',false/)
    assert.match(sql, /'internetAccessAllowed',false/)
    assert.match(sql, /'providerCreditSpendAllowed',false/)
    assert.match(sql, /'maximumExternalActions',0/)
    assert.match(sql, /'separateSignedWorkOrderRequired',true/)
    assert.doesNotMatch(sql, /\bauthorization\.[a-z_]+/)
    assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*TO commercial_runtime/)
    assert.doesNotMatch(sql, /control\.save_mission|control\.enqueue_dispatch|control\.request_approval|mail\.external_actions|mail\.send/i)
    const rollback = await readFile(new URL('../migrations/026_a1_research_authorization.rollback.sql', import.meta.url), 'utf8')
    assert.match(rollback, /DELETE FROM control\.schema_migrations WHERE version='026_a1_research_authorization'/)
  })
})
