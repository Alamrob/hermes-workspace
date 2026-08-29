import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  a1ResearchOrderMetadata,
  a1ResearchReviewId,
  assertA1ResearchWorkOrderAdmission,
  expectedA1ResearchOrderEvidence,
} from '../src/a1-research-work-order.js'
import { hashUnsignedA1ResearchWorkOrder, type A1ResearchOrderAuthorizationState } from '../src/a1-research-order-authorization.js'
import { hashA1ResearchDossier, type A1ResearchAuthorizationState } from '../src/a1-research-authorization.js'
import type { A1ResearchDossier } from '../src/a1-research-dossier.js'
import type { WorkOrder } from '../src/work-orders.js'
import { validWorkOrder } from './fixtures.js'

const REVIEW = 'a2500000-0000-4500-8500-000000000053'
const ORDER_AUTH = '72500000-0000-4500-8500-000000000053'
const NOW = new Date('2026-08-28T20:15:00.000Z')

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

function authorization(expiresAt = '2026-08-28T20:30:00.000Z'): A1ResearchAuthorizationState {
  const sha = hashA1ResearchDossier(dossier())
  return {
    reviewId: REVIEW, projectId: 'proptimiza', offerId: 'operacion-sin-planillas', offerVersion: 'v1', dossierSha256: sha,
    dossierStatus: 'authorization_required', eligibleAccountCount: 1, authorizationRecorded: true, dossierCurrent: true,
    authorization: {
      authorizationId: '62500000-0000-4500-8500-000000000053', decision: 'approved',
      rationale: 'Autoriza solo preparar una orden firmada posterior.', reviewerId: 'director', reviewerEmail: 'proptimizaspa@gmail.com',
      reviewedAt: '2026-08-28T20:00:00.000Z', expiresAt, dossierSha256: sha,
      attestations: { noContact: true, noCrmWrite: true, noExternalActions: true, noProviderCreditSpend: true, separateSignedWorkOrderRequired: true },
    },
    executionAuthorized: false, missionCreated: false, internetAccessAllowed: false, providerCreditSpendAllowed: false,
    contactPermitted: false, crmWriteAllowed: false, maximumExternalActions: 0, productionGate: 'blocked',
    separateSignedWorkOrderRequired: true, nextRequiredGate: 'separate_signed_work_order',
    provenance: { source: 'control-broker', sourceId: `a1-research-authorization:${REVIEW}`, observedAt: NOW.toISOString(), synthetic: false },
  }
}

function order(): WorkOrder {
  const value: any = validWorkOrder()
  const evidence = expectedA1ResearchOrderEvidence(dossier(), authorization(), {
    orderAuthorizationId: ORDER_AUTH, orderAuthorizationExpiresAt: '2026-08-28T20:30:00.000Z',
    unsignedWorkOrderSha256: '0'.repeat(64),
    userAuthorizationSha256: 'c'.repeat(64), userAuthorizedAt: '2026-08-28T20:05:00.000Z',
  })
  value.created_at = '2026-08-28T20:10:00.000Z'
  value.expires_at = '2026-08-28T20:25:00.000Z'
  value.offer_version = 'v1'
  value.icp_version = 'icp-v1'
  value.policy_version = 'policy-v1'
  value.allowed_actions = [...dossier().allowedActions]
  value.prohibited_actions = [...dossier().prohibitedActions]
  value.approved_channels = [...dossier().approvedChannels]
  value.approved_tools = [...dossier().requestedTools]
  value.autonomy_level = 'A1'
  value.budget_limit = { currency: 'USD', maximum: 0.5 }
  value.volume_limits = { maximum_accounts: 1, maximum_contacts: 0, maximum_external_actions: 0, maximum_per_contact: 0, period: 'mission' }
  value.approval_token = null
  value.requested_by = 'codex-auditor'
  value.data_policy = {
    classification: 'public', allowed_countries: ['CL'], legal_basis: ['public_source_reviewed'], retention_days: 30,
    sensitive_data_allowed: false, allowed_data_categories: [...dossier().allowedDataCategories],
  }
  value.contact_policy = {
    contact_permitted: false, suppression_check_required: true, consent_check_required: false,
    maximum_frequency_days: 0, quiet_hours_timezone: 'America/Santiago',
  }
  value.dry_run = true
  value.authority.algorithm = 'Ed25519'
  value.authority.key_id = 'codex-a1-ed25519-v1'
  value.authority.signature = '0'.repeat(128)
  value.metadata = a1ResearchOrderMetadata(dossier(), evidence)
  value.metadata.a1_research_order_unsigned_sha256 = hashUnsignedA1ResearchWorkOrder(value as WorkOrder)
  return value as WorkOrder
}

