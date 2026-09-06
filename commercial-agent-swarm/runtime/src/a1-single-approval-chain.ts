import { createHash } from 'node:crypto'
import { validateAssignmentPlan, type AssignmentPlan } from './assignment-plan.js'
import { hashAction } from './canonical.js'

export const A1_SINGLE_APPROVAL_PROFILES = Object.freeze([
  'sales-orchestrator',
  'market-account-intelligence',
  'contact-data-steward',
  'qualification-prioritization',
  'outreach-draft-manager',
  'commercial-qa-compliance',
] as const)

export const A1_SINGLE_APPROVAL_STAGES = Object.freeze([
  'consume_parent_authorization',
  'register_assignment_plan_authorization',
  'register_enqueue_authorization',
  'materialize_exact_job_set',
  'register_execution_authorization',
  'create_execution_arm',
  'open_execution_window',
  'dispatch_bounded_dag',
  'recontain_execution_window',
  'audit_terminal_state',
] as const)

export interface A1SingleApprovalGuardrails {
  single_human_approval: true
  derived_internal_subgates_only: true
  exact_dag_only: true
  no_retry_on_uncertain: true
  automatic_recontainment_required: true
  manual_dispatch_required: true
  arbitrary_web_research_allowed: false
  provider_api_allowed_within_budget: true
  maximum_external_actions: 0
  contact_permitted: false
  crm_writes: 0
  a3_blocked: true
  mail_blocked: true
  telegram_blocked: true
  active_channel_kill_switches_required: 7
  timer_must_remain_disabled: true
}

export interface A1SingleApprovalChainRequest {
  schema_version: 1
  type: 'a1_single_approval_chain_request_r302'
  status: 'authorization_required_not_approved'
  requested_by: 'auditor:codex-local'
  prepared_at: string
  expires_at: string
  mission_id: string
  trace_id: string
  plan_version: string
  signed_work_order_sha256: string
  expected_mission_sha256: string
  assignment_plan_sha256: string
  job_set_sha256: string
  assignment_count: 6
  assignment_ids: string[]
  assignment_plan: AssignmentPlan
  worker_id: 'broker-dispatcher-1'
  maximum_dispatch_ticks: 6
  maximum_provider_credit_spend_usd: number
  stages: string[]
  guardrails: A1SingleApprovalGuardrails
  request_id: string
  authorization_digest_sha256: string
  required_authorization_text_sha256: string
  authorization_granted: false
  chain_executed: false
  provider_credit_spend_allowed: false
  external_actions: 0
  crm_writes: 0
}

export interface A1SingleApprovalChainAuthorization {
  schema_version: 1
  type: 'a1_single_approval_chain_authorization_r303'
  request_id: string
  authorization_digest_sha256: string
  mission_id: string
  trace_id: string
  assignment_plan_sha256: string
  job_set_sha256: string
  assignment_ids: string[]
  worker_id: 'broker-dispatcher-1'
  maximum_dispatch_ticks: 6
  maximum_provider_credit_spend_usd: number
  decision: 'approved'
  rationale: typeof SINGLE_APPROVAL_RATIONALE
  reviewer_id: 'user:proptimizaspa@gmail.com'
  reviewer_email: 'proptimizaspa@gmail.com'
  reviewed_at: string
  expires_at: string
  user_authorization_sha256: string
  stage_receipt_keys: Record<(typeof A1_SINGLE_APPROVAL_STAGES)[number], string>
  authorization_granted: true
  chain_executed: false
  provider_credit_spend_allowed: false
  external_actions: 0
  crm_writes: 0
  next_required_gate: 'execute_exact_chain_once'
}

export class A1SingleApprovalChainError extends Error {
  constructor(readonly code: string) { super(code) }
}

const SINGLE_APPROVAL_RATIONALE = 'Autoriza una sola cadena A1 interna y exacta; los subgates son derivados, auditables y no amplían su alcance.' as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/
const WORKER = /^[A-Za-z0-9._:-]{3,128}$/

const EXPECTED_GUARDRAILS: A1SingleApprovalGuardrails = Object.freeze({
  single_human_approval: true,
  derived_internal_subgates_only: true,
  exact_dag_only: true,
  no_retry_on_uncertain: true,
  automatic_recontainment_required: true,
  manual_dispatch_required: true,
  arbitrary_web_research_allowed: false,
  provider_api_allowed_within_budget: true,
  maximum_external_actions: 0,
  contact_permitted: false,
  crm_writes: 0,
  a3_blocked: true,
  mail_blocked: true,
  telegram_blocked: true,
  active_channel_kill_switches_required: 7,
  timer_must_remain_disabled: true,
})

