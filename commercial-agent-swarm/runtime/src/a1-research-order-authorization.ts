import { hashAction } from './canonical.js'
import type { WorkOrder } from './work-orders.js'

export interface A1ResearchOrderAuthorizationAttestations {
  exactWorkOrderConfirmed: true
  noContact: true
  noCrmWrite: true
  noExternalActions: true
  noProviderCreditSpend: true
}

export interface RecordA1ResearchOrderAuthorizationInput {
  orderAuthorizationId: string
  reviewId: string
  parentAuthorizationId: string
  decision: 'approved' | 'rejected'
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  expiresAt: string
  expectedDossierSha256: string
  unsignedWorkOrderSha256: string
  missionId: string
  userAuthorizationSha256: string
  attestations: A1ResearchOrderAuthorizationAttestations
  idempotencyKey: string
  requestSha256: string
}

export interface A1ResearchOrderAuthorizationState
  extends Omit<RecordA1ResearchOrderAuthorizationInput, 'expectedDossierSha256' | 'requestSha256'> {
  dossierSha256: string
  executionAuthorized: false
  missionCreated: false
  dispatchQueued: false
  internetAccessAllowed: false
  providerCreditSpendAllowed: false
  contactPermitted: false
  crmWriteAllowed: false
  maximumExternalActions: 0
  productionGate: 'blocked'
  nextRequiredGate: 'sign_exact_work_order'
  provenance: {
    source: 'control-broker'
    sourceId: string
    observedAt: string
    synthetic: false
  }
}

export interface A1ResearchOrderAuthorizationRequest {
  decision: 'approved' | 'rejected'
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  expiresAt: string
  expectedDossierSha256: string
  expectedParentAuthorizationId: string
  userAuthorizationSha256: string
  attestations: A1ResearchOrderAuthorizationAttestations
  idempotencyKey: string
  workOrder: unknown
}

