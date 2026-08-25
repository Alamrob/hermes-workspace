export type PolicyReviewKind = 'commercial' | 'privacy_legal'
export type PolicyReviewDecision = 'approved' | 'rejected'

export interface PolicyReviewAttestations {
  policyDigestConfirmed: boolean
  noActivationRequested: boolean
  reviewScopeConfirmed: boolean
  controlSetConfirmed: boolean
  competentHumanConfirmed: boolean
}

export interface PolicyReviewRecord {
  kind: PolicyReviewKind
  decision: PolicyReviewDecision
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  policyDigest: string
  attestations: PolicyReviewAttestations
}

export interface PolicyReviewState {
  projectId: 'proptimiza'
  policyVersion: 'policy-v2'
  policyDigest: string
  draftStatus: 'draft_human_approval_required'
  effective: false
  externalContact: false
  activePolicyVersion: string
  commercialReview: PolicyReviewRecord | null
  privacyLegalReview: PolicyReviewRecord | null
  reviewCompleted: boolean
  activationCreated: false
  provenance: {
    source: 'control-broker'
    sourceId: 'policy-review:proptimiza:policy-v2'
    observedAt: string
    synthetic: false
  }
}

export interface RecordPolicyReviewInput {
  kind: PolicyReviewKind
  decision: PolicyReviewDecision
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  expectedPolicyDigest: string
  attestations: PolicyReviewAttestations
  idempotencyKey: string
  requestSha256: string
}

const sha256 = /^[0-9a-f]{64}$/

export class PolicyReviewError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'PolicyReviewError'
  }
}

export function validatePolicyReviewState(value: unknown): PolicyReviewState {
  try {
    const state = object(value)
    exactKeys(state, ['projectId','policyVersion','policyDigest','draftStatus','effective','externalContact','activePolicyVersion','commercialReview','privacyLegalReview','reviewCompleted','activationCreated','provenance'])
    if (state.projectId !== 'proptimiza' || state.policyVersion !== 'policy-v2' ||
        !sha256.test(string(state.policyDigest)) || state.draftStatus !== 'draft_human_approval_required' ||
        state.effective !== false || state.externalContact !== false || !string(state.activePolicyVersion) ||
        state.activationCreated !== false) throw new Error('identity')
    const commercial = nullableReview(state.commercialReview, 'commercial')
    const privacyLegal = nullableReview(state.privacyLegalReview, 'privacy_legal')
    if (state.reviewCompleted !== (commercial?.decision === 'approved' && privacyLegal?.decision === 'approved')) throw new Error('completion')
    const provenance = object(state.provenance)
    exactKeys(provenance, ['source','sourceId','observedAt','synthetic'])
    if (provenance.source !== 'control-broker' || provenance.sourceId !== 'policy-review:proptimiza:policy-v2' ||
        !date(provenance.observedAt) || provenance.synthetic !== false) throw new Error('provenance')
    return value as PolicyReviewState
  } catch {
    throw new Error('POLICY_REVIEW_INVALID')
  }
}

function nullableReview(value: unknown, kind: PolicyReviewKind): PolicyReviewRecord | null {
  if (value === null) return null
  const review = object(value)
  exactKeys(review, ['kind','decision','rationale','reviewerId','reviewerEmail','reviewedAt','policyDigest','attestations'])
  if (review.kind !== kind || !['approved','rejected'].includes(string(review.decision)) ||
      string(review.rationale).trim().length < 20 || string(review.rationale).length > 2000 ||
      !/^[A-Za-z0-9._:@+-]{3,254}$/.test(string(review.reviewerId)) ||
      review.reviewerEmail !== 'proptimizaspa@gmail.com' || !date(review.reviewedAt) ||
      !sha256.test(string(review.policyDigest))) throw new Error('review')
  const attestations = object(review.attestations)
  exactKeys(attestations, ['policyDigestConfirmed','noActivationRequested','reviewScopeConfirmed','controlSetConfirmed','competentHumanConfirmed'])
  if (Object.values(attestations).some((item) => typeof item !== 'boolean') ||
      attestations.policyDigestConfirmed !== true || attestations.noActivationRequested !== true || attestations.reviewScopeConfirmed !== true ||
      (review.decision === 'approved' && attestations.controlSetConfirmed !== true) ||
      (review.decision === 'approved' && kind === 'privacy_legal' && attestations.competentHumanConfirmed !== true)) throw new Error('attestations')
  return review as unknown as PolicyReviewRecord
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
  return value as Record<string, unknown>
}
function string(value: unknown): string { return typeof value === 'string' ? value : '' }
function date(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key,index) => key !== wanted[index])) throw new Error('keys')
}
