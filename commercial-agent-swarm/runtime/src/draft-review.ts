export type DraftReviewDecision = 'accepted_internal' | 'revised_internal' | 'rejected'

export interface DraftReviewItem {
  slot: number
  companyName: string
  sourceUrl: string
  evidenceBasis: string
  originalSubject: string
  originalBody: string
  sourceDraftSha256: string
  machineDecision: 'human_review_candidate'
  machineReason: string
  riskFlags: string[]
  humanDecision: DraftReviewDecision | null
  humanRationale: string | null
  revisedSubject: string | null
  revisedBody: string | null
  approvalState: 'human_review_required' | 'internal_reviewed' | 'not_applicable'
  externalActionEligible: false
  version: number
  updatedAt: string | null
}

export interface DraftReview {
  id: string
  missionId: string
  predecessorMissionId: string
  projectId: 'proptimiza'
  offerId: 'operacion-sin-planillas'
  offerVersion: 'v1'
  title: string
  status: 'open' | 'completed'
  expectedItemCount: 3
  completedItemCount: number
  acceptedCount: number
  revisedCount: number
  rejectedCount: number
  version: number
  internalReviewGate: 'pending' | 'complete'
  productionGate: 'blocked'
  externalActions: 0
  reviewerId: string | null
  completedAt: string | null
  sourceArtifactSha256: string
  qaArtifactSha256: string
  predecessorArtifactSha256: string
  predecessorQaArtifactSha256: string
  items: DraftReviewItem[]
  provenance: {
    source: 'control-broker'
    sourceId: string
    observedAt: string
    synthetic: false
  }
}

export interface RecordDraftReviewItemInput {
  reviewId: string
  itemSlot: number
  decision: DraftReviewDecision
  rationale: string
  revisedSubject: string | null
  revisedBody: string | null
  expectedVersion: number
  actorId: string
  idempotencyKey: string
  requestSha256: string
}