export class A1ResearchOrderAuthorizationError extends Error {
  constructor(readonly code: string) { super(code) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const ACTOR = /^[A-Za-z0-9._:@+-]{3,254}$/
const IDEMPOTENCY = /^a1-order-auth:[A-Za-z0-9._:-]{8,112}$/
const FORBIDDEN_TEXT = /(https?:\/\/|www\.|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{20,})/i

export function hashUnsignedA1ResearchWorkOrder(workOrder: WorkOrder): string {
  const unsigned = structuredClone(workOrder)
  const authority = object(unsigned.authority)
  authority.signature = '0'.repeat(64)
  const metadata = object(unsigned.metadata)
  for (const field of [
    'a1_research_order_authorization_id',
    'a1_research_order_authorization_expires_at',
    'a1_research_order_unsigned_sha256',
    'a1_research_order_authorization_sha256',
    'a1_research_order_authorized_at',
    'a1_research_order_authorized_by',
  ]) delete metadata[field]
  return hashAction(unsigned)
}

export function validateA1ResearchOrderAuthorizationRequest(
  value: unknown,
  now: Date,
): A1ResearchOrderAuthorizationRequest {
  try {
    const input = object(value)
    exactKeys(input, [
      'decision','rationale','reviewer_id','reviewer_email','reviewed_at','expires_at',
      'expected_dossier_sha256','expected_parent_authorization_id','user_authorization_sha256',
      'attestations','idempotency_key','work_order',
    ])
    const decision = text(input.decision)
    const rationale = text(input.rationale).trim()
    const reviewerId = text(input.reviewer_id)
    const reviewerEmail = text(input.reviewer_email)
    const reviewedAt = text(input.reviewed_at)
    const expiresAt = text(input.expires_at)
    const expectedDossierSha256 = text(input.expected_dossier_sha256)
    const expectedParentAuthorizationId = text(input.expected_parent_authorization_id)
    const userAuthorizationSha256 = text(input.user_authorization_sha256)
    const idempotencyKey = text(input.idempotency_key)
    if (!['approved','rejected'].includes(decision) || rationale.length < 20 || rationale.length > 1000 ||
        /[\u0000-\u001f\u007f]/.test(rationale) || FORBIDDEN_TEXT.test(rationale) || !ACTOR.test(reviewerId) ||
        reviewerEmail !== 'proptimizaspa@gmail.com' || !validDate(reviewedAt) || !validDate(expiresAt) ||
        !SHA256.test(expectedDossierSha256) || !UUID.test(expectedParentAuthorizationId) ||
        !SHA256.test(userAuthorizationSha256) || !IDEMPOTENCY.test(idempotencyKey) || !object(input.work_order)) throw new Error('fields')
    const reviewedMs = Date.parse(reviewedAt), expiresMs = Date.parse(expiresAt), nowMs = now.getTime()
    if (Math.abs(reviewedMs-nowMs)>5*60_000 || expiresMs<=reviewedMs || expiresMs>reviewedMs+30*60_000) throw new Error('time')
    return {
      decision: decision as 'approved' | 'rejected', rationale, reviewerId,
      reviewerEmail: 'proptimizaspa@gmail.com', reviewedAt: new Date(reviewedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(), expectedDossierSha256,
      expectedParentAuthorizationId, userAuthorizationSha256,
      attestations: validateRequestAttestations(input.attestations), idempotencyKey,
      workOrder: structuredClone(input.work_order),
    }
  } catch {
    throw new A1ResearchOrderAuthorizationError('A1_RESEARCH_ORDER_AUTHORIZATION_INVALID')
  }
}

export function validateA1ResearchOrderAuthorizationState(value: unknown): A1ResearchOrderAuthorizationState {
  try {
    const state = object(value)
    exactKeys(state, [
      'orderAuthorizationId','reviewId','parentAuthorizationId','decision','rationale','reviewerId','reviewerEmail',
      'reviewedAt','expiresAt','dossierSha256','unsignedWorkOrderSha256','missionId','userAuthorizationSha256',
      'attestations','idempotencyKey','executionAuthorized','missionCreated','dispatchQueued','internetAccessAllowed',
      'providerCreditSpendAllowed','contactPermitted','crmWriteAllowed','maximumExternalActions','productionGate',
      'nextRequiredGate','provenance',
    ])
    if (!UUID.test(text(state.orderAuthorizationId)) || !UUID.test(text(state.reviewId)) ||
        !UUID.test(text(state.parentAuthorizationId)) || !['approved','rejected'].includes(text(state.decision)) ||
        text(state.rationale).length<20 || !ACTOR.test(text(state.reviewerId)) ||
        state.reviewerEmail!=='proptimizaspa@gmail.com' || !validDate(state.reviewedAt) || !validDate(state.expiresAt) ||
        !SHA256.test(text(state.dossierSha256)) || !SHA256.test(text(state.unsignedWorkOrderSha256)) ||
        !UUID.test(text(state.missionId)) || !SHA256.test(text(state.userAuthorizationSha256)) ||
        !IDEMPOTENCY.test(text(state.idempotencyKey)) || state.executionAuthorized!==false || state.missionCreated!==false ||
        state.dispatchQueued!==false || state.internetAccessAllowed!==false || state.providerCreditSpendAllowed!==false ||
        state.contactPermitted!==false || state.crmWriteAllowed!==false || state.maximumExternalActions!==0 ||
        state.productionGate!=='blocked' || state.nextRequiredGate!=='sign_exact_work_order') throw new Error('state')
    validateStateAttestations(state.attestations)
    const provenance = object(state.provenance)
    exactKeys(provenance, ['source','sourceId','observedAt','synthetic'])
    if (provenance.source!=='control-broker' || provenance.sourceId!==`a1-research-order-authorization:${state.orderAuthorizationId}` ||
        !validDate(provenance.observedAt) || provenance.synthetic!==false) throw new Error('provenance')
    return value as A1ResearchOrderAuthorizationState
  } catch (error) {
    if (error instanceof A1ResearchOrderAuthorizationError) throw error
    throw new A1ResearchOrderAuthorizationError('A1_RESEARCH_ORDER_AUTHORIZATION_STATE_INVALID')
  }
}

function validateRequestAttestations(value: unknown): A1ResearchOrderAuthorizationAttestations {
  const input = object(value)
  exactKeys(input, ['exact_work_order_confirmed','no_contact','no_crm_write','no_external_actions','no_provider_credit_spend'])
  if (Object.values(input).some((entry)=>entry!==true)) throw new Error('attestations')
  return { exactWorkOrderConfirmed:true,noContact:true,noCrmWrite:true,noExternalActions:true,noProviderCreditSpend:true }
}

function validateStateAttestations(value: unknown): A1ResearchOrderAuthorizationAttestations {
  const input = object(value)
  exactKeys(input, ['exactWorkOrderConfirmed','noContact','noCrmWrite','noExternalActions','noProviderCreditSpend'])
  if (Object.values(input).some((entry)=>entry!==true)) throw new Error('attestations')
  return input as unknown as A1ResearchOrderAuthorizationAttestations
}

function object(value: unknown): Record<string, unknown> { if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('object'); return value as Record<string,unknown> }
function text(value: unknown): string { return typeof value==='string'?value:'' }
function validDate(value: unknown): boolean { return typeof value==='string'&&Number.isFinite(Date.parse(value)) }
function exactKeys(value: Record<string,unknown>, expected: readonly string[]): void { const actual=Object.keys(value).sort(),wanted=[...expected].sort();if(actual.length!==wanted.length||actual.some((key,index)=>key!==wanted[index]))throw new Error('keys') }
