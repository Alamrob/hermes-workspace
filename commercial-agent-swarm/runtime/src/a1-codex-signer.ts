import { createHash, createPublicKey } from 'node:crypto'
import { hashAction } from './canonical.js'
import type { A1AuthorizedOrderCandidate } from './a1-authorized-order-candidate.js'
import { hashUnsignedA1ResearchWorkOrder } from './a1-research-order-authorization.js'
import { signWorkOrderEd25519, verifyWorkOrder, type WorkOrderAuthConfig } from './security.js'
import { validateWorkOrder, type WorkOrder } from './work-orders.js'

export interface A1CodexSigningExpectation {
  orderAuthorizationId: string
  reviewId: string
  parentAuthorizationId: string
  missionId: string
  dossierSha256: string
  unsignedWorkOrderSha256: string
  keyId: string
}

export interface A1CodexSignedOrder {
  orderAuthorizationId: string
  missionId: string
  unsignedWorkOrderSha256: string
  signedWorkOrderSha256: string
  workOrder: WorkOrder
  signatureAlgorithm: 'Ed25519'
  persisted: false
  missionCreated: false
  dispatchQueued: false
  nextRequiredGate: 'submit_signed_order_separately'
}

/**
 * Pure offline signing boundary. It cannot persist or submit an order and accepts
 * only the exact authorized projection produced by the broker.
 */
export function signAuthorizedA1Order(
  candidate: A1AuthorizedOrderCandidate,
  expectation: A1CodexSigningExpectation,
  privateKeyPem: string,
  expectedPublicKeyPem: string,
  authority: Pick<WorkOrderAuthConfig, 'issuer' | 'audience'>,
  now: Date,
): A1CodexSignedOrder {
  const workOrder = validateWorkOrder(structuredClone(candidate.workOrder))
  const metadata = asRecord(workOrder.metadata)
  const orderAuthority = asRecord(workOrder.authority)
  if (
    candidate.exactOrderAuthorizationRecorded !== true || candidate.signedWorkOrderPresent !== false ||
    candidate.workOrderPersisted !== false || candidate.missionCreated !== false || candidate.dispatchQueued !== false ||
    candidate.executionAuthorized !== false || candidate.internetAccessAllowed !== false ||
    candidate.providerCreditSpendAllowed !== false || candidate.contactPermitted !== false ||
    candidate.crmWriteAllowed !== false || candidate.maximumExternalActions !== 0 || candidate.productionGate !== 'blocked' ||
    candidate.nextRequiredGate !== 'codex_signature' || Date.parse(candidate.expiresAt) <= now.getTime() ||
    candidate.orderAuthorizationId !== expectation.orderAuthorizationId || candidate.reviewId !== expectation.reviewId ||
    candidate.parentAuthorizationId !== expectation.parentAuthorizationId || candidate.missionId !== expectation.missionId ||
    candidate.dossierSha256 !== expectation.dossierSha256 ||
    candidate.unsignedWorkOrderSha256 !== expectation.unsignedWorkOrderSha256 ||
    workOrder.mission_id !== expectation.missionId || workOrder.requested_by !== 'codex-auditor' ||
    workOrder.autonomy_level !== 'A1' || workOrder.dry_run !== true || workOrder.approval_token !== null ||
    orderAuthority.issuer !== authority.issuer || orderAuthority.audience !== authority.audience ||
    orderAuthority.key_id !== expectation.keyId || orderAuthority.algorithm !== 'Ed25519' ||
    orderAuthority.signature !== '0'.repeat(128) ||
    metadata.a1_research_review_id !== expectation.reviewId ||
    metadata.a1_research_dossier_sha256 !== expectation.dossierSha256 ||
    metadata.a1_research_authorization_id !== expectation.parentAuthorizationId ||
    metadata.a1_research_order_authorization_id !== expectation.orderAuthorizationId ||
    metadata.a1_research_order_unsigned_sha256 !== expectation.unsignedWorkOrderSha256 ||
    hashUnsignedA1ResearchWorkOrder(workOrder) !== expectation.unsignedWorkOrderSha256
  ) closed()

  assertKeyPair(privateKeyPem, expectedPublicKeyPem)
  orderAuthority.signature = signWorkOrderEd25519(workOrder, privateKeyPem)
  const signed = validateWorkOrder(workOrder)
  verifyWorkOrder(signed, {
    issuer: authority.issuer,
    audience: authority.audience,
    keys: {},
    ed25519PublicKeys: { [expectation.keyId]: expectedPublicKeyPem },
  }, now)
  return {
    orderAuthorizationId: expectation.orderAuthorizationId,
    missionId: expectation.missionId,
    unsignedWorkOrderSha256: expectation.unsignedWorkOrderSha256,
    signedWorkOrderSha256: hashAction(signed),
    workOrder: signed,
    signatureAlgorithm: 'Ed25519',
    persisted: false,
    missionCreated: false,
    dispatchQueued: false,
    nextRequiredGate: 'submit_signed_order_separately',
  }
}

function assertKeyPair(privateKeyPem: string, expectedPublicKeyPem: string): void {
  try {
    const derived = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' })
    const expected = createPublicKey(expectedPublicKeyPem).export({ type: 'spki', format: 'der' })
    if (createHash('sha256').update(derived).digest('hex') !== createHash('sha256').update(expected).digest('hex'))
      closed()
  } catch (error) {
    if (error instanceof A1CodexSigningError) throw error
    closed()
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) closed()
  return value as Record<string, unknown>
}

export class A1CodexSigningError extends Error {
  constructor() { super('A1_CODEX_SIGNING_GATE_CLOSED'); this.name = 'A1CodexSigningError' }
}

function closed(): never { throw new A1CodexSigningError() }
