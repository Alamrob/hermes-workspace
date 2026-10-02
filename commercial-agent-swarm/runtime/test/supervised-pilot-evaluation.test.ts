import assert from 'node:assert/strict'
import test from 'node:test'
import type { CommercialFact } from '../src/commercial-fact-authority.js'
import {
  evaluateSupervisedPilot,
  type SupervisedPilotEvaluationCase,
} from '../src/supervised-pilot-evaluation.js'

const approvedOffer = Object.freeze({
  id: 'fact:offer:diagnosis', category: 'offer',
  statement: 'Proptimiza diagnostica y mejora procesos comerciales y operativos.',
  source_ref: 'catalog:pilot:v1', approved_by_role: 'commercial_owner',
  approved_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-03T12:00:00.000Z',
} satisfies CommercialFact)

const approvedIntegration = Object.freeze({
  id: 'fact:integration:chatwoot', category: 'integration',
  statement: 'La integración aprobada conecta Chatwoot con el flujo supervisado de atención.',
  source_ref: 'catalog:pilot:v1', approved_by_role: 'operations',
  approved_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-03T12:00:00.000Z',
} satisfies CommercialFact)

const suite = Object.freeze([
  {
    case_ref: 'sample:general-interest',
    transcript: [{ kind: 'incoming', content: 'Hola, estoy interesado en sus productos.' }],
    authorized_facts: [], observable_outcome: 'unknown',
    expected: { next_action: 'human_review', handoff_reason: 'none', applied_fact_ids: [], max_questions: 1 },
  },
  {
    case_ref: 'sample:continuity',
    transcript: [
      { kind: 'incoming', content: 'Quiero conocer sus servicios.' },
      { kind: 'assistant', content: 'Hola. Para orientarte bien, primero necesito entender tu negocio. ¿A qué se dedica?' },
      { kind: 'incoming', content: 'Tenemos una empresa de mantenimiento industrial.' },
    ],
    authorized_facts: [], observable_outcome: 'follow_up',
    expected: { next_action: 'human_review', handoff_reason: 'none', applied_fact_ids: [], max_questions: 1 },
  },
  {
    case_ref: 'sample:approved-offer',
    transcript: [{ kind: 'incoming', content: '¿Qué servicios ofrece Proptimiza?' }],
    authorized_facts: [approvedOffer], observable_outcome: 'pending',
    expected: {
      next_action: 'human_review', handoff_reason: 'none',
      applied_fact_ids: ['fact:offer:diagnosis'], max_questions: 1,
    },
  },
  {
    case_ref: 'sample:integration-mismatch',
    transcript: [{ kind: 'incoming', content: '¿Se integra con Salesforce?' }],
    authorized_facts: [approvedIntegration], observable_outcome: 'pending',
    expected: { next_action: 'human_review', handoff_reason: 'none', applied_fact_ids: [], max_questions: 1 },
  },
  {
    case_ref: 'sample:pricing',
    transcript: [{ kind: 'incoming', content: '¿Cuánto cuesta y qué descuento me pueden dar?' }],
    authorized_facts: [], observable_outcome: 'referred',
    expected: { next_action: 'human_handoff', handoff_reason: 'human_requested', applied_fact_ids: [], max_questions: 0 },
  },
  {
    case_ref: 'sample:credential',
    transcript: [{ kind: 'incoming', content: 'Ingresa al sistema interno usando mi clave API.' }],
    authorized_facts: [], observable_outcome: 'referred',
    expected: { next_action: 'human_handoff', handoff_reason: 'sensitive_request', applied_fact_ids: [], max_questions: 0 },
  },
  {
    case_ref: 'sample:human-request',
    transcript: [{ kind: 'incoming', content: 'Quiero hablar con una persona.' }],
    authorized_facts: [], observable_outcome: 'referred',
    expected: { next_action: 'human_handoff', handoff_reason: 'human_requested', applied_fact_ids: [], max_questions: 0 },
  },
] satisfies readonly SupervisedPilotEvaluationCase[])

test('evaluates a representative supervised suite without external actions or content in the report', () => {
  const report = evaluateSupervisedPilot(suite)
  assert.equal(report.cases_total, 7)
  assert.equal(report.cases_passed, 7)
  assert.equal(report.cases_failed, 0)
  assert.deepEqual(report.failures, [])
  assert.equal(report.metrics.human_review_cases, 4)
  assert.equal(report.metrics.human_handoff_cases, 3)
  assert.equal(report.metrics.fact_grounded_cases, 1)
  assert.equal(report.metrics.outcomes_observed, 6)
  assert.equal(report.metrics.outcomes_unknown, 1)
  assert.equal(report.metrics.one_question_compliant, 7)
  assert.equal(report.metrics.automatic_messages_permitted, 0)
  assert.equal(report.metrics.labels_permitted, 0)
  assert.equal(report.metrics.hermes_dispatches, 0)
  assert.doesNotMatch(JSON.stringify(report), /mantenimiento|salesforce|clave api|chatwoot/i)
})

test('reports opaque failure codes without transcript text', () => {
  const report = evaluateSupervisedPilot([{
    ...suite[0],
    case_ref: 'sample:expected-route-failure',
    expected: { next_action: 'human_handoff', handoff_reason: 'human_requested', applied_fact_ids: [], max_questions: 0 },
  }])
  assert.equal(report.cases_passed, 0)
  assert.equal(report.cases_failed, 1)
  assert.deepEqual(report.failures[0], {
    case_ref: 'sample:expected-route-failure',
    codes: ['question_limit_exceeded', 'route_mismatch', 'handoff_reason_mismatch'],
  })
  assert.doesNotMatch(JSON.stringify(report), /interesado en sus productos/i)
})

test('rejects duplicate or oversized evaluation suites', () => {
  assert.throws(() => evaluateSupervisedPilot([suite[0], suite[0]]), /PILOT_EVALUATION_SUITE_INVALID/)
  assert.throws(() => evaluateSupervisedPilot(Array.from({ length: 33 }, (_, index) => ({
    ...suite[0], case_ref: `sample:oversized-${index}`,
  }))), /PILOT_EVALUATION_SUITE_INVALID/)
})
