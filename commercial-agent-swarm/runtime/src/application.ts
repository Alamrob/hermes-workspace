import { ApprovalError, type ApprovalBroker } from './approvals.js'
import { createHash } from 'node:crypto'
import type {
  ApprovalChannel,
  ApprovalModeCoordinator,
} from './approval-mode.js'
import { hashAction } from './canonical.js'
import { MailPolicyError, type MailService } from './mail.js'
import type { AuditSink } from './observability.js'
import type { RuntimeRepository } from './repository.js'
import { WebhookError, type WebhookService } from './webhook.js'
import {
  AuthenticationError,
  constantTimeSecretEqual,
  requireBearer,
  type WorkOrderAuthConfig,
  verifyWorkOrder,
} from './security.js'
import { ValidationError, validateWorkOrder } from './work-orders.js'
import {
  AssignmentPlanError,
  validateAssignmentPlan,
  type AssignmentPlan,
} from './assignment-plan.js'
import type { DispatchQueuePort } from './dispatch-queue.js'
import type { ShadowDecisionDimension, ShadowDecisionValue } from './shadow-review.js'

export interface ApplicationRequest {
  method: string
  path: string
  headers?: Record<string, string | undefined>
  body?: any
  rawBody?: string | Buffer
}

export interface ApplicationResponse {
  status: number
  body: unknown
}

interface ApplicationOptions {
  repository: RuntimeRepository
  dispatchQueue: Pick<DispatchQueuePort, 'enqueue' | 'getMissionExecution'>
  approvals: ApprovalBroker
  approvalCoordinator: ApprovalModeCoordinator
  mail: MailService
  webhook: WebhookService
  audit: AuditSink
  now?: () => Date
  deployedVersion: string
  a3AdmissionEnabled: boolean
  authentication: {
    workOrders: WorkOrderAuthConfig
    controlPlane: string
    connector: string
    internal: string
    instructionInbox: string
    shadowReview: string
    approvalGateways: Record<
      ApprovalChannel,
      { bearer: string; actors: string[] }
    >
  }
}

export class BrokerApplication {
  private readonly now: () => Date

  constructor(private readonly options: ApplicationOptions) {
    this.now = options.now ?? (() => new Date())
    if (
      constantTimeSecretEqual(
        options.authentication.approvalGateways.sales.bearer,
        options.authentication.approvalGateways.telegram.bearer,
      )
    )
      throw new Error('APPROVAL_GATEWAY_CONFIGURATION_INVALID')
  }

