import { hashAction } from './canonical.js'
import type { AssignmentPlan } from './assignment-plan.js'
import {
  deriveA1SingleApprovalSubgates,
  type A1SingleApprovalSubgateBundle,
} from './a1-single-approval-subgate-derivation.js'
import {
  type A1SingleApprovalControlState,
  type A1SingleApprovalCoordinatorAdapter,
  type A1SingleApprovalOperationResult,
  type A1SingleApprovalStageContext,
} from './a1-single-approval-coordinator.js'

type Stage = A1SingleApprovalStageContext['stage']

export interface A1SingleApprovalBrokerParentInput extends Record<string, unknown> {
  request_id: string
  mission_id: string
  trace_id: string
  authorization_digest_sha256: string
  user_authorization_sha256: string
  expected_mission_sha256: string
  assignment_plan_sha256: string
  job_set_sha256: string
  assignment_ids: string[]
  worker_id: 'broker-dispatcher-1'
  maximum_dispatch_ticks: 6
  maximum_provider_credit_spend_usd: number
  reviewer_id: 'user:proptimizaspa@gmail.com'
  reviewer_email: 'proptimizaspa@gmail.com'
  reviewed_at: string
  expires_at: string
  stage_receipt_keys: Record<string, string>
  stage_receipt_key: string
  idempotency_key: string
}

export interface A1SingleApprovalBrokerSubgateInput extends Record<string, unknown> {
  mission_id: string
  stage_receipt_key: string
  user_authorization_sha256: string
  body: Record<string, unknown>
}

export interface A1SingleApprovalBrokerMaterializeInput extends Record<string, unknown> {
  mission_id: string
  stage_receipt_key: string
  user_authorization_sha256: string
  assignment_plan: AssignmentPlan
}

export interface A1SingleApprovalBrokerDispatchInput extends Record<string, unknown> {
  mission_id: string
  worker_id: 'broker-dispatcher-1'
  tick: number
  stage_receipt_key: string
  user_authorization_sha256: string
}

export interface A1SingleApprovalBrokerRecontainInput extends Record<string, unknown> {
  mission_id: string
  reason: string
  stage_receipt_key: string
  user_authorization_sha256: string
}

export interface A1SingleApprovalBrokerAuditInput extends Record<string, unknown> {
  mission_id: string
  assignment_ids: string[]
  maximum_provider_credit_spend_usd: number
  stage_receipt_key: string
  user_authorization_sha256: string
}

/**
 * Narrow live-facing port for the single-approval A1 chain.
 *
 * Implementations may bind these methods to in-process broker services or to
 * authenticated internal endpoints, but they must normalize every response to
 * the exact response contracts validated below. The adapter intentionally has
 * no generic request method, URL, credential, retry, or arbitrary tool-call
 * capability.
 */
export interface A1SingleApprovalBrokerPort {
  inspect(missionId: string): Promise<unknown>
  consumeParentAuthorization(input: A1SingleApprovalBrokerParentInput): Promise<unknown>
  recordDispatchAuthorization(input: A1SingleApprovalBrokerSubgateInput): Promise<unknown>
  recordEnqueueAuthorization(input: A1SingleApprovalBrokerSubgateInput): Promise<unknown>
  materializeExactJobSet(input: A1SingleApprovalBrokerMaterializeInput): Promise<unknown>
  recordExecutionAuthorization(input: A1SingleApprovalBrokerSubgateInput): Promise<unknown>
  recordExecutionArm(input: A1SingleApprovalBrokerSubgateInput): Promise<unknown>
  activateExecutionWindow(input: A1SingleApprovalBrokerSubgateInput): Promise<unknown>
  dispatchOnce(input: A1SingleApprovalBrokerDispatchInput): Promise<unknown>
  recontain(input: A1SingleApprovalBrokerRecontainInput): Promise<unknown>
  auditTerminal(input: A1SingleApprovalBrokerAuditInput): Promise<unknown>
}

