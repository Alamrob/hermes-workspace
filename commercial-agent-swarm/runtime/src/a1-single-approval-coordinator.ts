import {
  A1_SINGLE_APPROVAL_STAGES,
  validateA1SingleApprovalChainAuthorization,
  validateA1SingleApprovalChainRequest,
  type A1SingleApprovalChainAuthorization,
  type A1SingleApprovalChainRequest,
} from './a1-single-approval-chain.js'

type Stage = (typeof A1_SINGLE_APPROVAL_STAGES)[number]

export interface A1SingleApprovalStageContext {
  request: A1SingleApprovalChainRequest
  envelope: A1SingleApprovalChainAuthorization
  stage: Stage
  stage_receipt_key: string
  user_authorization_sha256: string
}

export interface A1SingleApprovalOperationResult extends Record<string, unknown> {
  status: 'completed'
  mission_id: string
  external_actions: 0
  crm_writes: 0
}

export interface A1SingleApprovalControlState {
  mission_id: string
  channel_kills: 7
  external_actions_blocked: true
  timer_enabled: false
  timer_active: false
  external_actions: 0
  crm_writes: 0
  crm_outbox: 0
  global_kill: boolean
  execution_window_open: boolean
  dispatch_claiming_permitted: boolean
  active_or_uncertain_jobs: number
  parent_authorization_consumed: boolean
  completed_jobs: number
  usage_value_consumed_usd: number
}

export interface A1SingleApprovalCoordinatorAdapter {
  inspect(context: A1SingleApprovalStageContext): Promise<A1SingleApprovalControlState>
  consumeParentAuthorization(context: A1SingleApprovalStageContext): Promise<A1SingleApprovalOperationResult>
  registerAssignmentPlanAuthorization(context: A1SingleApprovalStageContext): Promise<A1SingleApprovalOperationResult>
  registerEnqueueAuthorization(context: A1SingleApprovalStageContext): Promise<A1SingleApprovalOperationResult>
  materializeExactJobSet(context: A1SingleApprovalStageContext): Promise<A1SingleApprovalOperationResult>
  registerExecutionAuthorization(context: A1SingleApprovalStageContext): Promise<A1SingleApprovalOperationResult>
  createExecutionArm(context: A1SingleApprovalStageContext): Promise<A1SingleApprovalOperationResult>
  openExecutionWindow(context: A1SingleApprovalStageContext): Promise<A1SingleApprovalOperationResult>
  dispatchOne(context: A1SingleApprovalStageContext & { tick: number }): Promise<A1SingleApprovalOperationResult>
  recontainExecutionWindow(
    context: A1SingleApprovalStageContext & { reason: string },
  ): Promise<A1SingleApprovalOperationResult>
  auditTerminalState(context: A1SingleApprovalStageContext): Promise<A1SingleApprovalOperationResult>
}

export interface A1SingleApprovalReceipt {
  stage: Stage
  stage_receipt_key: string
  result: A1SingleApprovalOperationResult
}

export interface A1SingleApprovalChainResult {
  schema_version: 1
  type: 'a1_single_approval_chain_result_r304'
  request_id: string
  mission_id: string
  status: 'completed'
  parent_authorization_consumed: true
  completed_jobs: 6
  dispatch_ticks: 6
  maximum_provider_credit_spend_usd: number
  usage_value_consumed_usd: number
  external_actions: 0
  crm_writes: 0
  recontained: true
  receipts: A1SingleApprovalReceipt[]
}

export class A1SingleApprovalCoordinatorError extends Error {
  constructor(readonly code: string, readonly stage: string) {
    super(code)
    this.name = 'A1SingleApprovalCoordinatorError'
  }
}

const REQUIRED_METHODS: ReadonlyArray<keyof A1SingleApprovalCoordinatorAdapter> = Object.freeze([
  'inspect',
  'consumeParentAuthorization',
  'registerAssignmentPlanAuthorization',
  'registerEnqueueAuthorization',
  'materializeExactJobSet',
  'registerExecutionAuthorization',
  'createExecutionArm',
  'openExecutionWindow',
  'dispatchOne',
  'recontainExecutionWindow',
  'auditTerminalState',
])