function orderAuthorization(value: WorkOrder = order()): A1ResearchOrderAuthorizationState {
  return {
    orderAuthorizationId: ORDER_AUTH, reviewId: REVIEW,
    parentAuthorizationId: '62500000-0000-4500-8500-000000000053', decision: 'approved',
    rationale: 'Autoriza solamente la orden A1 exacta y sus límites internos.',
    reviewerId: 'director', reviewerEmail: 'proptimizaspa@gmail.com',
    reviewedAt: '2026-08-28T20:05:00.000Z', expiresAt: '2026-08-28T20:30:00.000Z',
    dossierSha256: hashA1ResearchDossier(dossier()),
    unsignedWorkOrderSha256: hashUnsignedA1ResearchWorkOrder(value), missionId: value.mission_id,
    userAuthorizationSha256: 'c'.repeat(64),
    attestations: { exactWorkOrderConfirmed:true,noContact:true,noCrmWrite:true,noExternalActions:true,noProviderCreditSpend:true },
    idempotencyKey: 'a1-order-auth:review-00000053', executionAuthorized:false,missionCreated:false,
    dispatchQueued:false,internetAccessAllowed:false,providerCreditSpendAllowed:false,contactPermitted:false,
    crmWriteAllowed:false,maximumExternalActions:0,productionGate:'blocked',nextRequiredGate:'sign_exact_work_order',
    provenance: { source:'control-broker',sourceId:`a1-research-order-authorization:${ORDER_AUTH}`,observedAt:NOW.toISOString(),synthetic:false },
  }
}

describe('A1 research work-order admission', () => {
  it('admits only a current signed-order candidate bound to the dossier, authorization and exact accounts', () => {
    const value = order()
    assert.equal(a1ResearchReviewId(value), REVIEW)
    assert.doesNotThrow(() => assertA1ResearchWorkOrderAdmission(value, dossier(), authorization(), orderAuthorization(value), NOW))
  })

  it('fails closed for missing authorization, expired authorization or changed account scope', () => {
    assert.throws(() => assertA1ResearchWorkOrderAdmission(order(), dossier(), null, null, NOW), /A1_RESEARCH_WORK_ORDER_NOT_AUTHORIZED/)
    assert.throws(() => assertA1ResearchWorkOrderAdmission(order(), dossier(), authorization('2026-08-28T20:14:59.000Z'), orderAuthorization(), NOW), /A1_RESEARCH_WORK_ORDER_NOT_AUTHORIZED/)
    const changed = order()
    ;(changed.metadata!.a1_research_accounts as Array<Record<string, unknown>>)[0]!.company_name = 'Cuenta Distinta'
    assert.throws(() => assertA1ResearchWorkOrderAdmission(changed, dossier(), authorization(), orderAuthorization(), NOW), /A1_RESEARCH_WORK_ORDER_NOT_AUTHORIZED/)
  })

  it('rejects budget, contact or public-research orders not bound to a review', () => {
    const overBudget = order()
    overBudget.budget_limit = { currency: 'USD', maximum: 0.51 }
    assert.throws(() => assertA1ResearchWorkOrderAdmission(overBudget, dossier(), authorization(), orderAuthorization(), NOW), /A1_RESEARCH_WORK_ORDER_NOT_AUTHORIZED/)
    const contact = order()
    ;(contact.contact_policy as Record<string, unknown>).contact_permitted = true
    assert.throws(() => assertA1ResearchWorkOrderAdmission(contact, dossier(), authorization(), orderAuthorization(), NOW), /A1_RESEARCH_WORK_ORDER_NOT_AUTHORIZED/)
    const unbound = order()
    delete unbound.metadata!.a1_research_review_id
    assert.throws(() => a1ResearchReviewId(unbound), /A1_RESEARCH_WORK_ORDER_NOT_AUTHORIZED/)
  })

  it('does not affect internal work orders without public research', () => {
    const internal = order()
    internal.autonomy_level = 'A0'
    internal.allowed_actions = ['analysis.internal']
    internal.approved_channels = ['internal']
    assert.equal(a1ResearchReviewId(internal), null)
  })
})