export class A1SingleApprovalBrokerAdapterError extends Error {
  constructor(readonly code: string, readonly stage: string) {
    super(code)
    this.name = 'A1SingleApprovalBrokerAdapterError'
  }
}

interface AdapterOptions {
  request: unknown
  envelope: unknown
  authorizationBytes: Buffer
  port: A1SingleApprovalBrokerPort
  now?: Date
}

export function createA1SingleApprovalBrokerAdapter(
  options: AdapterOptions,
): A1SingleApprovalCoordinatorAdapter {
  const now = options.now ?? new Date()
  const bundle = deriveA1SingleApprovalSubgates(
    options.request,
    options.envelope,
    options.authorizationBytes,
    now,
  )
  return new DeterministicA1SingleApprovalBrokerAdapter(bundle, options.port)
}

class DeterministicA1SingleApprovalBrokerAdapter
implements A1SingleApprovalCoordinatorAdapter {
  private readonly requestHash: string
  private readonly envelopeHash: string
  private readonly invoked = new Set<string>()
  private nextTick = 1

  constructor(
    private readonly bundle: A1SingleApprovalSubgateBundle,
    private readonly port: A1SingleApprovalBrokerPort,
  ) {
    assertPort(port)
    this.requestHash = hashAction(bundle.request)
    this.envelopeHash = hashAction(bundle.authorization)
  }

  async inspect(context: A1SingleApprovalStageContext): Promise<A1SingleApprovalControlState> {
    this.assertContext(context, 'audit_terminal_state', true)
    return validateControlState(
      await this.call('inspect', () => this.port.inspect(this.bundle.request.mission_id)),
      this.bundle.request.mission_id,
    )
  }

  async consumeParentAuthorization(
    context: A1SingleApprovalStageContext,
  ): Promise<A1SingleApprovalOperationResult> {
    const stage = 'consume_parent_authorization' as const
    this.assertContext(context, stage)
    this.claimOnce(stage)
    const response = await this.call(stage, () => this.port.consumeParentAuthorization({
      request_id: this.bundle.request.request_id,
      mission_id: this.bundle.request.mission_id,
      trace_id: this.bundle.request.trace_id,
      authorization_digest_sha256: this.bundle.request.authorization_digest_sha256,
      user_authorization_sha256: this.bundle.authorization.user_authorization_sha256,
      expected_mission_sha256: this.bundle.request.expected_mission_sha256,
      assignment_plan_sha256: this.bundle.request.assignment_plan_sha256,
      job_set_sha256: this.bundle.request.job_set_sha256,
      assignment_ids: [...this.bundle.request.assignment_ids],
      worker_id: this.bundle.request.worker_id,
      maximum_dispatch_ticks: this.bundle.request.maximum_dispatch_ticks,
      maximum_provider_credit_spend_usd: this.bundle.request.maximum_provider_credit_spend_usd,
      reviewer_id: this.bundle.authorization.reviewer_id,
      reviewer_email: this.bundle.authorization.reviewer_email,
      reviewed_at: this.bundle.authorization.reviewed_at,
      expires_at: this.bundle.authorization.expires_at,
      stage_receipt_keys: structuredClone(this.bundle.authorization.stage_receipt_keys),
      stage_receipt_key: context.stage_receipt_key,
      idempotency_key: context.stage_receipt_key,
    }))
    return operation(response, context, ['consumed'], { consumed: true })
  }

  async registerAssignmentPlanAuthorization(
    context: A1SingleApprovalStageContext,
  ): Promise<A1SingleApprovalOperationResult> {
    return this.recordSubgate(
      context,
      'register_assignment_plan_authorization',
      this.bundle.wire.dispatchAuthorization,
      this.bundle.identifiers.dispatchAuthorizationId,
      (input) => this.port.recordDispatchAuthorization(input),
    )
  }

  async registerEnqueueAuthorization(
    context: A1SingleApprovalStageContext,
  ): Promise<A1SingleApprovalOperationResult> {
    return this.recordSubgate(
      context,
      'register_enqueue_authorization',
      this.bundle.wire.enqueueAuthorization,
      this.bundle.identifiers.enqueueAuthorizationId,
      (input) => this.port.recordEnqueueAuthorization(input),
    )
  }

  async materializeExactJobSet(
    context: A1SingleApprovalStageContext,
  ): Promise<A1SingleApprovalOperationResult> {
    const stage = 'materialize_exact_job_set' as const
    this.assertContext(context, stage)
    this.claimOnce(stage)
    const response = await this.call(stage, () => this.port.materializeExactJobSet({
      mission_id: this.bundle.request.mission_id,
      stage_receipt_key: context.stage_receipt_key,
      user_authorization_sha256: context.user_authorization_sha256,
      assignment_plan: structuredClone(this.bundle.assignmentPlan),
    }))
    return operation(
      response,
      context,
      ['assignment_ids', 'queued'],
      {
        assignment_ids: this.bundle.request.assignment_ids,
        queued: true,
      },
    )
  }

  async registerExecutionAuthorization(
    context: A1SingleApprovalStageContext,
  ): Promise<A1SingleApprovalOperationResult> {
    return this.recordSubgate(
      context,
      'register_execution_authorization',
      this.bundle.wire.executionAuthorization,
      this.bundle.identifiers.executionAuthorizationId,
      (input) => this.port.recordExecutionAuthorization(input),
    )
  }

  async createExecutionArm(
    context: A1SingleApprovalStageContext,
  ): Promise<A1SingleApprovalOperationResult> {
    return this.recordSubgate(
      context,
      'create_execution_arm',
      this.bundle.wire.executionArm,
      this.bundle.identifiers.armId,
      (input) => this.port.recordExecutionArm(input),
    )
  }

  async openExecutionWindow(
    context: A1SingleApprovalStageContext,
  ): Promise<A1SingleApprovalOperationResult> {
    const stage = 'open_execution_window' as const
    this.assertContext(context, stage)
    this.claimOnce(stage)
    const response = await this.call(stage, () => this.port.activateExecutionWindow({
      mission_id: this.bundle.request.mission_id,
      stage_receipt_key: context.stage_receipt_key,
      user_authorization_sha256: context.user_authorization_sha256,
      body: structuredClone(this.bundle.wire.executionWindow),
    }))
    return operation(
      response,
      context,
      ['resource_id', 'execution_window_open', 'dispatch_claiming_permitted'],
      {
        resource_id: this.bundle.identifiers.windowAuthorizationId,
        execution_window_open: true,
        dispatch_claiming_permitted: true,
      },
    )
  }

  async dispatchOne(
    context: A1SingleApprovalStageContext & { tick: number },
  ): Promise<A1SingleApprovalOperationResult> {
    const stage = 'dispatch_bounded_dag' as const
    this.assertContext(context, stage)
    if (context.tick !== this.nextTick || context.tick > this.bundle.request.maximum_dispatch_ticks)
      throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_TICK_INVALID', stage)
    this.claimOnce(`${stage}:${context.tick}`)
    this.nextTick += 1
    const response = await this.call(stage, () => this.port.dispatchOnce({
      mission_id: this.bundle.request.mission_id,
      worker_id: this.bundle.request.worker_id,
      tick: context.tick,
      stage_receipt_key: context.stage_receipt_key,
      user_authorization_sha256: context.user_authorization_sha256,
    }))
    return operation(
      response,
      context,
      ['processed', 'job_id', 'retry_attempted', 'tick'],
      {
        processed: true,
        job_id: this.bundle.request.assignment_ids[context.tick - 1],
        retry_attempted: false,
        tick: context.tick,
      },
    )
  }

  async recontainExecutionWindow(
    context: A1SingleApprovalStageContext & { reason: string },
  ): Promise<A1SingleApprovalOperationResult> {
    const stage = 'recontain_execution_window' as const
    this.assertContext(context, stage)
    if (!/^A1_SINGLE_APPROVAL_(CHAIN_COMPLETED|FAILED:[a-z_]+)$/.test(context.reason))
      throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_REASON_INVALID', stage)
    this.claimOnce(stage)
    const response = await this.call(stage, () => this.port.recontain({
      mission_id: this.bundle.request.mission_id,
      reason: context.reason,
      stage_receipt_key: context.stage_receipt_key,
      user_authorization_sha256: context.user_authorization_sha256,
    }))
    return operation(response, context, ['recontained'], { recontained: true })
  }

  async auditTerminalState(
    context: A1SingleApprovalStageContext,
  ): Promise<A1SingleApprovalOperationResult> {
    const stage = 'audit_terminal_state' as const
    this.assertContext(context, stage)
    this.claimOnce(stage)
    const response = await this.call(stage, () => this.port.auditTerminal({
      mission_id: this.bundle.request.mission_id,
      assignment_ids: [...this.bundle.request.assignment_ids],
      maximum_provider_credit_spend_usd: this.bundle.request.maximum_provider_credit_spend_usd,
      stage_receipt_key: context.stage_receipt_key,
      user_authorization_sha256: context.user_authorization_sha256,
    }))
    const value = object(response, stage)
    exactKeys(value, commonKeys().concat([
      'verdict', 'completed_jobs', 'usage_value_consumed_usd',
    ]), stage)
    assertCommonResponse(value, context, stage)
    if (
      value.verdict !== 'pass' ||
      value.completed_jobs !== this.bundle.request.assignment_count ||
      typeof value.usage_value_consumed_usd !== 'number' ||
      !Number.isFinite(value.usage_value_consumed_usd) ||
      value.usage_value_consumed_usd < 0 ||
      microUsd(value.usage_value_consumed_usd) >
        microUsd(this.bundle.request.maximum_provider_credit_spend_usd)
    ) throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_AUDIT_INVALID', stage)
    return {
      status: 'completed',
      mission_id: this.bundle.request.mission_id,
      external_actions: 0,
      crm_writes: 0,
      verdict: 'pass',
      completed_jobs: value.completed_jobs,
      usage_value_consumed_usd: value.usage_value_consumed_usd,
    }
  }

  private async recordSubgate(
    context: A1SingleApprovalStageContext,
    stage: Stage,
    body: Record<string, unknown>,
    resourceId: string,
    invoke: (input: A1SingleApprovalBrokerSubgateInput) => Promise<unknown>,
  ): Promise<A1SingleApprovalOperationResult> {
    this.assertContext(context, stage)
    this.claimOnce(stage)
    const response = await this.call(stage, () => invoke({
      mission_id: this.bundle.request.mission_id,
      stage_receipt_key: context.stage_receipt_key,
      user_authorization_sha256: context.user_authorization_sha256,
      body: structuredClone(body),
    }))
    return operation(response, context, ['resource_id'], { resource_id: resourceId })
  }

  private assertContext(
    context: A1SingleApprovalStageContext,
    stage: Stage,
    allowAuditContext = false,
  ): void {
    if (
      (!allowAuditContext && context.stage !== stage) ||
      (allowAuditContext && context.stage !== 'audit_terminal_state') ||
      context.stage_receipt_key !== this.bundle.authorization.stage_receipt_keys[context.stage] ||
      context.user_authorization_sha256 !== this.bundle.authorization.user_authorization_sha256 ||
      hashAction(context.request) !== this.requestHash ||
      hashAction(context.envelope) !== this.envelopeHash
    ) throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_CONTEXT_INVALID', stage)
  }

  private claimOnce(key: string): void {
    if (this.invoked.has(key))
      throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_DUPLICATE_CALL', key)
    this.invoked.add(key)
  }

  private async call(stage: string, operation: () => Promise<unknown>): Promise<unknown> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof A1SingleApprovalBrokerAdapterError) throw error
      throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_PORT_FAILED', stage)
    }
  }
}