export async function runA1SingleApprovalCoordinator(input: {
  request: unknown
  envelope: unknown
  authorizationBytes: Buffer
  adapter: A1SingleApprovalCoordinatorAdapter
  now?: Date
}): Promise<A1SingleApprovalChainResult> {
  const now = input.now ?? new Date()
  const request = validateA1SingleApprovalChainRequest(input.request, now)
  const envelope = validateA1SingleApprovalChainAuthorization(
    input.envelope,
    request,
    input.authorizationBytes,
    now,
  )
  assertAdapter(input.adapter)

  let stage: Stage | 'preflight' = 'preflight'
  let parentConsumed = false
  let windowMayBeOpen = false
  const receipts: A1SingleApprovalReceipt[] = []
  const record = (name: Stage, result: A1SingleApprovalOperationResult): void => {
    receipts.push(Object.freeze({
      stage: name,
      stage_receipt_key: envelope.stage_receipt_keys[name],
      result: Object.freeze(sanitizeOperationResult(result)),
    }))
  }

  try {
    const before = await input.adapter.inspect(context(request, envelope, 'audit_terminal_state'))
    assertContained(before, request, stage)
    if (before.parent_authorization_consumed !== false || before.completed_jobs !== 0)
      throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_PREEXISTING_CHAIN_STATE', stage)

    stage = 'consume_parent_authorization'
    const consumed = await input.adapter.consumeParentAuthorization(context(request, envelope, stage))
    assertOperation(consumed, request, stage)
    if (consumed.consumed !== true)
      throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_PARENT_NOT_CONSUMED', stage)
    parentConsumed = true
    record(stage, consumed)

    const sequential: ReadonlyArray<[
      Stage,
      keyof Pick<
        A1SingleApprovalCoordinatorAdapter,
        | 'registerAssignmentPlanAuthorization'
        | 'registerEnqueueAuthorization'
        | 'materializeExactJobSet'
        | 'registerExecutionAuthorization'
        | 'createExecutionArm'
      >,
    ]> = [
      ['register_assignment_plan_authorization', 'registerAssignmentPlanAuthorization'],
      ['register_enqueue_authorization', 'registerEnqueueAuthorization'],
      ['materialize_exact_job_set', 'materializeExactJobSet'],
      ['register_execution_authorization', 'registerExecutionAuthorization'],
      ['create_execution_arm', 'createExecutionArm'],
    ]
    for (const [name, method] of sequential) {
      stage = name
      const result = await input.adapter[method](context(request, envelope, name))
      assertOperation(result, request, stage)
      record(name, result)
      const state = await input.adapter.inspect(context(request, envelope, 'audit_terminal_state'))
      assertContained(state, request, stage)
      if (state.parent_authorization_consumed !== true)
        throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_PARENT_CONSUMPTION_LOST', stage)
    }

    stage = 'open_execution_window'
    const opened = await input.adapter.openExecutionWindow(context(request, envelope, stage))
    assertOperation(opened, request, stage)
    if (opened.execution_window_open !== true || opened.dispatch_claiming_permitted !== true)
      throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_WINDOW_NOT_OPEN', stage)
    windowMayBeOpen = true
    record(stage, opened)
    const openState = await input.adapter.inspect(context(request, envelope, 'audit_terminal_state'))
    assertCommonState(openState, request, stage)
    if (
      openState.global_kill !== false ||
      openState.execution_window_open !== true ||
      openState.dispatch_claiming_permitted !== true ||
      openState.parent_authorization_consumed !== true
    ) throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_OPEN_WINDOW_STATE_INVALID', stage)

    stage = 'dispatch_bounded_dag'
    const jobIds = new Set<string>()
    for (let tick = 1; tick <= request.maximum_dispatch_ticks; tick += 1) {
      const result = await input.adapter.dispatchOne({ ...context(request, envelope, stage), tick })
      assertOperation(result, request, stage)
      if (
        result.processed !== true ||
        typeof result.job_id !== 'string' ||
        result.job_id.length < 1 ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(result.job_id) ||
        jobIds.has(result.job_id) ||
        result.retry_attempted !== false
      ) throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_DISPATCH_RESULT_INVALID', stage)
      jobIds.add(result.job_id)
      record(stage, { ...result, tick })
      const state = await input.adapter.inspect(context(request, envelope, 'audit_terminal_state'))
      assertCommonState(state, request, stage)
      if (
        state.global_kill !== false ||
        state.execution_window_open !== true ||
        state.dispatch_claiming_permitted !== true
      ) throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_DISPATCH_AUTHORITY_LOST', stage)
      if (microUsd(state.usage_value_consumed_usd) > microUsd(request.maximum_provider_credit_spend_usd))
        throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_BUDGET_EXCEEDED', stage)
      if (state.active_or_uncertain_jobs !== 0)
        throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_ACTIVE_OR_UNCERTAIN_JOB', stage)
    }
    if (jobIds.size !== request.assignment_count)
      throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_DAG_INCOMPLETE', stage)

    stage = 'recontain_execution_window'
    const recontained = await input.adapter.recontainExecutionWindow({
      ...context(request, envelope, stage),
      reason: 'A1_SINGLE_APPROVAL_CHAIN_COMPLETED',
    })
    assertOperation(recontained, request, stage)
    if (recontained.recontained !== true)
      throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_RECONTAINMENT_FAILED', stage)
    windowMayBeOpen = false
    record(stage, recontained)

    stage = 'audit_terminal_state'
    const audit = await input.adapter.auditTerminalState(context(request, envelope, stage))
    assertOperation(audit, request, stage)
    if (
      audit.verdict !== 'pass' ||
      audit.completed_jobs !== request.assignment_count ||
      typeof audit.usage_value_consumed_usd !== 'number' ||
      !Number.isFinite(audit.usage_value_consumed_usd) ||
      microUsd(audit.usage_value_consumed_usd) > microUsd(request.maximum_provider_credit_spend_usd)
    ) throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_TERMINAL_AUDIT_FAILED', stage)
    const terminal = await input.adapter.inspect(context(request, envelope, stage))
    assertContained(terminal, request, stage)
    if (
      terminal.parent_authorization_consumed !== true ||
      terminal.completed_jobs !== request.assignment_count
    ) throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_TERMINAL_STATE_INVALID', stage)
    record(stage, audit)

    return Object.freeze({
      schema_version: 1,
      type: 'a1_single_approval_chain_result_r304',
      request_id: request.request_id,
      mission_id: request.mission_id,
      status: 'completed',
      parent_authorization_consumed: true,
      completed_jobs: 6,
      dispatch_ticks: 6,
      maximum_provider_credit_spend_usd: request.maximum_provider_credit_spend_usd,
      usage_value_consumed_usd: terminal.usage_value_consumed_usd,
      external_actions: 0,
      crm_writes: 0,
      recontained: true,
      receipts,
    })
  } catch {
    if (parentConsumed || windowMayBeOpen) {
      try {
        const result = await input.adapter.recontainExecutionWindow({
          ...context(request, envelope, 'recontain_execution_window'),
          reason: `A1_SINGLE_APPROVAL_FAILED:${stage}`,
        })
        assertOperation(result, request, 'failure_recontainment')
        const state = await input.adapter.inspect(context(request, envelope, 'audit_terminal_state'))
        assertContained(state, request, 'failure_recontainment')
      } catch {
        throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_RECONTAINMENT_UNPROVEN', stage)
      }
    }
    throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_FAILED_CLOSED', stage)
  }
}

