import type { CommercialFact } from './commercial-fact-authority.js'
import {
  compileSupervisedMasterCase,
  type ObservableOutcome,
  type SupervisedMasterCase,
  type SupervisedTranscriptMessage,
} from './supervised-conversation-master.js'

export type PilotEvaluationFailureCode =
  | 'compile_failed'
  | 'route_mismatch'
  | 'handoff_reason_mismatch'
  | 'question_limit_exceeded'
  | 'fact_set_mismatch'
  | 'fact_authority_violation'
  | 'supervision_guardrail_failed'
  | 'chatwoot_permission_failed'
  | 'hermes_simulated'
  | 'fact_metadata_leaked'

export interface SupervisedPilotEvaluationCase {
  case_ref: string
  transcript: readonly SupervisedTranscriptMessage[]
  authorized_facts: readonly Readonly<CommercialFact>[]
  observable_outcome?: ObservableOutcome
  expected: {
    next_action: SupervisedMasterCase['next_action']
    handoff_reason: SupervisedMasterCase['handoff_reason']
    applied_fact_ids?: readonly string[]
    max_questions?: 0 | 1
  }
}

export interface SupervisedPilotEvaluationReport {
  schema: 'proptimiza-supervised-pilot-evaluation.v1'
  cases_total: number
  cases_passed: number
  cases_failed: number
  metrics: {
    human_review_cases: number
    human_handoff_cases: number
    fact_grounded_cases: number
    outcomes_observed: number
    outcomes_unknown: number
    one_question_compliant: number
    automatic_messages_permitted: 0
    labels_permitted: 0
    hermes_dispatches: 0
  }
  outcome_counts: Readonly<Record<ObservableOutcome, number>>
  failures: readonly {
    case_ref: string
    codes: readonly PilotEvaluationFailureCode[]
  }[]
}

const PILOT_CAPABILITIES = Object.freeze({
  chatwoot_read: true,
  internal_notes: true,
  labels: false,
  assignments: true,
  saved_drafts: false,
  hermes_dispatch: false,
  hermes_profiles: Object.freeze([] as string[]),
})

/**
 * Runs a deterministic, data-minimised QA pass for a supervised pilot suite.
 * It performs no I/O and returns only aggregate counts plus opaque case refs.
 */