function operation(
  response: unknown,
  context: A1SingleApprovalStageContext,
  fields: string[],
  expected: Record<string, unknown>,
): A1SingleApprovalOperationResult {
  const value = object(response, context.stage)
  exactKeys(value, commonKeys().concat(fields), context.stage)
  assertCommonResponse(value, context, context.stage)
  for (const [key, wanted] of Object.entries(expected)) {
    const actual = value[key]
    if (Array.isArray(wanted)) {
      if (!Array.isArray(actual) || actual.join('\0') !== wanted.join('\0'))
        throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_RESPONSE_INVALID', context.stage)
    } else if (actual !== wanted) {
      throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_RESPONSE_INVALID', context.stage)
    }
  }
  return {
    status: 'completed',
    mission_id: context.request.mission_id,
    external_actions: 0,
    crm_writes: 0,
    ...expected,
  }
}

function validateControlState(response: unknown, missionId: string): A1SingleApprovalControlState {
  const stage = 'inspect'
  const value = object(response, stage)
  exactKeys(value, [
    'mission_id', 'channel_kills', 'external_actions_blocked', 'timer_enabled',
    'timer_active', 'external_actions', 'crm_writes', 'crm_outbox', 'global_kill',
    'execution_window_open', 'dispatch_claiming_permitted', 'active_or_uncertain_jobs',
    'parent_authorization_consumed', 'completed_jobs', 'usage_value_consumed_usd',
  ], stage)
  if (
    value.mission_id !== missionId || value.channel_kills !== 7 ||
    value.external_actions_blocked !== true || value.timer_enabled !== false ||
    value.timer_active !== false || value.external_actions !== 0 ||
    value.crm_writes !== 0 || value.crm_outbox !== 0 ||
    typeof value.global_kill !== 'boolean' ||
    typeof value.execution_window_open !== 'boolean' ||
    typeof value.dispatch_claiming_permitted !== 'boolean' ||
    typeof value.parent_authorization_consumed !== 'boolean' ||
    !nonNegativeInteger(value.active_or_uncertain_jobs) ||
    !nonNegativeInteger(value.completed_jobs) ||
    typeof value.usage_value_consumed_usd !== 'number' ||
    !Number.isFinite(value.usage_value_consumed_usd) ||
    value.usage_value_consumed_usd < 0
  ) throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_CONTROL_STATE_INVALID', stage)
  return structuredClone(value) as unknown as A1SingleApprovalControlState
}

