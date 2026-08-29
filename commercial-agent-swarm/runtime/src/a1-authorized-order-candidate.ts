import { buildA1ExactOrderCandidate } from './a1-exact-order-candidate.js'
import {
  A1ResearchOrderAuthorizationError,
  hashUnsignedA1ResearchWorkOrder,
  validateA1ResearchOrderAuthorizationState,
  type A1ResearchOrderAuthorizationState,
} from './a1-research-order-authorization.js'
import type { A1ResearchAuthorizationState } from './a1-research-authorization.js'
import type { A1ResearchDossier } from './a1-research-dossier.js'
import { validateWorkOrder, type WorkOrder } from './work-orders.js'
import type { WorkOrderAuthConfig } from './security.js'

export interface A1AuthorizedOrderCandidate {
  orderAuthorizationId: string
  reviewId: string
  parentAuthorizationId: string
  missionId: string
  traceId: string
  dossierSha256: string
  unsignedWorkOrderSha256: string
  expiresAt: string
  workOrder: WorkOrder
  exactOrderAuthorizationRecorded: true
  signedWorkOrderPresent: false
  workOrderPersisted: false
  missionCreated: false
  dispatchQueued: false
  executionAuthorized: false
  internetAccessAllowed: false
  providerCreditSpendAllowed: false
  contactPermitted: false
  crmWriteAllowed: false
  maximumExternalActions: 0
  productionGate: 'blocked'
  nextRequiredGate: 'codex_signature'
  provenance: {
    source: 'control-broker'
    sourceId: string
    observedAt: string
    synthetic: false
  }
}

export function buildA1AuthorizedOrderCandidate(
  dossier: A1ResearchDossier,
  parentAuthorization: A1ResearchAuthorizationState,
  orderAuthorizationValue: A1ResearchOrderAuthorizationState,
  authority: WorkOrderAuthConfig,
  now: Date,
): A1AuthorizedOrderCandidate {
  const orderAuthorization = validateA1ResearchOrderAuthorizationState(orderAuthorizationValue)
  const candidate = buildA1ExactOrderCandidate(dossier, parentAuthorization, authority, now)
  if (
    orderAuthorization.decision !== 'approved' ||
    Date.parse(orderAuthorization.expiresAt) <= now.getTime() ||
    orderAuthorization.orderAuthorizationId !== candidate.orderAuthorizationId ||
    orderAuthorization.reviewId !== candidate.reviewId ||
    orderAuthorization.parentAuthorizationId !== candidate.parentAuthorizationId ||
    orderAuthorization.missionId !== candidate.missionId ||
    orderAuthorization.dossierSha256 !== candidate.dossierSha256 ||
    orderAuthorization.unsignedWorkOrderSha256 !== candidate.unsignedWorkOrderSha256 ||
    orderAuthorization.expiresAt !== candidate.parentAuthorizationExpiresAt ||
    orderAuthorization.reviewerEmail !== 'proptimizaspa@gmail.com' ||
    orderAuthorization.attestations.exactWorkOrderConfirmed !== true ||
    orderAuthorization.attestations.noContact !== true ||
    orderAuthorization.attestations.noCrmWrite !== true ||
    orderAuthorization.attestations.noExternalActions !== true ||
    orderAuthorization.attestations.noProviderCreditSpend !== true
  ) closed()

  const workOrder = validateWorkOrder(structuredClone(candidate.workOrder))
  const metadata = workOrder.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) closed()
  metadata.a1_research_order_authorization_expires_at = orderAuthorization.expiresAt
  metadata.a1_research_order_authorization_sha256 = orderAuthorization.userAuthorizationSha256
  metadata.a1_research_order_authorized_at = orderAuthorization.reviewedAt
  metadata.a1_research_order_authorized_by = orderAuthorization.reviewerEmail
  if (
    hashUnsignedA1ResearchWorkOrder(workOrder) !== orderAuthorization.unsignedWorkOrderSha256 ||
    (workOrder.authority as Record<string, unknown>).signature !== '0'.repeat(64)
  ) closed()

  return {
    orderAuthorizationId: orderAuthorization.orderAuthorizationId,
    reviewId: orderAuthorization.reviewId,
    parentAuthorizationId: orderAuthorization.parentAuthorizationId,
    missionId: candidate.missionId,
    traceId: candidate.traceId,
    dossierSha256: candidate.dossierSha256,
    unsignedWorkOrderSha256: candidate.unsignedWorkOrderSha256,
    expiresAt: orderAuthorization.expiresAt,
    workOrder,
    exactOrderAuthorizationRecorded: true,
    signedWorkOrderPresent: false,
    workOrderPersisted: false,
    missionCreated: false,
    dispatchQueued: false,
    executionAuthorized: false,
    internetAccessAllowed: false,
    providerCreditSpendAllowed: false,
    contactPermitted: false,
    crmWriteAllowed: false,
    maximumExternalActions: 0,
    productionGate: 'blocked',
    nextRequiredGate: 'codex_signature',
    provenance: {
      source: 'control-broker',
      sourceId: `a1-authorized-order-candidate:${orderAuthorization.orderAuthorizationId}`,
      observedAt: now.toISOString(),
      synthetic: false,
    },
  }
}

function closed(): never {
  throw new A1ResearchOrderAuthorizationError('A1_AUTHORIZED_ORDER_CANDIDATE_GATE_CLOSED')
}
