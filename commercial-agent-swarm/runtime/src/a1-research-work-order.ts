import { canonicalJson } from './canonical.js'
import {
  hashA1ResearchDossier,
  validateA1ResearchAuthorizationState,
  type A1ResearchAuthorizationState,
} from './a1-research-authorization.js'
import { validateA1ResearchDossier, type A1ResearchDossier } from './a1-research-dossier.js'
import { AuthenticationError } from './security.js'
import type { WorkOrder } from './work-orders.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/

export interface A1ResearchOrderEvidence {
  reviewId: string
  dossierSha256: string
  authorizationId: string
  authorizationExpiresAt: string
  userAuthorizationSha256: string
  userAuthorizedAt: string
  userAuthorizedBy: 'proptimizaspa@gmail.com'
}

export function a1ResearchReviewId(workOrder: WorkOrder): string | null {
  const actions = stringArray(workOrder.allowed_actions)
  const channels = stringArray(workOrder.approved_channels)
  const publicResearch = actions?.includes('research.public.read') === true || channels?.includes('public_web') === true
  if (!publicResearch) return null
  if (workOrder.autonomy_level !== 'A1') deny()
  const metadata = record(workOrder.metadata)
  const reviewId = metadata?.a1_research_review_id
  if (typeof reviewId !== 'string' || !UUID.test(reviewId)) deny()
  return reviewId as string
}

export function assertA1ResearchWorkOrderAdmission(
  workOrder: WorkOrder,
  dossierValue: A1ResearchDossier | null,
  authorizationValue: A1ResearchAuthorizationState | null,
  now: Date,
): void {
  const reviewId = a1ResearchReviewId(workOrder)
  if (reviewId === null) return
  if (!dossierValue || !authorizationValue) deny()
  const dossier = validateA1ResearchDossier(dossierValue)
  const state = validateA1ResearchAuthorizationState(authorizationValue)
  const dossierSha256 = hashA1ResearchDossier(dossier)
  const authorization = state.authorization
  const metadata = record(workOrder.metadata)
  const budget = record(workOrder.budget_limit)
  const volume = record(workOrder.volume_limits)
  const dataPolicy = record(workOrder.data_policy)
  const contactPolicy = record(workOrder.contact_policy)
  const orderExpiresAt = Date.parse(String(workOrder.expires_at))
  const orderCreatedAt = Date.parse(String(workOrder.created_at))
  const userAuthorizedAt = Date.parse(String(metadata?.a1_research_order_authorized_at))

  if (
    dossier.reviewId !== reviewId || dossier.status !== 'authorization_required' || dossier.reviewCompleted !== true ||
    dossier.eligibleAccountCount < 1 || dossier.eligibleAccountCount !== dossier.accounts.length ||
    state.reviewId !== reviewId || state.dossierSha256 !== dossierSha256 || state.dossierCurrent !== true ||
    state.authorizationRecorded !== true || authorization === null || authorization.decision !== 'approved' ||
    authorization.dossierSha256 !== dossierSha256 || authorization.attestations.separateSignedWorkOrderRequired !== true ||
    Date.parse(authorization.expiresAt) <= now.getTime() || orderExpiresAt > Date.parse(authorization.expiresAt) ||
    orderCreatedAt < Date.parse(authorization.reviewedAt) || orderCreatedAt > now.getTime() ||
    workOrder.project_id !== dossier.projectId || workOrder.offer_id !== dossier.offerId || workOrder.offer_version !== dossier.offerVersion ||
    workOrder.policy_version !== 'policy-v1' || workOrder.icp_version !== 'icp-v1' || workOrder.autonomy_level !== 'A1' ||
    workOrder.dry_run !== true || workOrder.approval_token !== null || workOrder.requested_by !== 'codex-auditor' ||
    !exactArray(workOrder.allowed_actions, dossier.allowedActions) ||
    !containsEvery(workOrder.prohibited_actions, dossier.prohibitedActions) ||
    !exactArray(workOrder.approved_channels, dossier.approvedChannels) ||
    !exactArray(workOrder.approved_tools, dossier.requestedTools) ||
    budget?.currency !== 'USD' || typeof budget.maximum !== 'number' || budget.maximum < 0 || budget.maximum > dossier.maximumBudgetUsd ||
    volume?.maximum_accounts !== dossier.maximumAccounts || volume.maximum_contacts !== 0 || volume.maximum_external_actions !== 0 ||
    volume.maximum_per_contact !== 0 || volume.period !== 'mission' ||
    contactPolicy?.contact_permitted !== false || contactPolicy.suppression_check_required !== true ||
    dataPolicy?.classification !== 'public' || dataPolicy.sensitive_data_allowed !== false ||
    !exactArray(dataPolicy.allowed_countries, ['CL']) || !containsEvery(dataPolicy.legal_basis, ['public_source_reviewed']) ||
    !exactArray(dataPolicy.allowed_data_categories, dossier.allowedDataCategories) ||
    metadata?.a1_research_dossier_sha256 !== dossierSha256 ||
    metadata.a1_research_authorization_id !== authorization.authorizationId ||
    metadata.a1_research_authorization_expires_at !== authorization.expiresAt ||
    metadata.a1_research_order_authorized_by !== 'proptimizaspa@gmail.com' ||
    typeof metadata.a1_research_order_authorization_sha256 !== 'string' || !SHA256.test(metadata.a1_research_order_authorization_sha256) ||
    !Number.isFinite(userAuthorizedAt) || userAuthorizedAt < Date.parse(authorization.reviewedAt) || userAuthorizedAt > orderCreatedAt ||
    canonicalJson(metadata.a1_research_accounts) !== canonicalJson(expectedAccounts(dossier))
  ) deny()
}

