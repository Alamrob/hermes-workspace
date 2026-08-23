import type { ProfileId, TrustedUsage } from './executor-contract.js'

export interface AgentResult {
  mission_id: string
  trace_id: string
  assignment_id: string
  agent_id: ProfileId
  status: 'completed' | 'partial' | 'blocked' | 'failed' | 'approval_required'
  summary: string
  facts: Array<unknown>
  inferences: Array<unknown>
  actions_taken: Array<unknown>
  external_changes: []
  evidence: Array<unknown>
  artifacts: Array<unknown>
  metrics: Record<string, string | number | boolean | null>
  cost: {
    currency: 'USD'
    llm: number
    tools: 0
    total: number
    input_tokens: number
    output_tokens: number
  }
  errors: Array<unknown>
  risks: Array<unknown>
  pending_approvals: Array<unknown>
  recommended_next_actions: Array<string>
  started_at: string
  finished_at: string
}

export const AGENT_RESULT_TOP_LEVEL_KEYS = [
  'mission_id',
  'trace_id',
  'assignment_id',
  'agent_id',
  'status',
  'summary',
  'facts',
  'inferences',
  'actions_taken',
  'external_changes',
  'evidence',
  'artifacts',
  'metrics',
  'cost',
  'errors',
  'risks',
  'pending_approvals',
  'recommended_next_actions',
  'started_at',
  'finished_at',
] as const
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function reconcileAgentResult(
  raw: unknown,
  identity: {
    mission_id: string
    trace_id: string
    assignment_id: string
    profile_id: ProfileId
  },
  usage: TrustedUsage,
  charge: { currency: string; amount: number },
  startedAt: string,
  finishedAt: string,
): AgentResult {
  if (!record(raw) || !exact(raw, [...AGENT_RESULT_TOP_LEVEL_KEYS]))
    invalidStage('TOP_LEVEL')
  // Identity is transport-owned. The model is required to return the fields so
  // malformed envelopes still fail closed, but it is never authoritative for
  // mission, trace, assignment or profile identity. Always replace those four
  // values with the signed executor request below.
  if (
    ![
      'completed',
      'partial',
      'blocked',
      'failed',
      'approval_required',
    ].includes(String(raw.status)) ||
    typeof raw.summary !== 'string' ||
    raw.summary.length < 1 ||
    raw.summary.length > 4000
  )
    invalidStage('STATUS_SUMMARY')
  if (!Array.isArray(raw.external_changes)) invalidStage('EXTERNAL_CHANGES')
  if (raw.external_changes.length) throw new Error('SIMULATION_EXTERNAL_CHANGE')
  validateStage('FACTS', () => array(raw.facts).forEach(fact))
  validateStage('INFERENCES', () => array(raw.inferences).forEach(inference))
  validateStage('ACTIONS', () => array(raw.actions_taken).forEach(action))
  validateStage('EVIDENCE', () => array(raw.evidence).forEach(evidence))
  validateStage('ARTIFACTS', () => array(raw.artifacts).forEach(artifact))
  validateStage('ERRORS', () => array(raw.errors).forEach(agentError))
  validateStage('RISKS', () => array(raw.risks).forEach(risk))
  validateStage('APPROVALS', () => array(raw.pending_approvals).forEach(approval))
  validateStage('NEXT_ACTIONS', () => {
    const next = array(raw.recommended_next_actions)
    if (!next.every((v) => str(v, 1, 1000))) invalid()
  })
  validateStage('METRICS', () => {
    if (
      !record(raw.metrics) ||
      !Object.values(raw.metrics).every(
        (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v),
      )
    ) invalid()
  })
  validateStage('COST', () => cost(raw.cost))
  validateStage('TIMESTAMPS', () => {
    if (
      !date(raw.started_at) ||
      !date(raw.finished_at) ||
      !date(startedAt) ||
      !date(finishedAt) ||
      Date.parse(finishedAt) < Date.parse(startedAt)
    ) invalid()
  })
  if (
    charge.currency !== 'USD' ||
    typeof charge.amount !== 'number' ||
    !Number.isFinite(charge.amount) ||
    charge.amount <= 0
  )
    throw new Error('APPROVED_EXECUTION_CHARGE_REQUIRED')
  if (usage.cost.status !== 'known') throw new Error('HERMES_COST_UNKNOWN')
  if (
    usage.cost.source !== 'official_docs_snapshot' ||
    usage.cost.pricing_snapshot_id === null ||
    usage.cost.cash_cost_usd !== 0
  )
    throw new Error('HERMES_PRICING_AUTHORITY_INVALID')
  if (usage.cost.usage_value_usd > charge.amount)
    throw new Error('HERMES_COST_RESERVATION_EXCEEDED')
  const validatedRaw = raw as unknown as AgentResult
  return {
    ...validatedRaw,
    mission_id: identity.mission_id,
    trace_id: identity.trace_id,
    assignment_id: identity.assignment_id,
    agent_id: identity.profile_id,
    external_changes: [],
    metrics: {
      ...validatedRaw.metrics,
      provider_usage_value_usd: usage.cost.usage_value_usd,
      cash_cost_usd: usage.cost.cash_cost_usd,
      pricing_snapshot_id: usage.cost.pricing_snapshot_id,
      pricing_source: usage.cost.source,
    },
    cost: {
      currency: 'USD',
      llm: usage.cost.cash_cost_usd,
      tools: 0,
      total: usage.cost.cash_cost_usd,
      input_tokens: usage.tokens.input,
      output_tokens: usage.tokens.output,
    },
    started_at: startedAt,
    finished_at: finishedAt,
  }
}

