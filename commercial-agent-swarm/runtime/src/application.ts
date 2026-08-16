import type { ApprovalBroker } from './approvals.js'
import { hashAction } from './canonical.js'
import type { MailService } from './mail.js'
import type { AuditSink } from './observability.js'
import type { RuntimeRepository } from './repository.js'
import type { WebhookService } from './webhook.js'
import { AuthenticationError, requireBearer, type WorkOrderAuthConfig, verifyWorkOrder } from './security.js'
import { ValidationError, validateWorkOrder } from './work-orders.js'

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
  approvals: ApprovalBroker
  mail: MailService
  webhook: WebhookService
  audit: AuditSink
  now?: () => Date
  deployedVersion: string
  authentication: {
    workOrders: WorkOrderAuthConfig
    controlPlane: string
    approvalGateway: string
    connector: string
    internal: string
    approvers: string[]
  }
}

export class BrokerApplication {
  private readonly now: () => Date

  constructor(private readonly options: ApplicationOptions) {
    this.now = options.now ?? (() => new Date())
  }

  async handle(request: ApplicationRequest): Promise<ApplicationResponse> {
    const missionId = missionIdFrom(request)
    const route = matchRoute(request.method, request.path)
    if (!route) return { status: 404, body: { error: 'not_found' } }
    if (route.action === 'health') return { status: 200, body: { status: 'ok' } }
    if (route.action === 'ready') {
      const ready = await this.options.repository.ready()
      return { status: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not_ready' } }
    }
    const started = this.now()
    try {
      const response = await this.dispatch(route, request)
      await this.audit(request, route.auditAction, missionId, started, response, null)
      return response
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error'
      await this.audit(request, route.auditAction, missionId, started, null, message)
      return {
        status: error instanceof ValidationError ? 400 : 403,
        body: { error: message, issues: error instanceof ValidationError ? error.issues : undefined },
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
    if (route.action === 'requestApproval') {
      requireBearer(request.headers?.authorization, this.options.authentication.controlPlane)
      return { status: 201, body: await this.options.approvals.request(request.body) }
    }
    if (route.action === 'decideApproval') {
      requireBearer(request.headers?.authorization, this.options.authentication.approvalGateway)
      if (!this.options.authentication.approvers.includes(request.body?.approved_by)) throw new AuthenticationError('UNAUTHORIZED_APPROVER')
      return { status: 200, body: await this.options.approvals.decide(route.id!, request.body) }
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
      result: response ? JSON.stringify(response.body) : null,
      error,
      retries: 0,
      external_action: toolAction === 'mail.send',
      approval_reference: (response?.body as { approval_reference?: string } | undefined)?.approval_reference ?? request.body?.approval_id ?? null,
      evidence: [],
      state_changes: response ? [toolAction] : [],
      deployed_version: this.options.deployedVersion,
    })
  }
}

type Route = { action: string; auditAction: string; id?: string }

function matchRoute(method: string, path: string): Route | null {
  if (method === 'GET' && path === '/healthz') return { action: 'health', auditAction: 'health' }
  if (method === 'GET' && path === '/readyz') return { action: 'ready', auditAction: 'ready' }
  if (method === 'POST' && path === '/v1/work-orders') return { action: 'createWorkOrder', auditAction: 'work_order.create' }
  if (method === 'POST' && path === '/v1/approvals/requests') return { action: 'requestApproval', auditAction: 'approval.request' }
  if (method === 'POST' && path === '/v1/mail/send') return { action: 'sendMail', auditAction: 'mail.send' }
  const mission = /^\/v1\/missions\/([^/]+)$/.exec(path)
  if (method === 'GET' && mission) return { action: 'getMission', auditAction: 'mission.get', id: mission[1] }
  const decision = /^\/v1\/approvals\/([^/]+)\/decision$/.exec(path)
  if (method === 'POST' && decision) return { action: 'decideApproval', auditAction: 'approval.decision', id: decision[1] }
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
