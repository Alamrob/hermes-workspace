import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'
import {
  hashUnsignedA1ResearchWorkOrder,
  validateA1ResearchOrderAuthorizationRequest,
  validateA1ResearchOrderAuthorizationState,
} from '../src/a1-research-order-authorization.js'
import type { WorkOrder } from '../src/work-orders.js'
import { validWorkOrder } from './fixtures.js'

const NOW = new Date('2026-08-28T20:00:00.000Z')
const ORDER_AUTH = '72500000-0000-4500-8500-000000000053'

function candidate(): WorkOrder {
  const value:any=validWorkOrder()
  value.authority.signature='0'.repeat(64)
  value.metadata={
    a1_research_order_authorization_id:ORDER_AUTH,
    a1_research_order_authorization_expires_at:'2026-08-28T20:20:00.000Z',
    a1_research_order_authorization_sha256:'d'.repeat(64),
    a1_research_order_authorized_at:NOW.toISOString(),
    a1_research_order_authorized_by:'proptimizaspa@gmail.com',
  }
  value.metadata.a1_research_order_unsigned_sha256=hashUnsignedA1ResearchWorkOrder(value)
  return value as WorkOrder
}

function request() {
  return {
    decision:'approved',rationale:'Autoriza solamente la orden A1 exacta y ninguna acción adicional.',
    reviewer_id:'director',reviewer_email:'proptimizaspa@gmail.com',reviewed_at:NOW.toISOString(),
    expires_at:'2026-08-28T20:20:00.000Z',expected_dossier_sha256:'a'.repeat(64),
    expected_parent_authorization_id:'62500000-0000-4500-8500-000000000053',
    user_authorization_sha256:'d'.repeat(64),
    attestations:{exact_work_order_confirmed:true,no_contact:true,no_crm_write:true,no_external_actions:true,no_provider_credit_spend:true},
    idempotency_key:'a1-order-auth:review-00000053',work_order:candidate(),
  }
}

function state() {
  return {
    orderAuthorizationId:ORDER_AUTH,reviewId:'a2500000-0000-4500-8500-000000000053',
    parentAuthorizationId:'62500000-0000-4500-8500-000000000053',decision:'approved',
    rationale:'Autoriza solamente la orden A1 exacta y ninguna acción adicional.',reviewerId:'director',
    reviewerEmail:'proptimizaspa@gmail.com',reviewedAt:NOW.toISOString(),expiresAt:'2026-08-28T20:20:00.000Z',
    dossierSha256:'a'.repeat(64),unsignedWorkOrderSha256:hashUnsignedA1ResearchWorkOrder(candidate()),
    missionId:candidate().mission_id,userAuthorizationSha256:'d'.repeat(64),
    attestations:{exactWorkOrderConfirmed:true,noContact:true,noCrmWrite:true,noExternalActions:true,noProviderCreditSpend:true},
    idempotencyKey:'a1-order-auth:review-00000053',executionAuthorized:false,missionCreated:false,dispatchQueued:false,
    internetAccessAllowed:false,providerCreditSpendAllowed:false,contactPermitted:false,crmWriteAllowed:false,
    maximumExternalActions:0,productionGate:'blocked',nextRequiredGate:'sign_exact_work_order',
    provenance:{source:'control-broker',sourceId:`a1-research-order-authorization:${ORDER_AUTH}`,observedAt:NOW.toISOString(),synthetic:false},
  }
}

describe('A1 exact-order authorization',()=>{
  it('hashes commercial order content while excluding only the authorization envelope and signature',()=>{
    const left=candidate(),right=structuredClone(left)
    ;(right.authority as Record<string,unknown>).signature='f'.repeat(64)
    right.metadata!.a1_research_order_authorized_at='2026-08-28T20:01:00.000Z'
    ;(right as unknown as Record<string, unknown>).a3_enabled=false
    assert.equal(hashUnsignedA1ResearchWorkOrder(left),hashUnsignedA1ResearchWorkOrder(right))
    right.objective='Changed objective'
    assert.notEqual(hashUnsignedA1ResearchWorkOrder(left),hashUnsignedA1ResearchWorkOrder(right))
  })

  it('validates one short-lived exact-order authorization request',()=>{
    const value=validateA1ResearchOrderAuthorizationRequest(request(),NOW)
    assert.equal(value.reviewerEmail,'proptimizaspa@gmail.com')
    assert.equal(value.attestations.exactWorkOrderConfirmed,true)
  })

  it('rejects recovery identity, false attestations, stale time and secret-bearing rationale',()=>{
    assert.throws(()=>validateA1ResearchOrderAuthorizationRequest({...request(),reviewer_email:'lamrobcompany@gmail.com'},NOW),/A1_RESEARCH_ORDER_AUTHORIZATION_INVALID/)
    assert.throws(()=>validateA1ResearchOrderAuthorizationRequest({...request(),attestations:{...request().attestations,no_contact:false}},NOW),/A1_RESEARCH_ORDER_AUTHORIZATION_INVALID/)
    assert.throws(()=>validateA1ResearchOrderAuthorizationRequest({...request(),reviewed_at:'2026-08-28T19:54:59.000Z'},NOW),/A1_RESEARCH_ORDER_AUTHORIZATION_INVALID/)
    assert.throws(()=>validateA1ResearchOrderAuthorizationRequest({...request(),rationale:`Bearer ${'a'.repeat(32)}`},NOW),/A1_RESEARCH_ORDER_AUTHORIZATION_INVALID/)
  })

  it('validates the closed, non-executable state projection',()=>{
    assert.equal(validateA1ResearchOrderAuthorizationState(state()).nextRequiredGate,'sign_exact_work_order')
    assert.throws(()=>validateA1ResearchOrderAuthorizationState({...state(),missionCreated:true}),/A1_RESEARCH_ORDER_AUTHORIZATION_STATE_INVALID/)
  })

  it('ships an immutable migration with empty-ledger rollback and no execution primitive',async()=>{
    const sql=await readFile(new URL('../migrations/027_a1_research_order_authorization.sql',import.meta.url),'utf8')
    assert.match(sql,/CREATE TABLE control\.a1_research_order_authorizations/)
    assert.match(sql,/A1_RESEARCH_ORDER_AUTHORIZATION_IMMUTABLE_CONFLICT/)
    assert.match(sql,/'missionCreated',false/)
    assert.match(sql,/'dispatchQueued',false/)
    assert.doesNotMatch(sql,/control\.save_mission|control\.enqueue_dispatch|control\.request_approval|mail\.send/i)
    const rollback=await readFile(new URL('../migrations/027_a1_research_order_authorization.rollback.sql',import.meta.url),'utf8')
    assert.match(rollback,/A1_RESEARCH_ORDER_AUTHORIZATION_HISTORY_PRESENT/)
    assert.match(rollback,/DELETE FROM control\.schema_migrations WHERE version='027_a1_research_order_authorization'/)
  })
})