export function evaluateSupervisedPilot(
  cases: readonly Readonly<SupervisedPilotEvaluationCase>[],
): Readonly<SupervisedPilotEvaluationReport> {
  validateSuite(cases)
  const failures: Array<{ case_ref: string; codes: PilotEvaluationFailureCode[] }> = []
  const outcomeCounts: Record<ObservableOutcome, number> = {
    resolved: 0, sale: 0, follow_up: 0, abandoned: 0, referred: 0, pending: 0, unknown: 0,
  }
  let humanReviewCases = 0
  let humanHandoffCases = 0
  let factGroundedCases = 0
  let oneQuestionCompliant = 0

  for (const candidate of cases) {
    const codes: PilotEvaluationFailureCode[] = []
    let result: Readonly<SupervisedMasterCase>
    try {
      result = compileSupervisedMasterCase({
        case_ref: candidate.case_ref,
        transcript: candidate.transcript,
        authorized_facts: candidate.authorized_facts,
        observable_outcome: candidate.observable_outcome,
        capabilities: PILOT_CAPABILITIES,
      })
    } catch {
      failures.push({ case_ref: candidate.case_ref, codes: ['compile_failed'] })
      outcomeCounts[candidate.observable_outcome ?? 'unknown'] += 1
      continue
    }

    outcomeCounts[result.observable_outcome] += 1
    if (result.next_action === 'human_review') humanReviewCases += 1
    else humanHandoffCases += 1
    if (result.applied_fact_ids.length > 0) factGroundedCases += 1

    const questionCount = (result.suggested_response.match(/\?/g) ?? []).length
    const maxQuestions = candidate.expected.max_questions ?? 1
    if (questionCount <= maxQuestions) oneQuestionCompliant += 1
    else codes.push('question_limit_exceeded')
    if (result.next_action !== candidate.expected.next_action) codes.push('route_mismatch')
    if (result.handoff_reason !== candidate.expected.handoff_reason) codes.push('handoff_reason_mismatch')

    const expectedFacts = [...(candidate.expected.applied_fact_ids ?? [])].sort()
    const actualFacts = [...result.applied_fact_ids].sort()
    if (JSON.stringify(actualFacts) !== JSON.stringify(expectedFacts)) codes.push('fact_set_mismatch')
    const authorizedIds = new Set(candidate.authorized_facts.map(fact => fact.id))
    if (actualFacts.some(id => !authorizedIds.has(id))) codes.push('fact_authority_violation')
    if (result.send_permitted !== false || result.automatic_reply_permitted !== false
      || result.human_review_required !== true) codes.push('supervision_guardrail_failed')

    const note = result.proposed_chatwoot_actions.find(action => action.action === 'internal_note')
    const label = result.proposed_chatwoot_actions.find(action => action.action === 'label')
    const assignment = result.proposed_chatwoot_actions.find(action => action.action === 'team_assignment')
    if (note?.status !== 'available_after_review' || label?.status !== 'unsupported'
      || (result.next_action === 'human_handoff' && assignment?.status !== 'available_after_review')
      || (result.next_action === 'human_review' && assignment !== undefined)) codes.push('chatwoot_permission_failed')
    if (result.profiles.some(profile => profile.execution !== 'internal_stage' || profile.hermes_profile_id !== null))
      codes.push('hermes_simulated')
    if (containsFactMetadata(result, candidate.authorized_facts)) codes.push('fact_metadata_leaked')
    if (codes.length > 0) failures.push({ case_ref: candidate.case_ref, codes })
  }

  const report: SupervisedPilotEvaluationReport = {
    schema: 'proptimiza-supervised-pilot-evaluation.v1',
    cases_total: cases.length,
    cases_passed: cases.length - failures.length,
    cases_failed: failures.length,
    metrics: {
      human_review_cases: humanReviewCases,
      human_handoff_cases: humanHandoffCases,
      fact_grounded_cases: factGroundedCases,
      outcomes_observed: cases.length - outcomeCounts.unknown,
      outcomes_unknown: outcomeCounts.unknown,
      one_question_compliant: oneQuestionCompliant,
      automatic_messages_permitted: 0,
      labels_permitted: 0,
      hermes_dispatches: 0,
    },
    outcome_counts: Object.freeze({ ...outcomeCounts }),
    failures: Object.freeze(failures),
  }
  return deepFreeze(report)
}

function validateSuite(cases: readonly Readonly<SupervisedPilotEvaluationCase>[]): void {
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 32) throw new Error('PILOT_EVALUATION_SUITE_INVALID')
  const refs = new Set<string>()
  for (const candidate of cases) {
    if (!candidate || typeof candidate !== 'object' || typeof candidate.case_ref !== 'string'
      || refs.has(candidate.case_ref) || !candidate.expected
      || !['human_review', 'human_handoff'].includes(candidate.expected.next_action)
      || !['none', 'missing_context', 'human_requested', 'sensitive_request', 'out_of_scope'].includes(candidate.expected.handoff_reason)
      || (candidate.expected.max_questions !== undefined && ![0, 1].includes(candidate.expected.max_questions)))
      throw new Error('PILOT_EVALUATION_SUITE_INVALID')
    refs.add(candidate.case_ref)
  }
}

function containsFactMetadata(result: Readonly<SupervisedMasterCase>, facts: readonly Readonly<CommercialFact>[]): boolean {
  const serialized = JSON.stringify(result)
  return facts.some(fact => serialized.includes(fact.source_ref) || serialized.includes(fact.approved_by_role)
    || serialized.includes(fact.approved_at) || serialized.includes(fact.expires_at))
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}
