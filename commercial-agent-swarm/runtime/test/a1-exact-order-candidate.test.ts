import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildA1ExactOrderCandidate } from '../src/a1-exact-order-candidate.js'
import { hashUnsignedA1ResearchWorkOrder } from '../src/a1-research-order-authorization.js'
import { assertA1ResearchWorkOrderCandidate } from '../src/a1-research-work-order.js'
import { hashA1ResearchDossier, type A1ResearchAuthorizationState } from '../src/a1-research-authorization.js'
import type { A1ResearchDossier } from '../src/a1-research-dossier.js'

const REVIEW = 'a2500000-0000-4500-8500-000000000053'
const NOW = new Date('2026-08-28T20:15:00.000Z')

function dossier(): A1ResearchDossier {
  return {
    reviewId:REVIEW,projectId:'proptimiza',offerId:'operacion-sin-planillas',offerVersion:'v1',
    status:'authorization_required',reviewCompleted:true,eligibleAccountCount:1,
    accounts:[{slot:1,companyName:'Cuenta Uno',sourceUrl:'https://cuenta-uno.cl/',decision:'accepted_internal',decisionVersion:2}],
    autonomyLevel:'A1',allowedActions:['analysis.internal','research.public.read'],
    prohibitedActions:['credit.consume','personal_contact.discover','personal_email.infer','crm.write','mail.send','message.send','campaign.activate','a3.enable'],
    approvedChannels:['internal','public_web'],requestedTools:['hermes.analysis','hermes.web'],
    allowedDataCategories:['public_company_identity','public_business_information','public_source_provenance','published_role_based_corporate_channel'],
    maximumAccounts:1,maximumContacts:0,maximumExternalActions:0,maximumBudgetUsd:0.5,
    providerCreditSpendAllowed:false,internetAccessAllowed:false,contactPermitted:false,crmWriteAllowed:false,
    authorizationRequired:true,missionCreated:false,productionGate:'blocked',externalActions:0,
    provenance:{source:'control-broker',sourceId:`a1-research-dossier:${REVIEW}`,observedAt:NOW.toISOString(),synthetic:false},
  }
}

function authorization(expiresAt = '2026-08-28T20:30:00.000Z'): A1ResearchAuthorizationState {
  const digest=hashA1ResearchDossier(dossier())
  return {
    reviewId:REVIEW,projectId:'proptimiza',offerId:'operacion-sin-planillas',offerVersion:'v1',dossierSha256:digest,
    dossierStatus:'authorization_required',eligibleAccountCount:1,authorizationRecorded:true,dossierCurrent:true,
    authorization:{authorizationId:'62500000-0000-4500-8500-000000000053',decision:'approved',rationale:'Autoriza preparar una orden A1 exacta y separada.',reviewerId:'director',reviewerEmail:'proptimizaspa@gmail.com',reviewedAt:'2026-08-28T20:05:00.000Z',expiresAt,dossierSha256:digest,attestations:{noContact:true,noCrmWrite:true,noExternalActions:true,noProviderCreditSpend:true,separateSignedWorkOrderRequired:true}},
    executionAuthorized:false,missionCreated:false,internetAccessAllowed:false,providerCreditSpendAllowed:false,
    contactPermitted:false,crmWriteAllowed:false,maximumExternalActions:0,productionGate:'blocked',
    separateSignedWorkOrderRequired:true,
    nextRequiredGate:Date.parse(expiresAt)<=NOW.getTime()?'authorization_expired':'separate_signed_work_order',
    provenance:{source:'control-broker',sourceId:`a1-research-authorization:${REVIEW}`,observedAt:NOW.toISOString(),synthetic:false},
  }
}

const authority={issuer:'codex',audience:'hermes-commercial-orchestrator',keys:{'control-key-1':'test-control-key-with-at-least-32-bytes'},ed25519PublicKeys:{'codex-a1-ed25519-v1':'test-public-key-material'}}

describe('A1 exact unsigned work-order candidate',()=>{
  it('builds one deterministic, non-executable candidate bound to the parent authorization',()=>{
    const first=buildA1ExactOrderCandidate(dossier(),authorization(),authority,NOW)
    const second=buildA1ExactOrderCandidate(dossier(),authorization(),authority,new Date(NOW.getTime()+60_000))
    assert.equal(first.missionId,second.missionId)
    assert.equal(first.orderAuthorizationId,second.orderAuthorizationId)
    assert.equal(first.unsignedWorkOrderSha256,hashUnsignedA1ResearchWorkOrder(first.workOrder))
    assert.equal(first.workOrder.authority && (first.workOrder.authority as any).algorithm,'Ed25519')
    assert.equal(first.workOrder.authority && (first.workOrder.authority as any).signature,'0'.repeat(128))
    assert.equal(first.exactOrderAuthorizationRecorded,false)
    assert.equal(first.missionCreated,false)
    assert.equal(first.dispatchQueued,false)
    assert.equal(first.executionAuthorized,false)
    assert.equal(first.internetAccessAllowed,false)
    assert.equal(first.providerCreditSpendAllowed,false)
    assert.equal(first.maximumExternalActions,0)
    assert.equal(first.nextRequiredGate,'exact_order_human_authorization')
    assert.doesNotThrow(()=>assertA1ResearchWorkOrderCandidate(first.workOrder,dossier(),authorization(),NOW))
  })

  it('fails closed for expired, rejected, stale or ambiguously keyed parent state',()=>{
    assert.throws(()=>buildA1ExactOrderCandidate(dossier(),authorization('2026-08-28T20:14:59.000Z'),authority,NOW),/A1_RESEARCH_ORDER_AUTHORIZATION_GATE_CLOSED/)
    const rejected=authorization();rejected.authorization!.decision='rejected';rejected.nextRequiredGate='authorization_rejected'
    assert.throws(()=>buildA1ExactOrderCandidate(dossier(),rejected,authority,NOW),/A1_RESEARCH_ORDER_AUTHORIZATION_GATE_CLOSED/)
    const stale=authorization();stale.authorization!.dossierSha256='f'.repeat(64);stale.dossierCurrent=false;stale.nextRequiredGate='stale_dossier_review'
    assert.throws(()=>buildA1ExactOrderCandidate(dossier(),stale,authority,NOW),/A1_RESEARCH_ORDER_AUTHORIZATION_GATE_CLOSED/)
    assert.throws(()=>buildA1ExactOrderCandidate(dossier(),authorization(),{...authority,ed25519PublicKeys:{one:'x',two:'y'}},NOW),/A1_RESEARCH_ORDER_AUTHORIZATION_GATE_CLOSED/)
  })
})