  async handle(request: ApplicationRequest): Promise<ApplicationResponse> {
    const missionId = missionIdFrom(request)
    const route = matchRoute(request.method, request.path)
    if (!route) return { status: 404, body: { error: 'not_found' } }
    if (route.action === 'health') return { status: 200, body: { status: 'ok' } }
    if (route.action === 'ready') {
      try {
        const ready = await this.options.repository.ready()
        return { status: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not_ready' } }
      } catch {
        return { status: 503, body: { error: 'service_unavailable' } }
      }
    }
    const started = this.now()
    try {
      const response = await this.dispatch(route, request)
      await this.audit(request, route.auditAction, missionId, started, response, null)
      return response
    } catch (error) {
      const failure = publicFailure(error)
      await this.audit(
        request,
        route.auditAction,
        missionId,
        started,
        null,
        failure.error,
      )
      return {
        status: failure.status,
        body: failure.issues
          ? { error: failure.error, issues: failure.issues }
          : { error: failure.error },
      }
    }
  }

  private async dispatch(
    route: ReturnType<typeof matchRoute> & {},
    request: ApplicationRequest,
  ): Promise<ApplicationResponse> {
    if (route.action === 'createWorkOrder') {
      const workOrder = validateWorkOrder(request.body)
      requireBearer(request.headers?.authorization, this.options.authentication.controlPlane)
      verifyWorkOrder(workOrder, this.options.authentication.workOrders, this.now())
      if (workOrder.autonomy_level === 'A3' && !this.options.a3AdmissionEnabled)
        throw new AuthenticationError('A3_ADMISSION_DISABLED')
      await this.options.repository.saveMission({
        ...workOrder,
        mission_id: workOrder.mission_id,
        autonomy_level: workOrder.autonomy_level,
        a3_enabled: workOrder.autonomy_level === 'A3',
      })
      return { status: 201, body: { mission_id: workOrder.mission_id, status: 'accepted' } }
    }
    if (route.action === 'getMission') {
      requireBearer(request.headers?.authorization, this.options.authentication.internal)
      const mission = await this.options.repository.getMission(route.id!)
      return mission ? { status: 200, body: redactMission(mission) } : { status: 404, body: { error: 'not_found' } }
    }
    if (route.action === 'createInstructionRequest') {
      requireBearer(
        request.headers?.authorization,
        this.options.authentication.instructionInbox,
      )
      const instruction = validateInstructionRequest(request.body, this.now())
      const result = await this.options.repository.createInstructionRequest({
        ...instruction,
        instruction_sha256: createHash('sha256')
          .update(instruction.instruction, 'utf8')
          .digest('hex'),
        metadata: {
          trust_classification: 'authenticated_user_instruction',
          execution_eligible: false,
          codex_review_required: true,
        },
      })
      return { status: result.created ? 201 : 200, body: result }
    }
    if (route.action === 'getMissionExecution') {
      requireBearer(request.headers?.authorization, this.options.authentication.internal)
      const mission = await this.options.repository.getMission(route.id!)
      if (!mission) return { status: 404, body: { error: 'not_found' } }
      return {
        status: 200,
        body: await this.options.dispatchQueue.getMissionExecution(route.id!),
      }
    }
    if (route.action === 'createAssignments') {
      requireBearer(request.headers?.authorization, this.options.authentication.controlPlane)
      const plan = validateAssignmentPlan(request.body)
      if (plan.mission_id !== route.id)
        throw new ValidationError(['mission_id does not match route'])
      const mission = await this.options.repository.getMission(plan.mission_id)
      if (!mission) return { status: 404, body: { error: 'not_found' } }
      assertInternalExecutionMission(mission, plan.trace_id)
      assertAssignmentPlanAuthority(mission, plan)
      const assignmentIds: string[] = []
      for (const assignment of plan.assignments) {
        assignmentIds.push(await this.options.dispatchQueue.enqueue({
          job_id: assignment.assignment_id,
          mission_id: plan.mission_id,
          trace_id: plan.trace_id,
          idempotency_key: `${plan.plan_version}:${assignment.idempotency_key}`,
          profile_id: assignment.profile_id,
          instruction: assignment.instruction,
          evidence: assignment.evidence,
          dependencies: assignment.depends_on,
          usage_value_reservation_usd: assignment.usage_value_reservation_usd,
          maximum_tokens: assignment.maximum_tokens,
          maximum_api_calls: assignment.maximum_api_calls,
          max_attempts: assignment.max_attempts,
        }))
      }
      return {
        status: 202,
        body: {
          mission_id: plan.mission_id,
          assignment_ids: assignmentIds,
          status: 'queued',
        },
      }
    }
    if (route.action === 'getPortfolioReadModel') {
      requireBearer(request.headers?.authorization, this.options.authentication.internal)
      return { status: 200, body: await this.options.repository.getPortfolioReadModel() }
    }
    if (route.action === 'listShadowReviews') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      return { status: 200, body: await this.options.repository.listShadowReviews() }
    }
    if (route.action === 'getShadowReview') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const review = await this.options.repository.getShadowReview(route.id!)
      return review ? { status: 200, body: review } : { status: 404, body: { error: 'not_found' } }
    }
    if (route.action === 'getShadowReviewGate') {
      requireBearer(request.headers?.authorization, this.options.authentication.internal)
      const review = await this.options.repository.getShadowReview(route.id!)
      if (!review) return { status: 404, body: { error: 'not_found' } }
      const eligible = review.status === 'completed' &&
        review.completedDecisionCount === review.expectedDecisionCount &&
        (review.concordancePercent ?? -1) >= 90 &&
        (review.evidenceCompletenessPercent ?? -1) >= 95 &&
        review.shadowGate === 'passed' && review.productionGate === 'blocked' &&
        review.externalActions === 0
      return {
        status: 200,
        body: {
          review_id: review.id,
          mission_id: review.missionId,
          status: review.status,
          completed_decisions: review.completedDecisionCount,
          expected_decisions: review.expectedDecisionCount,
          concordance_percent: review.concordancePercent,
          evidence_completeness_percent: review.evidenceCompletenessPercent,
          shadow_gate: review.shadowGate,
          production_gate: review.productionGate,
          external_actions: review.externalActions,
          eligible,
          observed_at: review.completedAt ?? review.provenance.observedAt,
        },
      }
    }
    if (route.action === 'recordShadowDecision') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const input = validateShadowDecisionRequest(request.body, route)
      return {
        status: 200,
        body: await this.options.repository.recordShadowDecision({
          ...input,
          reviewId: route.id!,
          accountSlot: route.slot!,
          dimension: route.dimension!,
          requestSha256: hashAction({
            review_id: route.id!, account_slot: route.slot!,
            dimension: route.dimension!, ...input,
          }),
        }),
      }
    }
    if (route.action === 'completeShadowReview') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const input = validateShadowCompletionRequest(request.body)
      return {
        status: 200,
        body: await this.options.repository.completeShadowReview({
          ...input,
          reviewId: route.id!,
          requestSha256: hashAction({ review_id: route.id!, ...input }),
        }),
      }
    }
    if (route.action === 'requestApproval') {
      requireBearer(request.headers?.authorization, this.options.authentication.controlPlane)
      return { status: 201, body: await this.options.approvals.request(request.body) }
    }
    if (route.action === 'decideApproval') {
      const channel = resolveApprovalChannel(
        request.headers?.authorization,
        this.options.authentication.approvalGateways,
      )
      const gateway = this.options.authentication.approvalGateways[channel]
      const decision = validateEvidenceDecision(request.body)
      if (!gateway.actors.includes(decision.actorId))
        throw new AuthenticationError('FORBIDDEN')
      const approval = await this.options.repository.getApprovalRequest(route.id!)
      if (!approval || approval.status !== 'pending')
        throw new ApprovalError('NOT_PENDING')
      return {
        status: 200,
        body: await this.options.approvalCoordinator.submit(
          {
            approvalId: route.id!,
            actionHash: approval.action_hash,
            channel,
            decision: decision.decision,
            actorId: decision.actorId,
            decidedAt: decision.decidedAt,
          },
          decision.expiresAt,
        ),
      }
    }
    if (route.action === 'sendMail') {
      requireBearer(request.headers?.authorization, this.options.authentication.connector)
      return { status: 200, body: await this.options.mail.send(request.body) }
    }
    return {
      status: 202,
      body: await this.options.webhook.ingest({
        mailboxKey: route.id!,
        authorization: request.headers?.authorization,
        rawBody: request.rawBody ?? JSON.stringify(request.body ?? {}),
      }),
    }
  }

  private async audit(
    request: ApplicationRequest,
    toolAction: string,
    missionId: string | null,
    started: Date,
    response: ApplicationResponse | null,
    error: string | null,
  ) {
    const completed = this.now()
    await this.options.audit.record({
      mission_id: missionId,
      agent_id: request.headers?.['x-agent-id'] ?? 'commercial-broker',
      tool_action: toolAction,
      started_at: started.toISOString(),
      completed_at: completed.toISOString(),
      duration_ms: Math.max(0, completed.getTime() - started.getTime()),
      token_cost: { input_tokens: 0, output_tokens: 0, currency: 'USD', amount: 0 },
      redacted_input: `sha256:${hashAction({ method: request.method, path: request.path })}`,
      result: response ? `status:${response.status}` : null,
      error,
      retries: 0,
      external_action: toolAction === 'mail.send',
      approval_reference: approvalReference(request, response),
      receipt_reference: responseReference(response, 'receipt_id'),
      evidence: [],
      state_changes: response ? [toolAction] : [],
      deployed_version: this.options.deployedVersion,
    })
  }
}

