import { ApprovalError, type ApprovalBroker } from './approvals.js'
import { buildInternalMailTestPlan } from './internal-mail-test-plan.js'
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
import { ValidationError, validateWorkOrder, type WorkOrder } from './work-orders.js'
import type { InstructionRequestView, MissionRecord } from './repository.js'
import {
  AssignmentPlanError,
  validateAssignmentPlan,
  type AssignmentPlan,
} from './assignment-plan.js'
import type { DispatchQueuePort } from './dispatch-queue.js'
import type { ShadowDecisionDimension, ShadowDecisionValue } from './shadow-review.js'
import type { DraftReviewDecision } from './draft-review.js'
import { PolicyReviewError, type PolicyReviewAttestations, type PolicyReviewDecision, type PolicyReviewKind } from './policy-review.js'
import {
  A1ResearchAuthorizationError,
  hashA1ResearchDossier,
  validateA1ResearchAuthorizationRequest,
} from './a1-research-authorization.js'
import { buildA1WorkOrderPreview } from './a1-work-order-preview.js'
import {
  a1ResearchOrderAuthorizationId,
  a1ResearchReviewId,
  assertA1ResearchWorkOrderCandidate,
  assertA1ResearchWorkOrderAdmission,
} from './a1-research-work-order.js'
import {
  A1ResearchOrderAuthorizationError,
  hashUnsignedA1ResearchWorkOrder,
  validateA1ResearchOrderAuthorizationRequest,
} from './a1-research-order-authorization.js'

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
    salesCommands: string
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
      const admissionTime = this.now()
      verifyWorkOrder(workOrder, this.options.authentication.workOrders, admissionTime)
      if (workOrder.autonomy_level === 'A3' && !this.options.a3AdmissionEnabled)
        throw new AuthenticationError('A3_ADMISSION_DISABLED')
      await this.requireA1ResearchAdmission(workOrder, admissionTime)
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
    if (route.action === 'listInstructionRequests') {
      requireBearer(request.headers?.authorization, this.options.authentication.controlPlane)
      return {
        status: 200,
        body: {
          requests: await this.options.repository.listInstructionRequests(),
          external_actions_allowed: false,
          observed_at: this.now().toISOString(),
        },
      }
    }
    if (route.action === 'reviewInstructionRequest') {
      requireBearer(request.headers?.authorization, this.options.authentication.controlPlane)
      const input = validateInstructionReviewRequest(request.body, this.now())
      const current = await this.options.repository.getInstructionRequest(route.id!)
      if (!current) return { status: 404, body: { error: 'not_found' } }
      let mission: MissionRecord | null = null
      if (input.decision === 'convert') {
        const workOrder = validateWorkOrder(input.workOrder)
        const admissionTime = this.now()
        verifyWorkOrder(workOrder, this.options.authentication.workOrders, admissionTime)
        assertInstructionWorkOrder(current, workOrder)
        await this.requireA1ResearchAdmission(workOrder, admissionTime)
        mission = {
          ...workOrder,
          mission_id: workOrder.mission_id,
          autonomy_level: workOrder.autonomy_level,
          a3_enabled: false,
        }
      }
      const result = await this.options.repository.reviewInstructionRequest({
        requestId: route.id!,
        decision: input.decision,
        actorId: input.actorId,
        reason: input.reason,
        reviewedAt: input.reviewedAt,
        idempotencyKey: input.idempotencyKey,
        expectedInstructionSha256: input.expectedInstructionSha256,
        reviewRequestSha256: hashAction({
          request_id: route.id!,
          decision: input.decision,
          actor_id: input.actorId,
          reason: input.reason,
          reviewed_at: input.reviewedAt,
          idempotency_key: input.idempotencyKey,
          expected_instruction_sha256: input.expectedInstructionSha256,
          work_order: input.workOrder,
        }),
        mission,
      })
      return { status: result.replayed ? 200 : 201, body: result }
    }
    if (route.action === 'createSalesMissionDraft') {
      requireBearer(
        request.headers?.authorization,
        this.options.authentication.salesCommands,
      )
      const draft = validateSalesMissionDraftRequest(request.body, this.now())
      const result = await this.options.repository.createInstructionRequest({
        request_id: draft.request_id,
        idempotency_key: draft.idempotency_key,
        project_id: 'proptimiza',
        title: draft.title,
        instruction: draft.title,
        instruction_sha256: createHash('sha256')
          .update(draft.title, 'utf8')
          .digest('hex'),
        requested_by: draft.requested_by,
        source: 'sales',
        autonomy_ceiling: 'A0',
        created_at: draft.created_at,
        expires_at: draft.expires_at,
        metadata: {
          trust_classification: 'authenticated_sales_command',
          interface: 'sales-control-center',
          offer_id: 'operacion-sin-planillas',
          execution_eligible: false,
          codex_review_required: true,
        },
      })
      return {
        status: result.created ? 201 : 200,
        body: {
          id: result.request_id,
          projectId: 'operacion-sin-planillas',
          portfolioId: result.project_id,
          title: result.title,
          status: 'submitted',
          provenance: {
            source: 'control-broker',
            sourceId: `instruction:${result.request_id}`,
            observedAt: this.now().toISOString(),
            synthetic: false,
          },
        },
      }
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
    if (route.action === 'checkKillSwitch') {
      requireBearer(request.headers?.authorization, this.options.authentication.internal)
      const input = validateKillSwitchCheck(request.body)
      return {
        status: 200,
        body: { active: await this.options.repository.isKillSwitchActive(input) },
      }
    }
    if (route.action === 'createAssignments') {
      requireBearer(request.headers?.authorization, this.options.authentication.controlPlane)
      const plan = validateAssignmentPlan(request.body)
      if (plan.mission_id !== route.id)
        throw new ValidationError(['mission_id does not match route'])
      const mission = await this.options.repository.getMission(plan.mission_id)
      if (!mission) return { status: 404, body: { error: 'not_found' } }
      const admissionTime = this.now()
      assertInternalExecutionMission(mission, plan.trace_id)
      assertMissionExecutionWindow(mission, admissionTime)
      await this.requireA1ResearchAdmission(mission as unknown as WorkOrder, admissionTime)
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
    if (route.action === 'listDraftReviews') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      return { status: 200, body: await this.options.repository.listDraftReviews() }
    }
    if (route.action === 'getDraftReview') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const review = await this.options.repository.getDraftReview(route.id!)
      return review ? { status: 200, body: review } : { status: 404, body: { error: 'not_found' } }
    }
    if (route.action === 'getA1ResearchDossier') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const dossier = await this.options.repository.getA1ResearchDossier(route.id!)
      return dossier ? { status: 200, body: dossier } : { status: 404, body: { error: 'not_found' } }
    }
    if (route.action === 'getA1ResearchAuthorization') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const dossier = await this.options.repository.getA1ResearchDossier(route.id!)
      if (!dossier) return { status: 404, body: { error: 'not_found' } }
      const state = await this.options.repository.getA1ResearchAuthorizationState(route.id!, hashA1ResearchDossier(dossier))
      return state ? { status: 200, body: state } : { status: 404, body: { error: 'not_found' } }
    }
    if (route.action === 'getA1WorkOrderPreview') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const dossier = await this.options.repository.getA1ResearchDossier(route.id!)
      if (!dossier) return { status: 404, body: { error: 'not_found' } }
      const authorization = await this.options.repository.getA1ResearchAuthorizationState(route.id!, hashA1ResearchDossier(dossier))
      return { status: 200, body: buildA1WorkOrderPreview(dossier, authorization, this.now()) }
    }
    if (route.action === 'recordA1ResearchAuthorization') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const input = validateA1ResearchAuthorizationRequest(request.body, this.now())
      const dossier = await this.options.repository.getA1ResearchDossier(route.id!)
      if (!dossier) return { status: 404, body: { error: 'not_found' } }
      const dossierSha256 = hashA1ResearchDossier(dossier)
      if (dossier.status !== 'authorization_required' || dossierSha256 !== input.expectedDossierSha256)
        throw new A1ResearchAuthorizationError('A1_RESEARCH_AUTHORIZATION_GATE_CLOSED')
      const requestSha256 = hashAction({ review_id: route.id!, ...input })
      return {
        status: 200,
        body: await this.options.repository.recordA1ResearchAuthorization({
          ...input,
          authorizationId: deterministicUuid(hashAction({ review_id: route.id!, idempotency_key: input.idempotencyKey })),
          reviewId: route.id!,
          requestSha256,
        }),
      }
    }
    if (route.action === 'recordA1ResearchOrderAuthorization') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const now = this.now()
      const input = validateA1ResearchOrderAuthorizationRequest(request.body, now)
      const workOrder = validateWorkOrder(input.workOrder)
      const dossier = await this.options.repository.getA1ResearchDossier(route.id!)
      if (!dossier) return { status: 404, body: { error: 'not_found' } }
      const dossierSha256 = hashA1ResearchDossier(dossier)
      const parent = await this.options.repository.getA1ResearchAuthorizationState(route.id!, dossierSha256)
      const metadata = workOrder.metadata
      const authority = workOrder.authority as Record<string, unknown>
      const orderAuthorizationId = a1ResearchOrderAuthorizationId(workOrder)
      const unsignedWorkOrderSha256 = hashUnsignedA1ResearchWorkOrder(workOrder)
      if (
        dossierSha256 !== input.expectedDossierSha256 || parent?.authorization?.authorizationId !== input.expectedParentAuthorizationId ||
        authority.signature !== '0'.repeat(64) || metadata?.a1_research_order_authorization_id !== orderAuthorizationId ||
        metadata.a1_research_order_unsigned_sha256 !== unsignedWorkOrderSha256 ||
        metadata.a1_research_order_authorization_expires_at !== input.expiresAt ||
        metadata.a1_research_order_authorization_sha256 !== input.userAuthorizationSha256 ||
        metadata.a1_research_order_authorized_at !== input.reviewedAt ||
        Date.parse(String(workOrder.expires_at)) > Date.parse(input.expiresAt)
      ) throw new A1ResearchOrderAuthorizationError('A1_RESEARCH_ORDER_AUTHORIZATION_GATE_CLOSED')
      assertA1ResearchWorkOrderCandidate(workOrder, dossier, parent, now)
      return {
        status: 200,
        body: await this.options.repository.recordA1ResearchOrderAuthorization({
          orderAuthorizationId: orderAuthorizationId!, reviewId: route.id!,
          parentAuthorizationId: input.expectedParentAuthorizationId,
          decision: input.decision, rationale: input.rationale, reviewerId: input.reviewerId,
          reviewerEmail: input.reviewerEmail, reviewedAt: input.reviewedAt, expiresAt: input.expiresAt,
          expectedDossierSha256: dossierSha256, unsignedWorkOrderSha256,
          missionId: workOrder.mission_id, userAuthorizationSha256: input.userAuthorizationSha256,
          attestations: input.attestations, idempotencyKey: input.idempotencyKey,
          requestSha256: hashAction({ review_id: route.id!, ...input, workOrder }),
        }),
      }
    }
    if (route.action === 'recordDraftReviewItem') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const input = validateDraftReviewItemRequest(request.body, route.slot)
      return {
        status: 200,
        body: await this.options.repository.recordDraftReviewItem({
          ...input,
          reviewId: route.id!,
          itemSlot: route.slot!,
          requestSha256: hashAction({ review_id: route.id!, item_slot: route.slot!, ...input }),
        }),
      }
    }
    if (route.action === 'completeDraftReview') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const input = validateDraftReviewCompletionRequest(request.body)
      return {
        status: 200,
        body: await this.options.repository.completeDraftReview({
          ...input,
          reviewId: route.id!,
          requestSha256: hashAction({ review_id: route.id!, ...input }),
        }),
      }
    }
    if (route.action === 'getPolicyReview') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      return { status: 200, body: await this.options.repository.getPolicyReviewState() }
    }
    if (route.action === 'recordPolicyReview') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      const input = validatePolicyReviewRequest(request.body, this.now())
      return {
        status: 200,
        body: await this.options.repository.recordPolicyReview({
          ...input,
          requestSha256: hashAction({ project_id: 'proptimiza', policy_version: 'policy-v2', ...input }),
        }),
      }
    }
    if (route.action === 'getPolicyActivationDossier') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      return { status: 200, body: await this.options.repository.getPolicyActivationDossierState() }
    }
    if (route.action === 'getInternalMailTestPlan') {
      requireBearer(request.headers?.authorization, this.options.authentication.shadowReview)
      return { status: 200, body: buildInternalMailTestPlan(this.now()) }
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
    if (route.action === 'activateKillSwitch') {
      const channel = resolveApprovalChannel(
        request.headers?.authorization,
        this.options.authentication.approvalGateways,
      )
      const gateway = this.options.authentication.approvalGateways[channel]
      const activation = validateKillSwitchActivation(request.body, this.now())
      if (!gateway.actors.includes(activation.actorId))
        throw new AuthenticationError('FORBIDDEN')
      await this.options.repository.activateKillSwitch('global', '*')
      return {
        status: 200,
        body: {
          active: true,
          scope: 'global',
          scope_id: '*',
          activated_by: `${channel}:${activation.actorId}`,
        },
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

  private async requireA1ResearchAdmission(workOrder: WorkOrder, now: Date): Promise<void> {
    const reviewId = a1ResearchReviewId(workOrder)
    if (reviewId === null) return
    const orderAuthorizationId = a1ResearchOrderAuthorizationId(workOrder)
    const dossier = await this.options.repository.getA1ResearchDossier(reviewId)
    const authorization = dossier
      ? await this.options.repository.getA1ResearchAuthorizationState(reviewId, hashA1ResearchDossier(dossier))
      : null
    const orderAuthorization = orderAuthorizationId
      ? await this.options.repository.getA1ResearchOrderAuthorizationState(orderAuthorizationId)
      : null
    assertA1ResearchWorkOrderAdmission(workOrder, dossier, authorization, orderAuthorization, now)
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
  if (method === 'GET' && path === '/internal/v1/draft-reviews')
    return { action: 'listDraftReviews', auditAction: 'draft_review.list' }
  const draftReview = /^\/internal\/v1\/draft-reviews\/([^/]+)$/.exec(path)
  if (method === 'GET' && draftReview)
    return { action: 'getDraftReview', auditAction: 'draft_review.get', id: draftReview[1] }
  const a1ResearchDossier = /^\/internal\/v1\/a1-research-dossiers\/([^/]+)$/.exec(path)
  if (method === 'GET' && a1ResearchDossier)
    return { action: 'getA1ResearchDossier', auditAction: 'a1_research_dossier.get', id: a1ResearchDossier[1] }
  const a1ResearchAuthorization = /^\/internal\/v1\/a1-research-authorizations\/([^/]+)$/.exec(path)
  if (method === 'GET' && a1ResearchAuthorization)
    return { action: 'getA1ResearchAuthorization', auditAction: 'a1_research_authorization.get', id: a1ResearchAuthorization[1] }
  if (method === 'POST' && a1ResearchAuthorization)
    return { action: 'recordA1ResearchAuthorization', auditAction: 'a1_research_authorization.record', id: a1ResearchAuthorization[1] }
  const a1WorkOrderPreview = /^\/internal\/v1\/a1-work-order-previews\/([^/]+)$/.exec(path)
  if (method === 'GET' && a1WorkOrderPreview)
    return { action: 'getA1WorkOrderPreview', auditAction: 'a1_work_order_preview.get', id: a1WorkOrderPreview[1] }
  const a1OrderAuthorization = /^\/internal\/v1\/a1-order-authorizations\/([^/]+)$/.exec(path)
  if (method === 'POST' && a1OrderAuthorization)
    return { action: 'recordA1ResearchOrderAuthorization', auditAction: 'a1_research_order_authorization.record', id: a1OrderAuthorization[1] }
  const draftItem = /^\/internal\/v1\/draft-reviews\/([^/]+)\/items\/(\d+)$/.exec(path)
  if (method === 'PUT' && draftItem)
    return { action: 'recordDraftReviewItem', auditAction: 'draft_review.item.record', id: draftItem[1], slot: Number(draftItem[2]) }
  const draftComplete = /^\/internal\/v1\/draft-reviews\/([^/]+)\/complete$/.exec(path)
  if (method === 'POST' && draftComplete)
    return { action: 'completeDraftReview', auditAction: 'draft_review.complete', id: draftComplete[1] }
  if (method === 'GET' && path === '/internal/v1/policy-reviews/proptimiza/policy-v2')
    return { action: 'getPolicyReview', auditAction: 'policy_review.get' }
  if (method === 'POST' && path === '/internal/v1/policy-reviews/proptimiza/policy-v2/decision')
    return { action: 'recordPolicyReview', auditAction: 'policy_review.record' }
  if (method === 'GET' && path === '/internal/v1/policy-activation-dossiers/proptimiza/policy-v2')
    return { action: 'getPolicyActivationDossier', auditAction: 'policy_activation_dossier.get' }
  if (method === 'GET' && path === '/internal/v1/internal-mail-test-plans/proptimiza/v1')
    return { action: 'getInternalMailTestPlan', auditAction: 'internal_mail_test_plan.get' }
  if (method === 'POST' && path === '/v1/work-orders') return { action: 'createWorkOrder', auditAction: 'work_order.create' }
  if (method === 'POST' && path === '/v1/instruction-requests')
    return { action: 'createInstructionRequest', auditAction: 'instruction_request.create' }
  if (method === 'GET' && path === '/v1/instruction-requests')
    return { action: 'listInstructionRequests', auditAction: 'instruction_request.list' }
  const instructionReview = /^\/v1\/instruction-requests\/([^/]+)\/decision$/.exec(path)
  if (method === 'POST' && instructionReview)
    return { action: 'reviewInstructionRequest', auditAction: 'instruction_request.review', id: instructionReview[1] }
  if (method === 'POST' && path === '/internal/v1/sales/mission-drafts')
    return { action: 'createSalesMissionDraft', auditAction: 'sales.mission_draft.create' }
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
  if (method === 'POST' && path === '/internal/v1/safety/kill-switch')
    return { action: 'checkKillSwitch', auditAction: 'safety.kill_switch.check' }
  const decision = /^\/v1\/approvals\/([^/]+)\/decision$/.exec(path)
  if (method === 'POST' && decision)
    return {
      action: 'decideApproval',
      auditAction: 'approval.decision',
      id: decision[1],
    }
  if (method === 'POST' && path === '/v1/kill-switches/activate')
    return {
      action: 'activateKillSwitch',
      auditAction: 'safety.kill_switch.activate',
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

function validateKillSwitchCheck(value: unknown): { missionId: string; channel: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(['kill switch check must be an object'])
  const record = value as Record<string, unknown>
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(['channel', 'mission_id']) ||
      typeof record.mission_id !== 'string' ||
      !/^(?:\*|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(record.mission_id) ||
      typeof record.channel !== 'string' || !/^(?:email|telegram|internal|\*)$/.test(record.channel))
    throw new ValidationError(['kill switch check is invalid'])
  return { missionId: record.mission_id, channel: record.channel }
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

function assertMissionExecutionWindow(
  mission: Record<string, unknown>,
  now: Date,
): void {
  const expiresAt = Date.parse(String(mission.expires_at))
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime())
    throw new AuthenticationError('EXPIRED_AUTHORITY')
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

function validateKillSwitchActivation(
  value: unknown,
  now: Date,
): {
  actorId: string
  occurredAt: string
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(['kill switch activation must be an object'])
  const record = value as Record<string, unknown>
  const expected = ['actor_id', 'occurred_at', 'reason', 'scope', 'scope_id']
  if (
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expected) ||
    record.scope !== 'global' ||
    record.scope_id !== '*' ||
    record.reason !== 'telegram_emergency_stop' ||
    typeof record.actor_id !== 'string' ||
    !/^[A-Za-z0-9._:@-]{1,128}$/.test(record.actor_id) ||
    typeof record.occurred_at !== 'string' ||
    !Number.isFinite(Date.parse(record.occurred_at)) ||
    Math.abs(Date.parse(record.occurred_at) - now.getTime()) > 5 * 60_000
  )
    throw new ValidationError(['kill switch activation is invalid'])
  return {
    actorId: record.actor_id,
    occurredAt: new Date(record.occurred_at).toISOString(),
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

function validateSalesMissionDraftRequest(
  value: unknown,
  now: Date,
): {
  request_id: string
  idempotency_key: string
  title: string
  requested_by: string
  created_at: string
  expires_at: string
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(['sales mission draft must be an object'])
  const record = value as Record<string, unknown>
  const allowed = new Set([
    'request_id','idempotency_key','project_id','offer_id','title',
    'requested_by','created_at','expires_at',
  ])
  const requestId = string(record.request_id)
  const idempotencyKey = string(record.idempotency_key)
  const title = string(record.title).trim()
  const requestedBy = string(record.requested_by)
  const created = Date.parse(string(record.created_at))
  const expires = Date.parse(string(record.expires_at))
  const secretPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|oc_sk)-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~-]{20,}/i
  if (
    Object.keys(record).some((field) => !allowed.has(field)) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
    !/^sales:[A-Za-z0-9._:-]{8,122}$/.test(idempotencyKey) ||
    record.project_id !== 'proptimiza' ||
    record.offer_id !== 'operacion-sin-planillas' ||
    title.length < 3 || title.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(title) || secretPattern.test(title) ||
    !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(requestedBy) ||
    !Number.isFinite(created) || !Number.isFinite(expires) ||
    created < now.getTime() - 300_000 || created > now.getTime() + 300_000 ||
    expires <= created || expires > created + 7 * 86_400_000
  )
    throw new ValidationError(['sales mission draft is invalid'])
  return {
    request_id: requestId,
    idempotency_key: idempotencyKey,
    title,
    requested_by: requestedBy,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(expires).toISOString(),
  }
}

function validateInstructionReviewRequest(
  value: unknown,
  now: Date,
): {
  decision: 'reject' | 'convert'
  actorId: 'codex-auditor'
  reason: string
  reviewedAt: string
  idempotencyKey: string
  expectedInstructionSha256: string
  workOrder: unknown | null
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(['instruction review must be an object'])
  const record = value as Record<string, unknown>
  const allowed = new Set([
    'decision','actor_id','reason','reviewed_at','idempotency_key',
    'expected_instruction_sha256','work_order',
  ])
  const decision = string(record.decision)
  const reason = string(record.reason).trim()
  const reviewed = Date.parse(string(record.reviewed_at))
  const idempotencyKey = string(record.idempotency_key)
  const expectedInstructionSha256 = string(record.expected_instruction_sha256)
  const secretPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|oc_sk)-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~-]{20,}/i
  if (
    Object.keys(record).some((field) => !allowed.has(field)) ||
    !['reject','convert'].includes(decision) ||
    record.actor_id !== 'codex-auditor' ||
    reason.length < 10 || reason.length > 1000 || secretPattern.test(reason) ||
    !Number.isFinite(reviewed) || Math.abs(reviewed - now.getTime()) > 300_000 ||
    !/^codex-review:[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey) ||
    !/^[a-f0-9]{64}$/.test(expectedInstructionSha256) ||
    (decision === 'reject' && record.work_order !== null) ||
    (decision === 'convert' && (record.work_order === null || typeof record.work_order !== 'object' || Array.isArray(record.work_order)))
  ) throw new ValidationError(['instruction review is invalid'])
  return {
    decision: decision as 'reject' | 'convert',
    actorId: 'codex-auditor',
    reason,
    reviewedAt: new Date(reviewed).toISOString(),
    idempotencyKey,
    expectedInstructionSha256,
    workOrder: record.work_order ?? null,
  }
}

function assertInstructionWorkOrder(
  request: InstructionRequestView,
  workOrder: WorkOrder,
): void {
  assertInternalExecutionMission(workOrder, workOrder.trace_id)
  const autonomyRank = { A0: 0, A1: 1, A2: 2 } as const
  const metadata = workOrder.metadata
  const budget = workOrder.budget_limit as Record<string, unknown>
  const volume = workOrder.volume_limits as Record<string, unknown>
  const allowedActions = stringSet(workOrder.allowed_actions)
  const approvedChannels = stringSet(workOrder.approved_channels)
  const approvedTools = stringSet(workOrder.approved_tools)
  const allowedActionSet = new Set(['analysis.internal','research.public.read','artifact.prepare'])
  const allowedChannelSet = new Set(['none','internal','public_web'])
  const allowedToolSet = new Set(['hermes.analysis','hermes.web','hermes.file.ephemeral'])
  if (
    workOrder.project_id !== request.project_id ||
    workOrder.offer_id !== 'operacion-sin-planillas' ||
    workOrder.autonomy_level === 'A3' || workOrder.autonomy_level === 'A4' ||
    autonomyRank[workOrder.autonomy_level] > autonomyRank[request.autonomy_ceiling] ||
    workOrder.approval_token !== null ||
    workOrder.requested_by !== 'codex-auditor' ||
    !metadata || metadata.instruction_request_id !== request.request_id ||
    metadata.instruction_sha256 !== request.instruction_sha256 ||
    Date.parse(String(workOrder.expires_at)) > Date.parse(request.expires_at) ||
    budget.currency !== 'USD' || typeof budget.maximum !== 'number' || budget.maximum > 0.5 ||
    typeof volume.maximum_accounts !== 'number' || volume.maximum_accounts > 10 ||
    volume.maximum_contacts !== 0 || volume.maximum_external_actions !== 0 ||
    !allowedActions || [...allowedActions].some((action) => !allowedActionSet.has(action)) ||
    !approvedChannels || [...approvedChannels].some((channel) => !allowedChannelSet.has(channel)) ||
    !approvedTools || [...approvedTools].some((tool) => !allowedToolSet.has(tool)) ||
    (workOrder.autonomy_level === 'A0' && (approvedChannels.has('public_web') || approvedTools.has('hermes.web'))) ||
    (workOrder.autonomy_level === 'A1' && !allowedActions.has('research.public.read'))
  ) throw new AuthenticationError('INSTRUCTION_CONVERSION_POLICY_REQUIRED')
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

function validateDraftReviewItemRequest(
  value: unknown,
  slot?: number,
): {
  decision: DraftReviewDecision
  rationale: string
  revisedSubject: string | null
  revisedBody: string | null
  expectedVersion: number
  actorId: string
  idempotencyKey: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(['draft review item must be an object'])
  const record = value as Record<string, unknown>
  const allowed = new Set(['decision','rationale','revised_subject','revised_body','expected_version','actor_id','idempotency_key'])
  const decision = string(record.decision)
  const rationale = string(record.rationale).trim()
  const revisedSubject = record.revised_subject === null ? null : string(record.revised_subject).trim()
  const revisedBody = record.revised_body === null ? null : string(record.revised_body).trim()
  const isRevision = decision === 'revised_internal'
  if (
    Object.keys(record).some((field) => !allowed.has(field)) ||
    !Number.isSafeInteger(slot) || slot! < 1 || slot! > 3 ||
    !['accepted_internal','revised_internal','rejected'].includes(decision) ||
    rationale.length < 10 || rationale.length > 1000 || unsafeReviewText(rationale) ||
    !Number.isSafeInteger(record.expected_version) || Number(record.expected_version) < 0 ||
    !/^[A-Za-z0-9._:@+-]{3,254}$/.test(string(record.actor_id)) ||
    !/^draft-review:[A-Za-z0-9._:-]{8,114}$/.test(string(record.idempotency_key)) ||
    (isRevision && !validInternalDraftRevision(revisedSubject, revisedBody)) ||
    (!isRevision && (revisedSubject !== null || revisedBody !== null))
  ) throw new ValidationError(['draft review item is invalid'])
  return {
    decision: decision as DraftReviewDecision,
    rationale,
    revisedSubject,
    revisedBody,
    expectedVersion: Number(record.expected_version),
    actorId: string(record.actor_id),
    idempotencyKey: string(record.idempotency_key),
  }
}

function validateDraftReviewCompletionRequest(value: unknown): {
  expectedVersion: number
  actorId: string
  idempotencyKey: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(['draft review completion must be an object'])
  const record = value as Record<string, unknown>
  const allowed = new Set(['expected_version','actor_id','idempotency_key'])
  if (Object.keys(record).some((field) => !allowed.has(field)) ||
      !Number.isSafeInteger(record.expected_version) || Number(record.expected_version) < 0 ||
      !/^[A-Za-z0-9._:@+-]{3,254}$/.test(string(record.actor_id)) ||
      !/^draft-review:[A-Za-z0-9._:-]{8,114}$/.test(string(record.idempotency_key)))
    throw new ValidationError(['draft review completion is invalid'])
  return {
    expectedVersion: Number(record.expected_version),
    actorId: string(record.actor_id),
    idempotencyKey: string(record.idempotency_key),
  }
}

function validInternalDraftRevision(subject: string | null, body: string | null): boolean {
  if (!subject || !body || subject.length < 10 || subject.length > 200 || body.length < 30 || body.length > 2000)
    return false
  if (unsafeReviewText(subject) || unsafeReviewText(body)) return false
  return /hipótesis/i.test(body) && /operación sin planillas/i.test(body) && /CLP 1\.800\.000/i.test(body)
}

function unsafeReviewText(value: string): boolean {
  return /[\u0000-\u001f\u007f]|https?:\/\/|www\.|@|```|\||-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|oc_sk)-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~-]{20,}|\+?\d[\d ()-]{7,}\d/i.test(value)
}

function validatePolicyReviewRequest(value: unknown, now: Date): {
  kind: PolicyReviewKind
  decision: PolicyReviewDecision
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  expectedPolicyDigest: string
  attestations: PolicyReviewAttestations
  idempotencyKey: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(['policy review must be an object'])
  const record = value as Record<string, unknown>
  const allowed = new Set(['review_kind','decision','rationale','reviewer_id','reviewer_email','reviewed_at','expected_policy_digest','attestations','idempotency_key'])
  const attestationRecord = record.attestations && typeof record.attestations === 'object' && !Array.isArray(record.attestations) ? record.attestations as Record<string, unknown> : null
  const attestationKeys = ['competent_human_confirmed','control_set_confirmed','no_activation_requested','policy_digest_confirmed','review_scope_confirmed']
  const kind = string(record.review_kind)
  const decision = string(record.decision)
  const reviewedAt = Date.parse(string(record.reviewed_at))
  if (Object.keys(record).some((field) => !allowed.has(field)) || !['commercial','privacy_legal'].includes(kind) || !['approved','rejected'].includes(decision) ||
      string(record.rationale).trim().length < 20 || string(record.rationale).trim().length > 2000 ||
      !/^[A-Za-z0-9._:@+-]{3,254}$/.test(string(record.reviewer_id)) || string(record.reviewer_email).toLowerCase() !== 'proptimizaspa@gmail.com' ||
      !Number.isFinite(reviewedAt) || Math.abs(reviewedAt-now.getTime()) > 300_000 ||
      string(record.expected_policy_digest) !== '888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19' ||
      !/^policy-review:[A-Za-z0-9._:-]{8,108}$/.test(string(record.idempotency_key)) || !attestationRecord ||
      JSON.stringify(Object.keys(attestationRecord).sort()) !== JSON.stringify(attestationKeys) || Object.values(attestationRecord).some((item) => typeof item !== 'boolean') ||
      attestationRecord.policy_digest_confirmed !== true || attestationRecord.no_activation_requested !== true || attestationRecord.review_scope_confirmed !== true ||
      (decision === 'approved' && attestationRecord.control_set_confirmed !== true) ||
      (decision === 'approved' && kind === 'privacy_legal' && attestationRecord.competent_human_confirmed !== true)) throw new ValidationError(['policy review is invalid'])
  return {
    kind: kind as PolicyReviewKind,
    decision: decision as PolicyReviewDecision,
    rationale: string(record.rationale).trim(),
    reviewerId: string(record.reviewer_id),
    reviewerEmail: 'proptimizaspa@gmail.com',
    reviewedAt: new Date(reviewedAt).toISOString(),
    expectedPolicyDigest: string(record.expected_policy_digest),
    attestations: {
      policyDigestConfirmed: attestationRecord.policy_digest_confirmed as boolean,
      noActivationRequested: attestationRecord.no_activation_requested as boolean,
      reviewScopeConfirmed: attestationRecord.review_scope_confirmed as boolean,
      controlSetConfirmed: attestationRecord.control_set_confirmed as boolean,
      competentHumanConfirmed: attestationRecord.competent_human_confirmed as boolean,
    },
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
  status: 400 | 401 | 403 | 404 | 409 | 500 | 503
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
      'INSTRUCTION_CONVERSION_POLICY_REQUIRED',
      'A1_RESEARCH_WORK_ORDER_NOT_AUTHORIZED',
    ])
    return {
      status: 403,
      error: allowed.has(error.code) ? error.code : 'forbidden',
    }
  }
  if (error instanceof PolicyReviewError) {
    if (error.code === 'POLICY_REVIEW_INVALID') return { status: 400, error: error.code }
    return { status: 409, error: error.code }
  }
  if (error instanceof A1ResearchAuthorizationError) {
    if (error.code === 'A1_RESEARCH_AUTHORIZATION_INVALID') return { status: 400, error: error.code }
    if (error.code === 'A1_RESEARCH_DOSSIER_NOT_FOUND') return { status: 404, error: 'not_found' }
    return { status: 409, error: error.code }
  }
  if (error instanceof A1ResearchOrderAuthorizationError) {
    if (error.code === 'A1_RESEARCH_ORDER_AUTHORIZATION_INVALID') return { status: 400, error: error.code }
    if (error.code === 'A1_RESEARCH_ORDER_AUTHORIZATION_NOT_FOUND') return { status: 404, error: 'not_found' }
    return { status: 409, error: error.code }
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
    ['IDEMPOTENCY_CONFLICT', 'INSTRUCTION_IDEMPOTENCY_CONFLICT', 'INSTRUCTION_REVIEW_CONFLICT', 'EXECUTION_IN_PROGRESS', 'APPROVAL_GRANT_CONFLICT', 'SHADOW_REVIEW_IDEMPOTENCY_CONFLICT', 'SHADOW_REVIEW_VERSION_CONFLICT', 'SHADOW_REVIEW_NOT_OPEN', 'DRAFT_REVIEW_IDEMPOTENCY_CONFLICT', 'DRAFT_REVIEW_VERSION_CONFLICT', 'DRAFT_REVIEW_NOT_OPEN'].includes(
      error.message,
    )
  )
    return { status: 409, error: error.message }
  if (
    error instanceof Error &&
    ['INSTRUCTION_REVIEW_INVALID','INSTRUCTION_REQUEST_EXPIRED','SHADOW_REVIEW_DECISION_INVALID','SHADOW_REVIEW_COMPLETION_INVALID','SHADOW_REVIEW_INCOMPLETE','SHADOW_REVIEW_DECISION_NOT_FOUND','DRAFT_REVIEW_ITEM_INVALID','DRAFT_REVIEW_COMPLETION_INVALID','DRAFT_REVIEW_INCOMPLETE','DRAFT_REVIEW_ITEM_NOT_FOUND'].includes(error.message)
  )
    return { status: 400, error: error.message }
  return { status: 500, error: 'internal_error' }
}

function deterministicUuid(sha256: string): string {
  const hex = sha256.slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ['8','9','a','b'][Number.parseInt(hex[16]!, 16) % 4]!
  const value = hex.join('')
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20,32)}`
}