function validateStage(name: string, validate: () => void): void {
  try {
    validate()
  } catch (error) {
    if (
      error instanceof Error &&
      ['SIMULATION_EXTERNAL_CHANGE', 'SIMULATION_EXTERNAL_ACTION'].includes(error.message)
    ) throw error
    invalidStage(name)
  }
}

function invalidStage(name: string): never {
  throw new Error(`INVALID_AGENT_RESULT_${name}`)
}

function source(v: unknown) {
  obj(
    v,
    [
      'source_type',
      'source_name',
      'locator',
      'obtained_at',
      'verification_method',
    ],
    ['last_verified_at'],
  )
  if (
    ![
      'crm',
      'database',
      'public_web',
      'api',
      'document',
      'email',
      'message',
      'meeting',
      'user_provided',
      'system_log',
      'derived',
    ].includes(String(v.source_type)) ||
    !str(v.source_name) ||
    !str(v.locator) ||
    !date(v.obtained_at) ||
    !(
      v.last_verified_at === undefined ||
      v.last_verified_at === null ||
      date(v.last_verified_at)
    ) ||
    !str(v.verification_method)
  )
    invalid()
}
function fact(v: unknown) {
  obj(
    v,
    ['fact_id', 'statement', 'source', 'confidence', 'freshness'],
    ['conflicts_with'],
  )
  if (
    !str(v.fact_id) ||
    !str(v.statement) ||
    !confidence(v.confidence) ||
    !['current', 'stale', 'unknown'].includes(String(v.freshness)) ||
    !(
      v.conflicts_with === undefined ||
      array(v.conflicts_with).every((x) => typeof x === 'string')
    )
  )
    invalid()
  source(v.source)
}
function inference(v: unknown) {
  obj(v, [
    'inference_id',
    'statement',
    'based_on_fact_ids',
    'confidence',
    'validation_needed',
  ])
  if (
    !str(v.inference_id) ||
    !str(v.statement) ||
    !array(v.based_on_fact_ids).length ||
    !array(v.based_on_fact_ids).every((x) => typeof x === 'string') ||
    !confidence(v.confidence) ||
    !str(v.validation_needed)
  )
    invalid()
}
function action(v: unknown) {
  obj(
    v,
    [
      'action_id',
      'action_type',
      'tool',
      'started_at',
      'finished_at',
      'outcome',
      'idempotency_key',
      'external',
    ],
    ['approval_id'],
  )
  if (
    !str(v.action_id) ||
    !str(v.action_type) ||
    !str(v.tool) ||
    !date(v.started_at) ||
    !date(v.finished_at) ||
    !['success', 'no_change', 'failed', 'uncertain'].includes(
      String(v.outcome),
    ) ||
    !str(v.idempotency_key, 8) ||
    typeof v.external !== 'boolean' ||
    !(
      v.approval_id === undefined ||
      v.approval_id === null ||
      UUID.test(String(v.approval_id))
    )
  )
    invalid()
  if (v.external) throw new Error('SIMULATION_EXTERNAL_ACTION')
}
function evidence(v: unknown) {
  obj(
    v,
    ['evidence_id', 'kind', 'source', 'content_hash', 'summary', 'confidence'],
    ['artifact_ref'],
  )
  if (
    !str(v.evidence_id) ||
    ![
      'source_capture',
      'query_result',
      'api_response',
      'screenshot',
      'document',
      'receipt',
      'log',
      'calculation',
    ].includes(String(v.kind)) ||
    !/^[0-9a-f]{64}$/.test(String(v.content_hash)) ||
    !str(v.summary) ||
    !confidence(v.confidence) ||
    !(
      v.artifact_ref === undefined ||
      v.artifact_ref === null ||
      typeof v.artifact_ref === 'string'
    )
  )
    invalid()
  source(v.source)
}
function artifact(v: unknown) {
  obj(v, [
    'artifact_id',
    'name',
    'uri',
    'content_hash',
    'version',
    'classification',
  ])
  if (
    !str(v.artifact_id) ||
    !str(v.name) ||
    !str(v.uri) ||
    !/^[0-9a-f]{64}$/.test(String(v.content_hash)) ||
    !str(v.version) ||
    !['public', 'internal', 'confidential', 'restricted'].includes(
      String(v.classification),
    )
  )
    invalid()
}
function cost(v: unknown) {
  obj(v, ['currency', 'llm', 'tools', 'total', 'input_tokens', 'output_tokens'])
  if (
    !/^[A-Z]{3}$/.test(String(v.currency)) ||
    ![v.llm, v.tools, v.total].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
    ) ||
    ![v.input_tokens, v.output_tokens].every(
      (n) => Number.isSafeInteger(n) && Number(n) >= 0,
    )
  )
    invalid()
}
function agentError(v: unknown) {
  obj(v, ['code', 'message', 'recoverable', 'attempts'], ['next_safe_step'])
  if (
    !str(v.code) ||
    !str(v.message) ||
    typeof v.recoverable !== 'boolean' ||
    !Number.isSafeInteger(v.attempts) ||
    Number(v.attempts) < 0 ||
    !(
      v.next_safe_step === undefined ||
      v.next_safe_step === null ||
      typeof v.next_safe_step === 'string'
    )
  )
    invalid()
}
function risk(v: unknown) {
  obj(v, [
    'risk_id',
    'category',
    'description',
    'severity',
    'likelihood',
    'control',
  ])
  if (
    !str(v.risk_id) ||
    ![
      'commercial',
      'privacy',
      'compliance',
      'security',
      'reputation',
      'deliverability',
      'data_quality',
      'cost',
      'runtime',
    ].includes(String(v.category)) ||
    !str(v.description) ||
    !['low', 'medium', 'high', 'critical'].includes(String(v.severity)) ||
    !['low', 'medium', 'high'].includes(String(v.likelihood)) ||
    !str(v.control)
  )
    invalid()
}
function approval(v: unknown) {
  obj(v, [
    'action_hash',
    'action_type',
    'reason',
    'subject',
    'expires_requested_at',
  ])
  if (
    !/^[0-9a-f]{64}$/.test(String(v.action_hash)) ||
    !str(v.action_type) ||
    !str(v.reason) ||
    !str(v.subject) ||
    !date(v.expires_requested_at)
  )
    invalid()
}
function obj(
  v: unknown,
  required: Array<string>,
  optional: Array<string> = [],
): asserts v is Record<string, unknown> {
  if (
    !record(v) ||
    !required.every((k) => Object.hasOwn(v, k)) ||
    !Object.keys(v).every((k) => required.includes(k) || optional.includes(k))
  )
    invalid()
}
function array(v: unknown): Array<unknown> {
  if (!Array.isArray(v)) invalid()
  return v
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function exact(v: Record<string, unknown>, keys: Array<string>): boolean {
  return (
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k))
  )
}
function str(v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max
}
function date(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      v,
    ) &&
    Number.isFinite(Date.parse(v))
  )
}
function confidence(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}
function invalid(): never {
  throw new Error('INVALID_AGENT_RESULT')
}