export function requiredA1SingleApprovalAuthorizationBytes(request: A1SingleApprovalChainRequest): Buffer {
  return Buffer.from(
    `Autorizo ejecutar una sola cadena A1 interna para la misión \`${request.mission_id}\`, plan \`${request.assignment_plan_sha256}\`, job set \`${request.job_set_sha256}\`, solicitud \`${request.request_id}\` y digest \`${request.authorization_digest_sha256}\`, vigente únicamente hasta \`${request.expires_at}\`. Autorizo procesar exactamente ${request.assignment_count} asignaciones en el DAG fijado, con hasta ${request.maximum_dispatch_ticks} ticks manuales deterministas y un presupuesto máximo de proveedor de USD ${request.maximum_provider_credit_spend_usd.toFixed(6)}. No autorizo investigación web, contacto, CRM, A3, correo, Telegram ni otras acciones externas; el timer permanece apagado, los siete bloqueos de canal permanecen activos y la ventana debe recontenerse automáticamente.\n`,
    'utf8',
  )
}

export function validateA1SingleApprovalChainRequest(
  value: unknown,
  now = new Date(),
  requireUnexpired = true,
): A1SingleApprovalChainRequest {
  try {
    const input = object(value)
    exactKeys(input, [
      'schema_version', 'type', 'status', 'requested_by', 'prepared_at', 'expires_at',
      'mission_id', 'trace_id', 'plan_version', 'signed_work_order_sha256',
      'expected_mission_sha256', 'assignment_plan_sha256', 'job_set_sha256',
      'assignment_count', 'assignment_ids', 'assignment_plan', 'worker_id',
      'maximum_dispatch_ticks', 'maximum_provider_credit_spend_usd', 'stages', 'guardrails',
      'request_id', 'authorization_digest_sha256', 'required_authorization_text_sha256',
      'authorization_granted', 'chain_executed', 'provider_credit_spend_allowed',
      'external_actions', 'crm_writes',
    ])
    const plan = validateFullSwarmPlan(input.assignment_plan)
    const preparedAt = exactIso(input.prepared_at)
    const expiresAt = exactIso(input.expires_at)
    const assignmentIds = strings(input.assignment_ids)
    const stages = strings(input.stages)
    const budget = input.maximum_provider_credit_spend_usd
    if (
      input.schema_version !== 1 || input.type !== 'a1_single_approval_chain_request_r302' ||
      input.status !== 'authorization_required_not_approved' || input.requested_by !== 'auditor:codex-local' ||
      input.mission_id !== plan.mission_id || input.trace_id !== plan.trace_id || input.plan_version !== plan.plan_version ||
      !UUID.test(text(input.mission_id)) || !UUID.test(text(input.trace_id)) || !UUID.test(text(input.request_id)) ||
      !WORKER.test(text(input.worker_id)) || input.worker_id !== 'broker-dispatcher-1' ||
      input.assignment_count !== 6 || input.maximum_dispatch_ticks !== 6 ||
      typeof budget !== 'number' || !Number.isFinite(budget) ||
      assignmentIds.join('\0') !== plan.assignments.map((item) => item.assignment_id).join('\0') ||
      stages.join('\0') !== A1_SINGLE_APPROVAL_STAGES.join('\0') ||
      input.assignment_plan_sha256 !== hashAction(plan) || input.job_set_sha256 !== hashJobSet(plan) ||
      Math.round(budget * 1_000_000) !== Math.round(planBudget(plan) * 1_000_000) ||
      budget < 0.06 || budget > 0.5 ||
      expiresAt.getTime() <= preparedAt.getTime() + 120_000 ||
      expiresAt.getTime() > preparedAt.getTime() + 30 * 60_000 ||
      (requireUnexpired && expiresAt.getTime() <= now.getTime())
    ) throw new Error('request')
    for (const field of [
      'signed_work_order_sha256', 'expected_mission_sha256', 'assignment_plan_sha256',
      'job_set_sha256', 'authorization_digest_sha256', 'required_authorization_text_sha256',
    ]) if (!SHA256.test(text(input[field]))) throw new Error(`sha:${field}`)
    validateGuardrails(input.guardrails)
    if (
      input.authorization_granted !== false || input.chain_executed !== false ||
      input.provider_credit_spend_allowed !== false || input.external_actions !== 0 || input.crm_writes !== 0
    ) throw new Error('not inert')
    const {
      request_id: _requestId,
      authorization_digest_sha256: _authorizationDigest,
      required_authorization_text_sha256: _authorizationTextDigest,
      authorization_granted: _authorizationGranted,
      chain_executed: _chainExecuted,
      provider_credit_spend_allowed: _providerSpend,
      external_actions: _externalActions,
      crm_writes: _crmWrites,
      ...core
    } = input
    if (
      hashAction(core) !== input.authorization_digest_sha256 ||
      uuidFromDigest(text(input.authorization_digest_sha256)) !== input.request_id
    ) throw new Error('digest')
    const request = structuredClone(input) as unknown as A1SingleApprovalChainRequest
    if (sha256(requiredA1SingleApprovalAuthorizationBytes(request)) !== input.required_authorization_text_sha256)
      throw new Error('authorization text')
    return request
  } catch (error) {
    if (error instanceof A1SingleApprovalChainError) throw error
    throw new A1SingleApprovalChainError('A1_SINGLE_APPROVAL_CHAIN_REQUEST_INVALID')
  }
}