function approvalReference(request: ApplicationRequest, response: ApplicationResponse | null): string | null {
  return responseReference(response, 'approval_reference') ??
    responseReference(response, 'approval_id') ??
    /^\/v1\/approvals\/([^/]+)\/decision$/.exec(request.path)?.[1] ??
    null
}

function responseReference(response: ApplicationResponse | null, field: string): string | null {
  if (!response || response.body === null || typeof response.body !== 'object' || Array.isArray(response.body)) return null
  const value = (response.body as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : null
}

type Route = {
  action: string
  auditAction: string
  id?: string
  channel?: ApprovalChannel
  slot?: number
  dimension?: ShadowDecisionDimension
}

function matchRoute(method: string, path: string): Route | null {
  if (method === 'GET' && path === '/healthz') return { action: 'health', auditAction: 'health' }
  if (method === 'GET' && path === '/readyz') return { action: 'ready', auditAction: 'ready' }
  if (method === 'GET' && path === '/internal/v1/read-model/portfolio')
    return { action: 'getPortfolioReadModel', auditAction: 'read_model.portfolio' }
  if (method === 'GET' && path === '/internal/v1/shadow-reviews')
    return { action: 'listShadowReviews', auditAction: 'shadow_review.list' }
  const shadowReview = /^\/internal\/v1\/shadow-reviews\/([^/]+)$/.exec(path)
  if (method === 'GET' && shadowReview)
    return { action: 'getShadowReview', auditAction: 'shadow_review.get', id: shadowReview[1] }
  const shadowGate = /^\/internal\/v1\/shadow-gates\/([^/]+)$/.exec(path)
  if (method === 'GET' && shadowGate)
    return { action: 'getShadowReviewGate', auditAction: 'shadow_review.gate.get', id: shadowGate[1] }
  const shadowDecision = /^\/internal\/v1\/shadow-reviews\/([^/]+)\/decisions\/(\d+)\/(icp_fit|evidence_sufficiency|outreach_eligibility)$/.exec(path)
  if (method === 'PUT' && shadowDecision)
    return {
      action: 'recordShadowDecision',
      auditAction: 'shadow_review.decision.record',
      id: shadowDecision[1],
      slot: Number(shadowDecision[2]),
      dimension: shadowDecision[3] as ShadowDecisionDimension,
    }
  const shadowComplete = /^\/internal\/v1\/shadow-reviews\/([^/]+)\/complete$/.exec(path)
  if (method === 'POST' && shadowComplete)
    return { action: 'completeShadowReview', auditAction: 'shadow_review.complete', id: shadowComplete[1] }
  if (method === 'POST' && path === '/v1/work-orders') return { action: 'createWorkOrder', auditAction: 'work_order.create' }
  if (method === 'POST' && path === '/v1/instruction-requests')
    return { action: 'createInstructionRequest', auditAction: 'instruction_request.create' }
  if (method === 'POST' && path === '/v1/approvals/requests') return { action: 'requestApproval', auditAction: 'approval.request' }
  if (method === 'POST' && path === '/v1/mail/send') return { action: 'sendMail', auditAction: 'mail.send' }
  const mission = /^\/v1\/missions\/([^/]+)$/.exec(path)
  if (method === 'GET' && mission) return { action: 'getMission', auditAction: 'mission.get', id: mission[1] }
  const assignments = /^\/v1\/missions\/([^/]+)\/assignments$/.exec(path)
  if (method === 'POST' && assignments)
    return {
      action: 'createAssignments',
      auditAction: 'assignment_plan.create',
      id: assignments[1],
    }
  const execution = /^\/internal\/v1\/missions\/([^/]+)\/execution$/.exec(path)
  if (method === 'GET' && execution)
    return {
      action: 'getMissionExecution',
      auditAction: 'mission.execution.get',
      id: execution[1],
    }
  const decision = /^\/v1\/approvals\/([^/]+)\/decision$/.exec(path)
  if (method === 'POST' && decision)
    return {
      action: 'decideApproval',
      auditAction: 'approval.decision',
      id: decision[1],
    }
  const webhook = /^\/webhooks\/hostinger-mail\/([^/]+)$/.exec(path)
  if (method === 'POST' && webhook) return { action: 'webhook', auditAction: 'webhook.ingest', id: webhook[1] }
  return null
}

function missionIdFrom(request: ApplicationRequest): string | null {
  return request.body?.mission_id ?? request.body?.action?.mission_id ?? /^\/v1\/missions\/([^/]+)$/.exec(request.path)?.[1] ?? null
}

function redactMission(mission: Record<string, unknown>): Record<string, unknown> {
  const { authority: _authority, approval_token: _approvalToken, business_context: _context, ...safe } = mission
  return safe
}

function assertInternalExecutionMission(
  mission: Record<string, unknown>,
  traceId: string,
): void {
  const contact = mission.contact_policy
  const channels = mission.approved_channels
  const prohibited = mission.prohibited_actions
  const requiredProhibitions = [
    'mail.send',
    'message.send',
    'campaign.activate',
    'crm.write',
    'price.change',
    'proposal.send',
    'contract.commit',
  ]
  if (
    !['A0', 'A1', 'A2'].includes(String(mission.autonomy_level)) ||
    mission.project_id !== 'proptimiza' ||
    mission.trace_id !== traceId ||
    mission.dry_run !== true ||
    !Array.isArray(channels) ||
    channels.some((channel) => !['none', 'internal', 'public_web'].includes(String(channel))) ||
    contact === null ||
    typeof contact !== 'object' ||
    Array.isArray(contact) ||
    (contact as Record<string, unknown>).contact_permitted !== false ||
    !Array.isArray(prohibited) ||
    requiredProhibitions.some((action) => !prohibited.includes(action))
  )
    throw new AuthenticationError('INTERNAL_EXECUTION_POLICY_REQUIRED')
}

const PROFILE_CAPABILITIES = {
  'sales-orchestrator': {
    tools: ['hermes.analysis'],
    actions: ['analysis.internal'],
    channels: ['internal'],
    research: false,
  },
  'market-account-intelligence': {
    tools: ['hermes.analysis', 'hermes.web'],
    actions: ['analysis.internal', 'research.public.read'],
    channels: ['internal', 'public_web'],
    research: true,
  },
  'contact-data-steward': {
    tools: ['hermes.analysis', 'hermes.web'],
    actions: ['analysis.internal', 'research.public.read'],
    channels: ['internal', 'public_web'],
    research: true,
  },
  'qualification-prioritization': {
    tools: ['hermes.analysis'],
    actions: ['analysis.internal'],
    channels: ['internal'],
    research: false,
  },
  'outreach-draft-manager': {
    tools: ['hermes.analysis', 'hermes.file.ephemeral'],
    actions: ['analysis.internal', 'artifact.prepare'],
    channels: ['internal'],
    research: false,
  },
  'commercial-qa-compliance': {
    tools: ['hermes.analysis'],
    actions: ['analysis.internal'],
    channels: ['internal'],
    research: false,
  },
} as const

export function assertAssignmentPlanAuthority(
  mission: Record<string, unknown>,
  plan: AssignmentPlan,
): void {
  const tools = stringSet(mission.approved_tools)
  const actions = stringSet(mission.allowed_actions)
  const channels = stringSet(mission.approved_channels)
  const budget = mission.budget_limit
  if (!tools || !actions || !channels)
    throw new AuthenticationError('ASSIGNMENT_TOOL_POLICY_REQUIRED')
  if (
    budget === null ||
    typeof budget !== 'object' ||
    Array.isArray(budget) ||
    (budget as Record<string, unknown>).currency !== 'USD' ||
    typeof (budget as Record<string, unknown>).maximum !== 'number' ||
    !Number.isFinite((budget as Record<string, unknown>).maximum)
  )
    throw new AuthenticationError('ASSIGNMENT_BUDGET_POLICY_REQUIRED')
  const missionMicrodollars = Math.round(
    Number((budget as Record<string, unknown>).maximum) * 1_000_000,
  )
  const reservedMicrodollars = plan.assignments.reduce(
    (total, assignment) =>
      total + Math.round(assignment.usage_value_reservation_usd * 1_000_000),
    0,
  )
  if (reservedMicrodollars > missionMicrodollars)
    throw new AuthenticationError('ASSIGNMENT_BUDGET_POLICY_REQUIRED')
  for (const assignment of plan.assignments) {
    const capability = PROFILE_CAPABILITIES[assignment.profile_id]
    if (
      capability.tools.some((item) => !tools.has(item)) ||
      capability.actions.some((item) => !actions.has(item)) ||
      capability.channels.some((item) => !channels.has(item)) ||
      (capability.research && !['A1', 'A2'].includes(String(mission.autonomy_level)))
    )
      throw new AuthenticationError('ASSIGNMENT_TOOL_POLICY_REQUIRED')
  }
}

function stringSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    return null
  return new Set(value as string[])
}