function assertCommonResponse(
  value: Record<string, unknown>,
  context: A1SingleApprovalStageContext,
  stage: string,
): void {
  if (
    value.status !== 'completed' || value.mission_id !== context.request.mission_id ||
    value.stage_receipt_key !== context.stage_receipt_key ||
    value.external_actions !== 0 || value.crm_writes !== 0
  ) throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_RESPONSE_INVALID', stage)
}

function assertPort(value: unknown): asserts value is A1SingleApprovalBrokerPort {
  const methods: ReadonlyArray<keyof A1SingleApprovalBrokerPort> = [
    'inspect', 'consumeParentAuthorization', 'recordDispatchAuthorization',
    'recordEnqueueAuthorization', 'materializeExactJobSet',
    'recordExecutionAuthorization', 'recordExecutionArm', 'activateExecutionWindow',
    'dispatchOnce', 'recontain', 'auditTerminal',
  ]
  if (!value || typeof value !== 'object')
    throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_PORT_INVALID', 'initialize')
  for (const method of methods) {
    if (typeof (value as Record<string, unknown>)[method] !== 'function')
      throw new A1SingleApprovalBrokerAdapterError(
        `A1_BROKER_ADAPTER_PORT_METHOD_MISSING:${method}`,
        'initialize',
      )
  }
}

function commonKeys(): string[] {
  return ['status', 'mission_id', 'stage_receipt_key', 'external_actions', 'crm_writes']
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], stage: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_RESPONSE_EXPANDED', stage)
}

function object(value: unknown, stage: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new A1SingleApprovalBrokerAdapterError('A1_BROKER_ADAPTER_RESPONSE_INVALID', stage)
  return value as Record<string, unknown>
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function microUsd(value: number): number {
  return Math.round(value * 1_000_000)
}
