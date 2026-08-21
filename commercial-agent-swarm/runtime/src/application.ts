import { ApprovalError, type ApprovalBroker } from './approvals.js'
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
import { AssignmentPlanError, validateAssignmentPlan } from './assignment-plan.js'
import type { DispatchQueuePort } from './dispatch-queue.js'

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
}

function matchRoute(method: string, path: string): Route | null {
  if (method === 'GET' && path === '/healthz') return { action: 'health', auditAction: 'health' }
  if (method === 'GET' && path === '/readyz') return { action: 'ready', auditAction: 'ready' }
  if (method === 'GET' && path === '/internal/v1/read-model/portfolio')
    return { action: 'getPortfolioReadModel', auditAction: 'read_model.portfolio' }
  if (method === 'POST' && path === '/v1/work-orders') return { action: 'createWorkOrder', auditAction: 'work_order.create' }
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
    ['IDEMPOTENCY_CONFLICT', 'EXECUTION_IN_PROGRESS', 'APPROVAL_GRANT_CONFLICT'].includes(
      error.message,
    )
  )
    return { status: 409, error: error.message }
  return { status: 500, error: 'internal_error' }
}