function validateEvidenceDecision(value: unknown): {
  decision: 'approved' | 'denied'
  actorId: string
  decidedAt: string
  expiresAt: string
} {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    throw new ValidationError(['approval decision must be an object'])
  const record = value as Record<string, unknown>
  const allowed = new Set([
    'decision',
    'actor_id',
    'decided_at',
    'expires_at',
  ])
  if (
    Object.keys(record).some((field) => !allowed.has(field)) ||
    (record.decision !== 'approved' && record.decision !== 'denied') ||
    typeof record.actor_id !== 'string' ||
    !/^[A-Za-z0-9._:@-]{1,128}$/.test(record.actor_id) ||
    typeof record.decided_at !== 'string' ||
    !Number.isFinite(Date.parse(record.decided_at)) ||
    typeof record.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(record.expires_at))
  )
    throw new ValidationError(['approval decision is invalid'])
  return {
    decision: record.decision,
    actorId: record.actor_id,
    decidedAt: new Date(record.decided_at).toISOString(),
    expiresAt: new Date(record.expires_at).toISOString(),
  }
}

function validateInstructionRequest(
  value: unknown,
  now: Date,
): {
  request_id: string
  idempotency_key: string
  project_id: 'proptimiza'
  title: string
  instruction: string
  requested_by: string
  source: 'workspace' | 'sales'
  autonomy_ceiling: 'A0' | 'A1' | 'A2'
  created_at: string
  expires_at: string
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(['instruction request must be an object'])
  const record = value as Record<string, unknown>
  const allowed = new Set([
    'request_id','idempotency_key','project_id','title','instruction',
    'requested_by','source','autonomy_ceiling','created_at','expires_at',
    'requires_codex_review','external_actions_allowed',
  ])
  const requestId = string(record.request_id)
  const idempotencyKey = string(record.idempotency_key)
  const title = string(record.title).trim()
  const instruction = string(record.instruction).trim()
  const requestedBy = string(record.requested_by)
  const created = Date.parse(string(record.created_at))
  const expires = Date.parse(string(record.expires_at))
  const secretPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|oc_sk)-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~-]{20,}/i
  if (
    Object.keys(record).some((field) => !allowed.has(field)) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey) ||
    record.project_id !== 'proptimiza' ||
    title.length < 1 || title.length > 160 || /[\u0000-\u001f\u007f]/.test(title) ||
    instruction.length < 1 || instruction.length > 8_000 || secretPattern.test(instruction) ||
    !/^[A-Za-z0-9._:@+-]{3,254}$/.test(requestedBy) ||
    (record.source !== 'workspace' && record.source !== 'sales') ||
    !['A0','A1','A2'].includes(string(record.autonomy_ceiling)) ||
    !Number.isFinite(created) || !Number.isFinite(expires) ||
    created < now.getTime() - 86_400_000 || created > now.getTime() + 300_000 ||
    expires <= created || expires > created + 30 * 86_400_000 ||
    record.requires_codex_review !== true ||
    record.external_actions_allowed !== false
  )
    throw new ValidationError(['instruction request is invalid'])
  return {
    request_id: requestId,
    idempotency_key: idempotencyKey,
    project_id: 'proptimiza',
    title,
    instruction,
    requested_by: requestedBy,
    source: record.source,
    autonomy_ceiling: record.autonomy_ceiling as 'A0' | 'A1' | 'A2',
    created_at: new Date(created).toISOString(),
    expires_at: new Date(expires).toISOString(),
  }
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function validateShadowDecisionRequest(
  value: unknown,
  route: { slot?: number; dimension?: ShadowDecisionDimension },
): {
  humanValue: ShadowDecisionValue
  rationale: string
  evidenceUrl: string
  expectedVersion: number
  actorId: string
  idempotencyKey: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(['shadow decision must be an object'])
  const record = value as Record<string, unknown>
  const allowed = new Set(['human_value','rationale','evidence_url','expected_version','actor_id','idempotency_key'])
  const dimension = route.dimension
  const humanValue = string(record.human_value)
  let evidenceUrl: URL
  try { evidenceUrl = new URL(string(record.evidence_url)) }
  catch { throw new ValidationError(['shadow decision is invalid']) }
  const valueAllowed = dimension === 'icp_fit'
    ? ['yes','no','unknown'].includes(humanValue)
    : dimension === 'evidence_sufficiency'
      ? ['sufficient','insufficient'].includes(humanValue)
      : ['yes','no'].includes(humanValue)
  if (
    Object.keys(record).some((field) => !allowed.has(field)) ||
    !Number.isSafeInteger(route.slot) || route.slot! < 1 || route.slot! > 10 ||
    !valueAllowed || string(record.rationale).trim().length < 3 ||
    string(record.rationale).trim().length > 1000 || evidenceUrl.protocol !== 'https:' ||
    !Number.isSafeInteger(record.expected_version) || Number(record.expected_version) < 0 ||
    !/^[A-Za-z0-9._:@+-]{3,254}$/.test(string(record.actor_id)) ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(string(record.idempotency_key))
  ) throw new ValidationError(['shadow decision is invalid'])
  return {
    humanValue: humanValue as ShadowDecisionValue,
    rationale: string(record.rationale).trim(),
    evidenceUrl: evidenceUrl.toString(),
    expectedVersion: Number(record.expected_version),
    actorId: string(record.actor_id),
    idempotencyKey: string(record.idempotency_key),
  }
}

