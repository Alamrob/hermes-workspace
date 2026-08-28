import { hashAction } from './canonical.js'
import type { A1ResearchDossier } from './a1-research-dossier.js'

export type A1ResearchAuthorizationDecision = 'approved' | 'rejected'

export interface A1ResearchAuthorizationAttestations {
  noContact: true
  noCrmWrite: true
  noExternalActions: true
  noProviderCreditSpend: true
  separateSignedWorkOrderRequired: true
}

export interface RecordA1ResearchAuthorizationInput {
  authorizationId: string
  reviewId: string
  decision: A1ResearchAuthorizationDecision
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  expiresAt: string
  expectedDossierSha256: string
  attestations: A1ResearchAuthorizationAttestations
  idempotencyKey: string
  requestSha256: string
}

export interface A1ResearchAuthorizationState {
  reviewId: string
  projectId: 'proptimiza'
  offerId: 'operacion-sin-planillas'
  offerVersion: 'v1'
  dossierSha256: string
  dossierStatus: 'review_incomplete' | 'no_eligible_accounts' | 'authorization_required'
  eligibleAccountCount: number
  authorizationRecorded: boolean
  dossierCurrent: boolean
  authorization: null | {
    authorizationId: string
    decision: A1ResearchAuthorizationDecision
    rationale: string
    reviewerId: string
    reviewerEmail: 'proptimizaspa@gmail.com'
    reviewedAt: string
    expiresAt: string
    dossierSha256: string
    attestations: A1ResearchAuthorizationAttestations
  }
  executionAuthorized: false
  missionCreated: false
  internetAccessAllowed: false
  providerCreditSpendAllowed: false
  contactPermitted: false
  crmWriteAllowed: false
  maximumExternalActions: 0
  productionGate: 'blocked'
  separateSignedWorkOrderRequired: true
  nextRequiredGate: 'complete_draft_review' | 'no_eligible_accounts' | 'human_authorization' | 'stale_dossier_review' | 'authorization_rejected' | 'separate_signed_work_order'
  provenance: {
    source: 'control-broker'
    sourceId: string
    observedAt: string
    synthetic: false
  }
}

