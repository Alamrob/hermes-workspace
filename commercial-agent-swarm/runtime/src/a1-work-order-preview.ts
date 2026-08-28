import { hashAction } from './canonical.js'
import { validateA1ResearchDossier, type A1ResearchDossier } from './a1-research-dossier.js'
import {
  hashA1ResearchDossier,
  validateA1ResearchAuthorizationState,
  type A1ResearchAuthorizationState,
} from './a1-research-authorization.js'

export type A1WorkOrderPreviewGate =
  | 'complete_draft_review'
  | 'no_eligible_accounts'
  | 'human_authorization'
  | 'stale_dossier_review'
  | 'authorization_rejected'
  | 'authorization_expired'
  | 'separate_signed_work_order'

export interface A1WorkOrderPreview {
  reviewId: string
  projectId: 'proptimiza'
  offerId: 'operacion-sin-planillas'
  offerVersion: 'v1'
  dossierSha256: string
  authorizationId: string | null
  authorizationExpiresAt: string | null
  previewSha256: string
  objective: 'Verificar información corporativa pública de las cuentas aceptadas sin identificar ni contactar personas.'
  autonomyLevel: 'A1'
  allowedActions: ['analysis.internal', 'research.public.read']
  prohibitedActions: string[]
  approvedChannels: ['internal', 'public_web']
  approvedTools: ['hermes.analysis', 'hermes.web']
  maximumAccounts: number
  maximumContacts: 0
  maximumExternalActions: 0
  maximumBudgetUsd: 0.5
  providerCreditSpendAllowed: false
  internetAccessAllowed: false
  contactPermitted: false
  crmWriteAllowed: false
  signedWorkOrderPresent: false
  workOrderPersisted: false
  missionCreated: false
  dispatchQueued: false
  executionAuthorized: false
  productionGate: 'blocked'
  nextRequiredGate: A1WorkOrderPreviewGate
  provenance: {
    source: 'control-broker'
    sourceId: string
    observedAt: string
    synthetic: false
  }
}

export function buildA1WorkOrderPreview(
  dossierValue: A1ResearchDossier,
  authorizationValue: A1ResearchAuthorizationState | null,
  now: Date,
): A1WorkOrderPreview {
  const dossier = validateA1ResearchDossier(dossierValue)
  const dossierSha256 = hashA1ResearchDossier(dossier)
  const authorization = authorizationValue === null ? null : validateA1ResearchAuthorizationState(authorizationValue)
  const authorizationMatches = authorization !== null &&
    authorization.reviewId === dossier.reviewId &&
    authorization.dossierSha256 === dossierSha256 &&
    authorization.dossierCurrent

  let nextRequiredGate: A1WorkOrderPreviewGate
  if (dossier.status === 'review_incomplete') nextRequiredGate = 'complete_draft_review'
  else if (dossier.status === 'no_eligible_accounts') nextRequiredGate = 'no_eligible_accounts'
  else if (!authorization) nextRequiredGate = 'human_authorization'
  else if (!authorizationMatches) nextRequiredGate = 'stale_dossier_review'
  else if (authorization.authorization?.decision === 'rejected') nextRequiredGate = 'authorization_rejected'
  else if (!authorization.authorization || Date.parse(authorization.authorization.expiresAt) <= now.getTime()) nextRequiredGate = 'authorization_expired'
  else nextRequiredGate = 'separate_signed_work_order'

  const authorizationId = authorizationMatches ? authorization?.authorization?.authorizationId ?? null : null
  const authorizationExpiresAt = authorizationMatches ? authorization?.authorization?.expiresAt ?? null : null
  const digestMaterial = {
    reviewId: dossier.reviewId,
    projectId: dossier.projectId,
    offerId: dossier.offerId,
    offerVersion: dossier.offerVersion,
    dossierSha256,
    authorizationId,
    authorizationExpiresAt,
    objective: 'Verificar información corporativa pública de las cuentas aceptadas sin identificar ni contactar personas.',
    autonomyLevel: dossier.autonomyLevel,
    allowedActions: dossier.allowedActions,
    prohibitedActions: dossier.prohibitedActions,
    approvedChannels: dossier.approvedChannels,
    approvedTools: dossier.requestedTools,
    maximumAccounts: dossier.maximumAccounts,
    maximumContacts: 0,
    maximumExternalActions: 0,
    maximumBudgetUsd: 0.5,
    providerCreditSpendAllowed: false,
    internetAccessAllowed: false,
    contactPermitted: false,
    crmWriteAllowed: false,
    signedWorkOrderPresent: false,
    workOrderPersisted: false,
    missionCreated: false,
    dispatchQueued: false,
    executionAuthorized: false,
    productionGate: 'blocked',
    nextRequiredGate,
  } as const

  return {
    ...digestMaterial,
    previewSha256: hashAction(digestMaterial),
    provenance: {
      source: 'control-broker',
      sourceId: `a1-work-order-preview:${dossier.reviewId}`,
      observedAt: now.toISOString(),
      synthetic: false,
    },
  }
}