function validateShadowCompletionRequest(value: unknown): {
  expectedVersion: number
  actorId: string
  idempotencyKey: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(['shadow completion must be an object'])
  const record = value as Record<string, unknown>
  const allowed = new Set(['expected_version','actor_id','idempotency_key'])
  if (Object.keys(record).some((field) => !allowed.has(field)) ||
      !Number.isSafeInteger(record.expected_version) || Number(record.expected_version) < 0 ||
      !/^[A-Za-z0-9._:@+-]{3,254}$/.test(string(record.actor_id)) ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(string(record.idempotency_key)))
    throw new ValidationError(['shadow completion is invalid'])
  return {
    expectedVersion: Number(record.expected_version),
    actorId: string(record.actor_id),
    idempotencyKey: string(record.idempotency_key),
  }
}

function resolveApprovalChannel(
  authorization: string | undefined,
  gateways: Record<ApprovalChannel, { bearer: string; actors: string[] }>,
): ApprovalChannel {
  const provided = authorization?.match(/^Bearer ([^\s]+)$/)?.[1] ?? ''
  const sales = constantTimeSecretEqual(provided, gateways.sales.bearer)
  const telegram = constantTimeSecretEqual(provided, gateways.telegram.bearer)
  if (sales === telegram) throw new AuthenticationError('UNAUTHORIZED')
  return sales ? 'sales' : 'telegram'
}