export interface CompleteDraftReviewInput {
  reviewId: string
  expectedVersion: number
  actorId: string
  idempotencyKey: string
  requestSha256: string
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256 = /^[0-9a-f]{64}$/

export function validateDraftReview(value: unknown): DraftReview {
  try {
    const review = object(value)
    exactKeys(review, [
      'id','missionId','predecessorMissionId','projectId','offerId','offerVersion','title',
      'status','expectedItemCount','completedItemCount','acceptedCount','revisedCount',
      'rejectedCount','version','internalReviewGate','productionGate','externalActions',
      'reviewerId','completedAt','sourceArtifactSha256','qaArtifactSha256',
      'predecessorArtifactSha256','predecessorQaArtifactSha256','items','provenance',
    ])
    if (!uuid.test(text(review.id)) || !uuid.test(text(review.missionId)) ||
        !uuid.test(text(review.predecessorMissionId)) || review.projectId !== 'proptimiza' ||
        review.offerId !== 'operacion-sin-planillas' || review.offerVersion !== 'v1' ||
        !text(review.title) || !['open','completed'].includes(text(review.status)) ||
        review.expectedItemCount !== 3 || !count(review.completedItemCount, 0, 3) ||
        !count(review.acceptedCount, 0, 3) || !count(review.revisedCount, 0, 3) ||
        !count(review.rejectedCount, 0, 3) || !count(review.version, 0, Number.MAX_SAFE_INTEGER) ||
        !['pending','complete'].includes(text(review.internalReviewGate)) ||
        review.productionGate !== 'blocked' || review.externalActions !== 0 ||
        !nullableText(review.reviewerId) || !nullableDate(review.completedAt) ||
        !sha256.test(text(review.sourceArtifactSha256)) || !sha256.test(text(review.qaArtifactSha256)) ||
        !sha256.test(text(review.predecessorArtifactSha256)) || !sha256.test(text(review.predecessorQaArtifactSha256)))
      throw new Error('review')
    const items = list(review.items)
    if (items.length !== 3) throw new Error('items')
    const slots = new Set<number>()
    let completed = 0, accepted = 0, revised = 0, rejected = 0
    for (const candidate of items) {
      const item = object(candidate)
      exactKeys(item, [
        'slot','companyName','sourceUrl','evidenceBasis','originalSubject','originalBody',
        'sourceDraftSha256','machineDecision','machineReason','riskFlags','humanDecision',
        'humanRationale','revisedSubject','revisedBody','approvalState',
        'externalActionEligible','version','updatedAt',
      ])
      if (!count(item.slot, 1, 3) || slots.has(item.slot as number) || !text(item.companyName) ||
          !httpsUrl(item.sourceUrl) || !text(item.evidenceBasis) || !text(item.originalSubject) ||
          !text(item.originalBody) || !sha256.test(text(item.sourceDraftSha256)) ||
          item.machineDecision !== 'human_review_candidate' || !text(item.machineReason) ||
          !Array.isArray(item.riskFlags) || item.riskFlags.some((flag) => !text(flag)) ||
          !nullableDecision(item.humanDecision) || !nullableText(item.humanRationale) ||
          !nullableText(item.revisedSubject) || !nullableText(item.revisedBody) ||
          !['human_review_required','internal_reviewed','not_applicable'].includes(text(item.approvalState)) ||
          item.externalActionEligible !== false || !count(item.version, 0, Number.MAX_SAFE_INTEGER) ||
          !nullableDate(item.updatedAt)) throw new Error('item')
      slots.add(item.slot as number)
      if (item.humanDecision !== null) {
        completed += 1
        if (item.humanDecision === 'accepted_internal') accepted += 1
        if (item.humanDecision === 'revised_internal') revised += 1
        if (item.humanDecision === 'rejected') rejected += 1
      }
      if (item.humanDecision === 'revised_internal') {
        if (!text(item.revisedSubject) || !text(item.revisedBody) || item.approvalState !== 'internal_reviewed') throw new Error('revision')
      } else if (item.revisedSubject !== null || item.revisedBody !== null) throw new Error('unexpected revision')
      if (item.humanDecision === null && (item.humanRationale !== null || item.approvalState !== 'human_review_required' || item.version !== 0 || item.updatedAt !== null)) throw new Error('pending')
      if (item.humanDecision === 'rejected' && item.approvalState !== 'not_applicable') throw new Error('rejected')
      if (item.humanDecision === 'accepted_internal' && item.approvalState !== 'internal_reviewed') throw new Error('accepted')
    }
    if (completed !== review.completedItemCount || accepted !== review.acceptedCount ||
        revised !== review.revisedCount || rejected !== review.rejectedCount) throw new Error('counts')
    if (review.status === 'open' && (review.internalReviewGate !== 'pending' || review.reviewerId !== null || review.completedAt !== null)) throw new Error('open state')
    if (review.status === 'completed' && (review.internalReviewGate !== 'complete' || completed !== 3 || !review.reviewerId || !review.completedAt)) throw new Error('complete state')
    const provenance = object(review.provenance)
    exactKeys(provenance, ['source','sourceId','observedAt','synthetic'])
    if (provenance.source !== 'control-broker' || provenance.sourceId !== `draft-review:${review.id}` ||
        !validDate(provenance.observedAt) || provenance.synthetic !== false) throw new Error('provenance')
    return value as DraftReview
  } catch {
    throw new Error('DRAFT_REVIEW_INVALID')
  }
}

export function validateDraftReviewList(value: unknown): DraftReview[] {
  if (!Array.isArray(value)) throw new Error('DRAFT_REVIEW_INVALID')
  return value.map(validateDraftReview)
}

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object'); return value as Record<string, unknown> }
function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('list'); return value }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { const actual=Object.keys(value).sort(), wanted=[...expected].sort(); if (actual.length !== wanted.length || actual.some((key,index)=>key!==wanted[index])) throw new Error('keys') }
function count(value: unknown, min: number, max: number): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max }
function nullableText(value: unknown): boolean { return value === null || typeof value === 'string' }
function nullableDecision(value: unknown): boolean { return value === null || ['accepted_internal','revised_internal','rejected'].includes(text(value)) }
function validDate(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function nullableDate(value: unknown): boolean { return value === null || validDate(value) }
function httpsUrl(value: unknown): boolean { try { const url=new URL(text(value)); return url.protocol === 'https:' && Boolean(url.hostname) } catch { return false } }