function context(
  request: A1SingleApprovalChainRequest,
  envelope: A1SingleApprovalChainAuthorization,
  stage: Stage,
): A1SingleApprovalStageContext {
  return Object.freeze({
    request,
    envelope,
    stage,
    stage_receipt_key: envelope.stage_receipt_keys[stage],
    user_authorization_sha256: envelope.user_authorization_sha256,
  })
}

function assertAdapter(value: unknown): asserts value is A1SingleApprovalCoordinatorAdapter {
  if (!value || typeof value !== 'object')
    throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_ADAPTER_INVALID', 'initialize')
  for (const method of REQUIRED_METHODS) {
    if (typeof (value as Record<string, unknown>)[method] !== 'function')
      throw new A1SingleApprovalCoordinatorError(
        `A1_SINGLE_APPROVAL_ADAPTER_METHOD_MISSING:${method}`,
        'initialize',
      )
  }
}

function assertOperation(
  result: A1SingleApprovalOperationResult,
  request: A1SingleApprovalChainRequest,
  stage: string,
): void {
  if (
    !result ||
    typeof result !== 'object' ||
    result.status !== 'completed' ||
    result.mission_id !== request.mission_id ||
    result.external_actions !== 0 ||
    result.crm_writes !== 0
  ) throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_OPERATION_RESULT_INVALID', stage)
}

function assertCommonState(
  state: A1SingleApprovalControlState,
  request: A1SingleApprovalChainRequest,
  stage: string,
): void {
  if (
    !state ||
    typeof state !== 'object' ||
    state.mission_id !== request.mission_id ||
    state.channel_kills !== 7 ||
    state.external_actions_blocked !== true ||
    state.timer_enabled !== false ||
    state.timer_active !== false ||
    state.external_actions !== 0 ||
    state.crm_writes !== 0 ||
    state.crm_outbox !== 0 ||
    !Number.isSafeInteger(state.active_or_uncertain_jobs) ||
    state.active_or_uncertain_jobs < 0 ||
    !Number.isSafeInteger(state.completed_jobs) ||
    state.completed_jobs < 0 ||
    state.completed_jobs > request.assignment_count ||
    typeof state.usage_value_consumed_usd !== 'number' ||
    !Number.isFinite(state.usage_value_consumed_usd) ||
    state.usage_value_consumed_usd < 0
  ) throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_CONTROL_STATE_INVALID', stage)
}

function assertContained(
  state: A1SingleApprovalControlState,
  request: A1SingleApprovalChainRequest,
  stage: string,
): void {
  assertCommonState(state, request, stage)
  if (
    state.global_kill !== true ||
    state.execution_window_open !== false ||
    state.dispatch_claiming_permitted !== false ||
    state.active_or_uncertain_jobs !== 0
  ) throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_NOT_CONTAINED', stage)
}

function microUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new A1SingleApprovalCoordinatorError('A1_SINGLE_APPROVAL_USAGE_INVALID', 'budget')
  return Math.round(value * 1_000_000)
}

function sanitizeOperationResult(result: A1SingleApprovalOperationResult): A1SingleApprovalOperationResult {
  const safe: A1SingleApprovalOperationResult = {
    status: 'completed',
    mission_id: result.mission_id,
    external_actions: 0,
    crm_writes: 0,
  }
  for (const field of [
    'consumed',
    'execution_window_open',
    'dispatch_claiming_permitted',
    'processed',
    'job_id',
    'retry_attempted',
    'tick',
    'recontained',
    'verdict',
    'completed_jobs',
    'usage_value_consumed_usd',
  ]) {
    if (field in result) safe[field] = result[field]
  }
  return safe
}