function publicFailure(error: unknown): {
  status: 400 | 401 | 403 | 409 | 500 | 503
  error: string
  issues?: string[]
} {
  if (error instanceof ValidationError || error instanceof AssignmentPlanError)
    return { status: 400, error: 'invalid_request', issues: error.issues }
  if (error instanceof AuthenticationError) {
    if (error.code === 'UNAUTHORIZED')
      return { status: 401, error: 'unauthorized' }
    const allowed = new Set([
      'INVALID_AUTHORITY',
      'INVALID_PROJECT',
      'AUTHORITY_NOT_YET_VALID',
      'EXPIRED_AUTHORITY',
      'INVALID_SIGNATURE',
      'FORBIDDEN',
      'A3_ADMISSION_DISABLED',
      'INTERNAL_EXECUTION_POLICY_REQUIRED',
    ])
    return {
      status: 403,
      error: allowed.has(error.code) ? error.code : 'forbidden',
    }
  }
  if (error instanceof ApprovalError) {
    if (error.code === 'INVALID_ACTION' || error.code === 'INVALID_TTL')
      return { status: 400, error: error.code }
    if (error.code === 'NOT_PENDING' || error.code === 'REPLAYED')
      return { status: 409, error: error.code }
    const allowed = new Set([
      'TOKEN_REQUIRED',
      'INVALID_SIGNATURE',
      'CONTENT_MISMATCH',
      'EXPIRED',
      'KILL_SWITCH_ACTIVE',
      'MALFORMED_TOKEN',
    ])
    return {
      status: 403,
      error: allowed.has(error.code) ? error.code : 'forbidden',
    }
  }
  if (error instanceof MailPolicyError)
    return { status: 403, error: error.code }
  if (error instanceof WebhookError) {
    if (['PAYLOAD_TOO_LARGE', 'INVALID_JSON', 'INVALID_PAYLOAD'].includes(error.code))
      return { status: 400, error: error.code }
    return { status: 403, error: 'forbidden' }
  }
  if (
    error instanceof Error &&
    ['IDEMPOTENCY_CONFLICT', 'INSTRUCTION_IDEMPOTENCY_CONFLICT', 'EXECUTION_IN_PROGRESS', 'APPROVAL_GRANT_CONFLICT', 'SHADOW_REVIEW_IDEMPOTENCY_CONFLICT', 'SHADOW_REVIEW_VERSION_CONFLICT', 'SHADOW_REVIEW_NOT_OPEN'].includes(
      error.message,
    )
  )
    return { status: 409, error: error.message }
  if (
    error instanceof Error &&
    ['SHADOW_REVIEW_DECISION_INVALID','SHADOW_REVIEW_COMPLETION_INVALID','SHADOW_REVIEW_INCOMPLETE','SHADOW_REVIEW_DECISION_NOT_FOUND'].includes(error.message)
  )
    return { status: 400, error: error.message }
  return { status: 500, error: 'internal_error' }
}
