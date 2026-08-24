export type ShadowDecisionDimension =
  | 'icp_fit'
  | 'evidence_sufficiency'
  | 'outreach_eligibility'

export type ShadowDecisionValue =
  | 'yes'
  | 'no'
  | 'unknown'
  | 'sufficient'
  | 'insufficient'

export interface ShadowReviewDecision {
  dimension: ShadowDecisionDimension
  machineValue: ShadowDecisionValue
  machineRationale: string
  humanValue: ShadowDecisionValue | null
  humanRationale: string | null
  evidenceUrl: string
  version: number
  updatedAt: string | null
}

export interface ShadowReviewAccount {
  slot: number
  name: string
  url: string
  decisions: ShadowReviewDecision[]
}

export interface ShadowReview {
  id: string
  missionId: string
  projectId: 'proptimiza'
  title: string
  status: 'open' | 'completed'
  expectedDecisionCount: 30
  completedDecisionCount: number
  version: number
  concordancePercent: number | null
  evidenceCompletenessPercent: number | null
  shadowGate: 'pending' | 'passed' | 'failed'
  productionGate: 'blocked'
  externalActions: 0
  reviewerId: string | null
  completedAt: string | null
  sourceArtifactSha256: string
  qaArtifactSha256: string
  accounts: ShadowReviewAccount[]
  provenance: {
    source: 'control-broker'
    sourceId: string
    observedAt: string
    synthetic: false
  }
}

export interface RecordShadowDecisionInput {
  reviewId: string
  accountSlot: number
  dimension: ShadowDecisionDimension
  humanValue: ShadowDecisionValue
  rationale: string
  evidenceUrl: string
  expectedVersion: number
  actorId: string
  idempotencyKey: string
  requestSha256: string
}

export interface CompleteShadowReviewInput {
  reviewId: string
  expectedVersion: number
  actorId: string
  idempotencyKey: string
  requestSha256: string
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256 = /^[0-9a-f]{64}$/

export function validateShadowReview(value: unknown): ShadowReview {
  try {
    const review = object(value)
    exactKeys(review, [
      'id','missionId','projectId','title','status','expectedDecisionCount',
      'completedDecisionCount','version','concordancePercent',
      'evidenceCompletenessPercent','shadowGate','productionGate',
      'externalActions','reviewerId','completedAt','sourceArtifactSha256',
      'qaArtifactSha256','accounts','provenance',
    ])
    if (!uuid.test(string(review.id)) || !uuid.test(string(review.missionId)) ||
        review.projectId !== 'proptimiza' || !string(review.title) ||
        !['open','completed'].includes(string(review.status)) ||
        review.expectedDecisionCount !== 30 || !integerBetween(review.completedDecisionCount, 0, 30) ||
        !integerBetween(review.version, 0, Number.MAX_SAFE_INTEGER) ||
        !nullablePercent(review.concordancePercent) || !nullablePercent(review.evidenceCompletenessPercent) ||
        !['pending','passed','failed'].includes(string(review.shadowGate)) ||
        review.productionGate !== 'blocked' || review.externalActions !== 0 ||
        !nullableString(review.reviewerId) || !nullableDate(review.completedAt) ||
        !sha256.test(string(review.sourceArtifactSha256)) || !sha256.test(string(review.qaArtifactSha256)))
      throw new Error('review')
    const accounts = array(review.accounts)
    if (accounts.length !== 10) throw new Error('accounts')
    const slots = new Set<number>()
    let completed = 0
    for (const candidate of accounts) {
      const account = object(candidate)
      exactKeys(account, ['slot','name','url','decisions'])
      if (!integerBetween(account.slot, 1, 10) || slots.has(account.slot as number) ||
          !string(account.name) || !validHttpsUrl(account.url)) throw new Error('account')
      slots.add(account.slot as number)
      const decisions = array(account.decisions)
      if (decisions.length !== 3) throw new Error('decisions')
      const dimensions = new Set<string>()
      for (const decisionValue of decisions) {
        const decision = object(decisionValue)
        exactKeys(decision, ['dimension','machineValue','machineRationale','humanValue','humanRationale','evidenceUrl','version','updatedAt'])
        const dimension = string(decision.dimension) as ShadowDecisionDimension
        if (!['icp_fit','evidence_sufficiency','outreach_eligibility'].includes(dimension) || dimensions.has(dimension) ||
            !validDecisionValue(dimension, decision.machineValue) || !string(decision.machineRationale) ||
            (decision.humanValue !== null && !validDecisionValue(dimension, decision.humanValue)) ||
            !nullableString(decision.humanRationale) || !validHttpsUrl(decision.evidenceUrl) ||
            !integerBetween(decision.version, 0, Number.MAX_SAFE_INTEGER) || !nullableDate(decision.updatedAt))
          throw new Error('decision')
        if (decision.humanValue !== null) completed += 1
        dimensions.add(dimension)
      }
    }
    if (completed !== review.completedDecisionCount) throw new Error('completed count')
    validateProvenance(review.provenance, string(review.id))
    if ((review.status === 'open') !== (review.shadowGate === 'pending')) throw new Error('state')
    return value as ShadowReview
  } catch {
    throw new Error('SHADOW_REVIEW_INVALID')
  }
}

export function validateShadowReviewList(value: unknown): ShadowReview[] {
  if (!Array.isArray(value)) throw new Error('SHADOW_REVIEW_INVALID')
  return value.map(validateShadowReview)
}

function validDecisionValue(dimension: ShadowDecisionDimension, value: unknown): boolean {
  if (dimension === 'icp_fit') return ['yes','no','unknown'].includes(string(value))
  if (dimension === 'evidence_sufficiency') return ['sufficient','insufficient'].includes(string(value))
  return ['yes','no'].includes(string(value))
}

function validateProvenance(value: unknown, id: string): void {
  const provenance = object(value)
  exactKeys(provenance, ['source','sourceId','observedAt','synthetic'])
  if (provenance.source !== 'control-broker' || provenance.sourceId !== `shadow-review:${id}` ||
      !validDate(provenance.observedAt) || provenance.synthetic !== false) throw new Error('provenance')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
  return value as Record<string, unknown>
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('array'); return value }
function string(value: unknown): string { return typeof value === 'string' ? value : '' }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(); const keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key,index) => key !== keys[index])) throw new Error('keys')
}
function integerBetween(value: unknown, min: number, max: number): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max }
function nullableString(value: unknown): boolean { return value === null || typeof value === 'string' }
function validDate(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function nullableDate(value: unknown): boolean { return value === null || validDate(value) }
function nullablePercent(value: unknown): boolean { return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) }
function validHttpsUrl(value: unknown): boolean { try { const url = new URL(string(value)); return url.protocol === 'https:' && Boolean(url.hostname) } catch { return false } }