export class A1ResearchAuthorizationError extends Error {
  constructor(readonly code: string) { super(code) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const ACTOR = /^[A-Za-z0-9._:@+-]{3,254}$/
const IDEMPOTENCY = /^a1-research-auth:[A-Za-z0-9._:-]{8,110}$/
const FORBIDDEN_TEXT = /(https?:\/\/|www\.|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{20,})/i

export function hashA1ResearchDossier(dossier: A1ResearchDossier): string {
  return hashAction({
    reviewId: dossier.reviewId,
    projectId: dossier.projectId,
    offerId: dossier.offerId,
    offerVersion: dossier.offerVersion,
    status: dossier.status,
    reviewCompleted: dossier.reviewCompleted,
    eligibleAccountCount: dossier.eligibleAccountCount,
    accounts: dossier.accounts,
    autonomyLevel: dossier.autonomyLevel,
    allowedActions: dossier.allowedActions,
    prohibitedActions: dossier.prohibitedActions,
    approvedChannels: dossier.approvedChannels,
    requestedTools: dossier.requestedTools,
    allowedDataCategories: dossier.allowedDataCategories,
    maximumAccounts: dossier.maximumAccounts,
    maximumContacts: dossier.maximumContacts,
    maximumExternalActions: dossier.maximumExternalActions,
    maximumBudgetUsd: dossier.maximumBudgetUsd,
    providerCreditSpendAllowed: dossier.providerCreditSpendAllowed,
    internetAccessAllowed: dossier.internetAccessAllowed,
    contactPermitted: dossier.contactPermitted,
    crmWriteAllowed: dossier.crmWriteAllowed,
    authorizationRequired: dossier.authorizationRequired,
    missionCreated: dossier.missionCreated,
    productionGate: dossier.productionGate,
    externalActions: dossier.externalActions,
  })
}

export function validateA1ResearchAuthorizationRequest(
  value: unknown,
  now: Date,
): Omit<RecordA1ResearchAuthorizationInput, 'authorizationId' | 'reviewId' | 'requestSha256'> {
  try {
    const input = object(value)
    exactKeys(input, ['decision','rationale','reviewer_id','reviewer_email','reviewed_at','expires_at','expected_dossier_sha256','attestations','idempotency_key'])
    const decision = text(input.decision)
    const rationale = text(input.rationale).trim()
    const reviewerId = text(input.reviewer_id)
    const reviewerEmail = text(input.reviewer_email)
    const reviewedAt = text(input.reviewed_at)
    const expiresAt = text(input.expires_at)
    const expectedDossierSha256 = text(input.expected_dossier_sha256)
    const idempotencyKey = text(input.idempotency_key)
    if (!['approved','rejected'].includes(decision) || rationale.length < 20 || rationale.length > 1000 ||
        /[\u0000-\u001f\u007f]/.test(rationale) || FORBIDDEN_TEXT.test(rationale) || !ACTOR.test(reviewerId) ||
        reviewerEmail !== 'proptimizaspa@gmail.com' || !validDate(reviewedAt) || !validDate(expiresAt) ||
        !SHA256.test(expectedDossierSha256) || !IDEMPOTENCY.test(idempotencyKey)) throw new Error('fields')
    const reviewedMs = Date.parse(reviewedAt), expiresMs = Date.parse(expiresAt), nowMs = now.getTime()
    if (Math.abs(reviewedMs - nowMs) > 5 * 60_000 || expiresMs <= reviewedMs || expiresMs > reviewedMs + 30 * 60_000) throw new Error('time')
    const attestations = validateAttestations(input.attestations)
    return {
      decision: decision as A1ResearchAuthorizationDecision,
      rationale,
      reviewerId,
      reviewerEmail: 'proptimizaspa@gmail.com',
      reviewedAt: new Date(reviewedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      expectedDossierSha256,
      attestations,
      idempotencyKey,
    }
  } catch {
    throw new A1ResearchAuthorizationError('A1_RESEARCH_AUTHORIZATION_INVALID')
  }
}

export function validateA1ResearchAuthorizationState(value: unknown): A1ResearchAuthorizationState {
  try {
    const state = object(value)
    exactKeys(state, [
      'reviewId','projectId','offerId','offerVersion','dossierSha256','dossierStatus','eligibleAccountCount',
      'authorizationRecorded','dossierCurrent','authorization','executionAuthorized','missionCreated',
      'internetAccessAllowed','providerCreditSpendAllowed','contactPermitted','crmWriteAllowed',
      'maximumExternalActions','productionGate','separateSignedWorkOrderRequired','nextRequiredGate','provenance',
    ])
    if (!UUID.test(text(state.reviewId)) || state.projectId !== 'proptimiza' || state.offerId !== 'operacion-sin-planillas' ||
        state.offerVersion !== 'v1' || !SHA256.test(text(state.dossierSha256)) ||
        !['review_incomplete','no_eligible_accounts','authorization_required'].includes(text(state.dossierStatus)) ||
        !integer(state.eligibleAccountCount, 0, 3) || typeof state.authorizationRecorded !== 'boolean' ||
        typeof state.dossierCurrent !== 'boolean' || state.executionAuthorized !== false || state.missionCreated !== false ||
        state.internetAccessAllowed !== false || state.providerCreditSpendAllowed !== false || state.contactPermitted !== false ||
        state.crmWriteAllowed !== false || state.maximumExternalActions !== 0 || state.productionGate !== 'blocked' ||
        state.separateSignedWorkOrderRequired !== true ||
        !['complete_draft_review','no_eligible_accounts','human_authorization','stale_dossier_review','authorization_rejected','separate_signed_work_order'].includes(text(state.nextRequiredGate))) throw new Error('state')
    if (state.authorization === null) {
      if (state.authorizationRecorded !== false || state.dossierCurrent !== true) throw new Error('empty auth')
    } else {
      const auth = object(state.authorization)
      exactKeys(auth, ['authorizationId','decision','rationale','reviewerId','reviewerEmail','reviewedAt','expiresAt','dossierSha256','attestations'])
      if (!UUID.test(text(auth.authorizationId)) || !['approved','rejected'].includes(text(auth.decision)) ||
          text(auth.rationale).length < 20 || !ACTOR.test(text(auth.reviewerId)) || auth.reviewerEmail !== 'proptimizaspa@gmail.com' ||
          !validDate(auth.reviewedAt) || !validDate(auth.expiresAt) || !SHA256.test(text(auth.dossierSha256))) throw new Error('auth')
      validateStateAttestations(auth.attestations)
      if (state.authorizationRecorded !== true || state.dossierCurrent !== (auth.dossierSha256 === state.dossierSha256)) throw new Error('auth state')
    }
    const expectedGate = state.dossierStatus === 'review_incomplete' ? 'complete_draft_review' :
      state.dossierStatus === 'no_eligible_accounts' ? 'no_eligible_accounts' :
      state.authorization === null ? 'human_authorization' :
      state.dossierCurrent === false ? 'stale_dossier_review' :
      (state.authorization as Record<string, unknown>).decision === 'rejected' ? 'authorization_rejected' : 'separate_signed_work_order'
    if (state.nextRequiredGate !== expectedGate) throw new Error('gate')
    const provenance = object(state.provenance)
    exactKeys(provenance, ['source','sourceId','observedAt','synthetic'])
    if (provenance.source !== 'control-broker' || provenance.sourceId !== `a1-research-authorization:${state.reviewId}` || !validDate(provenance.observedAt) || provenance.synthetic !== false) throw new Error('provenance')
    return value as A1ResearchAuthorizationState
  } catch (error) {
    if (error instanceof A1ResearchAuthorizationError) throw error
    throw new A1ResearchAuthorizationError('A1_RESEARCH_AUTHORIZATION_STATE_INVALID')
  }
}

function validateAttestations(value: unknown): A1ResearchAuthorizationAttestations {
  const attestations = object(value)
  exactKeys(attestations, ['no_contact','no_crm_write','no_external_actions','no_provider_credit_spend','separate_signed_work_order_required'])
  if (Object.values(attestations).some((item) => item !== true)) throw new Error('attestations')
  return {
    noContact: true,
    noCrmWrite: true,
    noExternalActions: true,
    noProviderCreditSpend: true,
    separateSignedWorkOrderRequired: true,
  }
}

function validateStateAttestations(value: unknown): A1ResearchAuthorizationAttestations {
  const attestations = object(value)
  exactKeys(attestations, ['noContact','noCrmWrite','noExternalActions','noProviderCreditSpend','separateSignedWorkOrderRequired'])
  if (Object.values(attestations).some((item) => item !== true)) throw new Error('attestations')
  return attestations as unknown as A1ResearchAuthorizationAttestations
}

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object'); return value as Record<string, unknown> }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function integer(value: unknown, min: number, max: number): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max }
function validDate(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { const actual=Object.keys(value).sort(), wanted=[...expected].sort(); if (actual.length !== wanted.length || actual.some((key,index)=>key!==wanted[index])) throw new Error('keys') }