export function expectedA1ResearchOrderEvidence(
  dossierValue: A1ResearchDossier,
  authorizationValue: A1ResearchAuthorizationState,
  input: { userAuthorizationSha256: string; userAuthorizedAt: string },
): A1ResearchOrderEvidence {
  const dossier = validateA1ResearchDossier(dossierValue)
  const state = validateA1ResearchAuthorizationState(authorizationValue)
  const authorization = state.authorization
  const dossierSha256 = hashA1ResearchDossier(dossier)
  if (
    !authorization || authorization.decision !== 'approved' || !state.authorizationRecorded || !state.dossierCurrent ||
    state.dossierSha256 !== dossierSha256 || !SHA256.test(input.userAuthorizationSha256) ||
    !Number.isFinite(Date.parse(input.userAuthorizedAt))
  ) deny()
  return {
    reviewId: dossier.reviewId,
    dossierSha256,
    authorizationId: authorization.authorizationId,
    authorizationExpiresAt: authorization.expiresAt,
    userAuthorizationSha256: input.userAuthorizationSha256,
    userAuthorizedAt: new Date(input.userAuthorizedAt).toISOString(),
    userAuthorizedBy: 'proptimizaspa@gmail.com',
  }
}

export function a1ResearchOrderMetadata(
  dossierValue: A1ResearchDossier,
  evidence: A1ResearchOrderEvidence,
): Record<string, unknown> {
  const dossier = validateA1ResearchDossier(dossierValue)
  return {
    a1_research_review_id: evidence.reviewId,
    a1_research_dossier_sha256: evidence.dossierSha256,
    a1_research_authorization_id: evidence.authorizationId,
    a1_research_authorization_expires_at: evidence.authorizationExpiresAt,
    a1_research_order_authorization_sha256: evidence.userAuthorizationSha256,
    a1_research_order_authorized_at: evidence.userAuthorizedAt,
    a1_research_order_authorized_by: evidence.userAuthorizedBy,
    a1_research_accounts: expectedAccounts(dossier),
  }
}

function expectedAccounts(dossier: A1ResearchDossier): Array<Record<string, unknown>> {
  return dossier.accounts.map((account) => ({
    slot: account.slot,
    company_name: account.companyName,
    source_url: account.sourceUrl,
    decision_version: account.decisionVersion,
  }))
}

function exactArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
}

function containsEvery(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && expected.every((entry) => value.includes(entry))
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function deny(): never {
  throw new AuthenticationError('A1_RESEARCH_WORK_ORDER_NOT_AUTHORIZED')
}