export function validateA1SingleApprovalChainAuthorization(
  value: unknown,
  requestValue: unknown,
  authorizationBytes: Buffer,
  now = new Date(),
): A1SingleApprovalChainAuthorization {
  try {
    const request = validateA1SingleApprovalChainRequest(requestValue, now)
    const input = object(value)
    exactKeys(input, [
      'schema_version', 'type', 'request_id', 'authorization_digest_sha256', 'mission_id',
      'trace_id', 'assignment_plan_sha256', 'job_set_sha256', 'assignment_ids', 'worker_id',
      'maximum_dispatch_ticks', 'maximum_provider_credit_spend_usd', 'decision', 'rationale',
      'reviewer_id', 'reviewer_email', 'reviewed_at', 'expires_at', 'user_authorization_sha256',
      'stage_receipt_keys', 'authorization_granted', 'chain_executed',
      'provider_credit_spend_allowed', 'external_actions', 'crm_writes', 'next_required_gate',
    ])
    const bindingFields: Array<keyof A1SingleApprovalChainRequest> = [
      'request_id', 'authorization_digest_sha256', 'mission_id', 'trace_id',
      'assignment_plan_sha256', 'job_set_sha256', 'worker_id', 'maximum_dispatch_ticks',
      'maximum_provider_credit_spend_usd', 'expires_at',
    ]
    for (const field of bindingFields) {
      if (input[field] !== request[field]) throw new Error(`binding:${field}`)
    }
    if (strings(input.assignment_ids).join('\0') !== request.assignment_ids.join('\0')) throw new Error('assignment binding')
    const reviewedAt = exactIso(input.reviewed_at)
    if (
      input.schema_version !== 1 || input.type !== 'a1_single_approval_chain_authorization_r303' ||
      input.decision !== 'approved' || input.rationale !== SINGLE_APPROVAL_RATIONALE ||
      input.reviewer_id !== 'user:proptimizaspa@gmail.com' || input.reviewer_email !== 'proptimizaspa@gmail.com' ||
      input.authorization_granted !== true || input.chain_executed !== false ||
      input.provider_credit_spend_allowed !== false || input.external_actions !== 0 || input.crm_writes !== 0 ||
      input.next_required_gate !== 'execute_exact_chain_once' ||
      Math.abs(reviewedAt.getTime() - now.getTime()) > 5 * 60_000 ||
      reviewedAt.getTime() >= Date.parse(request.expires_at)
    ) throw new Error('authorization')
    const expectedBytes = requiredA1SingleApprovalAuthorizationBytes(request)
    if (!Buffer.isBuffer(authorizationBytes) || !authorizationBytes.equals(expectedBytes)) throw new Error('bytes')
    const authorizationSha256 = sha256(authorizationBytes)
    if (input.user_authorization_sha256 !== authorizationSha256) throw new Error('authorization sha')
    const receipts = object(input.stage_receipt_keys)
    exactKeys(receipts, A1_SINGLE_APPROVAL_STAGES)
    for (const stage of A1_SINGLE_APPROVAL_STAGES) {
      if (receipts[stage] !== hashAction({
        authorization_sha256: authorizationSha256,
        chain_digest_sha256: request.authorization_digest_sha256,
        stage,
      })) throw new Error(`receipt:${stage}`)
    }
    return structuredClone(input) as unknown as A1SingleApprovalChainAuthorization
  } catch (error) {
    if (error instanceof A1SingleApprovalChainError) throw error
    throw new A1SingleApprovalChainError('A1_SINGLE_APPROVAL_CHAIN_AUTHORIZATION_INVALID')
  }
}

function validateFullSwarmPlan(value: unknown): AssignmentPlan {
  const plan = validateAssignmentPlan(value)
  if (plan.assignments.length !== A1_SINGLE_APPROVAL_PROFILES.length)
    throw new Error('full swarm')
  for (let index = 0; index < plan.assignments.length; index += 1) {
    const assignment = plan.assignments[index]
    const expectedDependencies = index === 0 ? [] : [plan.assignments[index - 1].assignment_id]
    if (
      assignment.profile_id !== A1_SINGLE_APPROVAL_PROFILES[index] ||
      assignment.depends_on.join('\0') !== expectedDependencies.join('\0') ||
      assignment.max_attempts !== 1
    ) throw new Error(`dag:${index}`)
  }
  return plan
}

function validateGuardrails(value: unknown): void {
  const input = object(value)
  exactKeys(input, Object.keys(EXPECTED_GUARDRAILS))
  for (const [key, expected] of Object.entries(EXPECTED_GUARDRAILS))
    if (input[key] !== expected) throw new Error(`guardrail:${key}`)
}

function planBudget(plan: AssignmentPlan): number {
  return plan.assignments.reduce(
    (total, item) => total + Math.round(item.usage_value_reservation_usd * 1_000_000),
    0,
  ) / 1_000_000
}

function hashJobSet(plan: AssignmentPlan): string {
  return hashAction({ mission_id: plan.mission_id, assignment_ids: plan.assignments.map((item) => item.assignment_id) })
}

function uuidFromDigest(value: string): string {
  const chars = value.slice(0, 32).split('')
  chars[12] = '5'
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4]
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function exactIso(value: unknown): Date {
  if (typeof value !== 'string') throw new Error('date')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error('date')
  return date
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('strings')
  return value
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error('keys')
}
