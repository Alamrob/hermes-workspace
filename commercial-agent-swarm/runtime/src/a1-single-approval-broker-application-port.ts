import {
  type ApplicationRequest,
  type ApplicationResponse,
  type BrokerApplication,
} from './application.js'
import { validateA1DispatchAuthorizationState } from './a1-dispatch-authorization.js'
import { validateA1AssignmentEnqueueAuthorizationState } from './a1-assignment-enqueue-authorization.js'
import { validateA1AssignmentExecutionAuthorizationState } from './a1-assignment-execution-authorization.js'
import { validateA1DispatchExecutionArmState } from './a1-dispatch-execution-arm.js'
import { validateA1DispatchExecutionWindowState } from './a1-dispatch-execution-window.js'
import type { MissionExecution } from './dispatch-queue.js'
import type { A1SingleApprovalControlState } from './a1-single-approval-coordinator.js'
import type {
  A1SingleApprovalBrokerAuditInput,
  A1SingleApprovalBrokerDispatchInput,
  A1SingleApprovalBrokerMaterializeInput,
  A1SingleApprovalBrokerParentInput,
  A1SingleApprovalBrokerPort,
  A1SingleApprovalBrokerRecontainInput,
  A1SingleApprovalBrokerSubgateInput,
} from './a1-single-approval-broker-adapter.js'

type ApplicationBoundary = Pick<BrokerApplication, 'handle'>

export interface A1SingleApprovalControlCapability {
  inspect(missionId: string): Promise<A1SingleApprovalControlState>
  consumeParentAuthorization(input: A1SingleApprovalBrokerParentInput): Promise<unknown>
  dispatchOnce(input: A1SingleApprovalBrokerDispatchInput): Promise<unknown>
  recontain(input: A1SingleApprovalBrokerRecontainInput): Promise<unknown>
}

export interface A1SingleApprovalBrokerApplicationPortOptions {
  application: ApplicationBoundary
  control: A1SingleApprovalControlCapability
  shadowReviewBearer: () => Promise<string>
  controlPlaneBearer: () => Promise<string>
  internalBearer: () => Promise<string>
}

export class A1SingleApprovalBrokerApplicationPortError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'A1SingleApprovalBrokerApplicationPortError'
  }
}

/**
 * Concrete in-process boundary for the deterministic A1 adapter.
 *
 * It routes only the five existing, capability-authenticated BrokerApplication
 * subgate methods and the exact assignment endpoint. Dispatch and containment
 * remain narrow injected control capabilities; there is deliberately no
 * generic HTTP client, arbitrary path, scheduler, or retry loop.
 */
export class A1SingleApprovalBrokerApplicationPort
implements A1SingleApprovalBrokerPort {
  constructor(private readonly options: A1SingleApprovalBrokerApplicationPortOptions) {
    for (const bearer of [
      options.shadowReviewBearer,
      options.controlPlaneBearer,
      options.internalBearer,
    ]) {
      if (typeof bearer !== 'function')
        throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_CONFIGURATION_INVALID')
    }
  }

  async inspect(missionId: string): Promise<unknown> {
    return this.options.control.inspect(missionId)
  }

  async consumeParentAuthorization(input: A1SingleApprovalBrokerParentInput): Promise<unknown> {
    const response = record(await this.options.control.consumeParentAuthorization(input))
    exactKeys(response, ['consumed'])
    if (response.consumed !== true)
      throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_PARENT_NOT_CONSUMED')
    return common(input, { consumed: true })
  }

  async recordDispatchAuthorization(input: A1SingleApprovalBrokerSubgateInput): Promise<unknown> {
    const state = validateA1DispatchAuthorizationState(await this.postShadow(
      `/internal/v1/a1-dispatch-authorizations/${input.mission_id}`,
      input.body,
    ))
    assertStateBinding(state.missionId, state.userAuthorizationSha256, input)
    return common(input, { resource_id: state.authorizationId })
  }

  async recordEnqueueAuthorization(input: A1SingleApprovalBrokerSubgateInput): Promise<unknown> {
    const state = validateA1AssignmentEnqueueAuthorizationState(await this.postShadow(
      `/internal/v1/a1-assignment-enqueue-authorizations/${input.mission_id}`,
      input.body,
    ))
    assertStateBinding(state.missionId, state.userAuthorizationSha256, input)
    return common(input, { resource_id: state.authorizationId })
  }

  async materializeExactJobSet(input: A1SingleApprovalBrokerMaterializeInput): Promise<unknown> {
    const body = record(await this.call({
      method: 'POST',
      path: `/v1/missions/${input.mission_id}/assignments`,
      headers: { authorization: `Bearer ${await this.secret(this.options.controlPlaneBearer)}` },
      body: structuredClone(input.assignment_plan),
    }, 202))
    exactKeys(body, ['mission_id', 'assignment_ids', 'status'])
    if (
      body.mission_id !== input.mission_id || body.status !== 'queued' ||
      !sameStrings(body.assignment_ids, input.assignment_plan.assignments.map((item) => item.assignment_id))
    ) throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_ASSIGNMENTS_INVALID')
    return common(input, {
      assignment_ids: input.assignment_plan.assignments.map((item) => item.assignment_id),
      queued: true,
    })
  }

  async recordExecutionAuthorization(input: A1SingleApprovalBrokerSubgateInput): Promise<unknown> {
    const state = validateA1AssignmentExecutionAuthorizationState(await this.postShadow(
      `/internal/v1/a1-assignment-execution-authorizations/${input.mission_id}`,
      input.body,
    ))
    assertStateBinding(state.missionId, state.userAuthorizationSha256, input)
    return common(input, { resource_id: state.authorizationId })
  }

  async recordExecutionArm(input: A1SingleApprovalBrokerSubgateInput): Promise<unknown> {
    const state = validateA1DispatchExecutionArmState(await this.postShadow(
      `/internal/v1/a1-dispatch-execution-arms/${input.mission_id}`,
      input.body,
    ))
    assertStateBinding(state.missionId, state.userAuthorizationSha256, input)
    return common(input, { resource_id: state.armId })
  }

  async activateExecutionWindow(input: A1SingleApprovalBrokerSubgateInput): Promise<unknown> {
    const state = validateA1DispatchExecutionWindowState(await this.postShadow(
      `/internal/v1/a1-dispatch-execution-windows/${input.mission_id}`,
      input.body,
    ))
    assertStateBinding(state.missionId, state.userAuthorizationSha256, input)
    return common(input, {
      resource_id: state.windowAuthorizationId,
      execution_window_open: true,
      dispatch_claiming_permitted: true,
    })
  }

  async dispatchOnce(input: A1SingleApprovalBrokerDispatchInput): Promise<unknown> {
    const before = await this.execution(input.mission_id)
    assertExpectedPrefix(before, input.tick)
    const result = record(await this.options.control.dispatchOnce(input))
    exactKeys(result, ['status', 'processed', 'external_actions', 'retry_attempted'])
    if (
      result.status !== 'processed' || result.processed !== true ||
      result.external_actions !== 0 || result.retry_attempted !== false
    ) throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_DISPATCH_UNCERTAIN')
    const after = await this.execution(input.mission_id)
    const jobId = assertOneExactTerminalTransition(before, after, input.tick)
    return common(input, {
      processed: true,
      job_id: jobId,
      retry_attempted: false,
      tick: input.tick,
    })
  }

  async recontain(input: A1SingleApprovalBrokerRecontainInput): Promise<unknown> {
    const response = record(await this.options.control.recontain(input))
    exactKeys(response, ['recontained'])
    if (response.recontained !== true)
      throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_RECONTAINMENT_UNPROVEN')
    return common(input, { recontained: true })
  }

  async auditTerminal(input: A1SingleApprovalBrokerAuditInput): Promise<unknown> {
    const [execution, state] = await Promise.all([
      this.execution(input.mission_id),
      this.options.control.inspect(input.mission_id),
    ])
    if (
      execution.status !== 'completed' ||
      !sameStrings(execution.assignments.map((item) => item.assignment_id), input.assignment_ids) ||
      execution.assignments.some((item) => item.status !== 'succeeded' || item.attempts !== 1) ||
      state.global_kill !== true || state.execution_window_open !== false ||
      state.dispatch_claiming_permitted !== false || state.active_or_uncertain_jobs !== 0 ||
      state.completed_jobs !== input.assignment_ids.length || state.external_actions !== 0 ||
      state.crm_writes !== 0 || state.crm_outbox !== 0 ||
      microUsd(state.usage_value_consumed_usd) >
        microUsd(input.maximum_provider_credit_spend_usd)
    ) throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_TERMINAL_AUDIT_FAILED')
    return common(input, {
      verdict: 'pass',
      completed_jobs: state.completed_jobs,
      usage_value_consumed_usd: state.usage_value_consumed_usd,
    })
  }

  private async postShadow(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.call({
      method: 'POST',
      path,
      headers: { authorization: `Bearer ${await this.secret(this.options.shadowReviewBearer)}` },
      body: structuredClone(body),
    }, 200)
  }

  private async execution(missionId: string): Promise<MissionExecution> {
    const body = await this.call({
      method: 'GET',
      path: `/internal/v1/missions/${missionId}/execution`,
      headers: { authorization: `Bearer ${await this.secret(this.options.internalBearer)}` },
    }, 200)
    return validateMissionExecution(body, missionId)
  }

  private async call(request: ApplicationRequest, expectedStatus: number): Promise<unknown> {
    let response: ApplicationResponse
    try {
      response = await this.options.application.handle(request)
    } catch {
      throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_REQUEST_FAILED')
    }
    if (response.status !== expectedStatus)
      throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_REQUEST_FAILED')
    return response.body
  }

  private async secret(loader: () => Promise<string>): Promise<string> {
    let value: string
    try {
      value = await loader()
    } catch {
      throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_CAPABILITY_UNAVAILABLE')
    }
    if (!/^[A-Za-z0-9._~-]{24,512}$/.test(value))
      throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_CAPABILITY_INVALID')
    return value
  }
}

function validateMissionExecution(value: unknown, missionId: string): MissionExecution {
  const input = record(value)
  exactKeys(input, ['mission_id', 'status', 'assignments'])
  if (
    input.mission_id !== missionId ||
    !['queued', 'running', 'completed', 'failed', 'blocked'].includes(String(input.status)) ||
    !Array.isArray(input.assignments) || input.assignments.length > 6
  ) throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_EXECUTION_INVALID')
  const assignments = input.assignments.map((entry) => {
    const item = record(entry)
    exactKeys(item, [
      'assignment_id', 'profile_id', 'status', 'attempts', 'max_attempts',
      'artifact_sha256', 'result_envelope', 'error',
    ])
    if (
      typeof item.assignment_id !== 'string' || typeof item.profile_id !== 'string' ||
      !['queued', 'leased', 'succeeded', 'failed', 'budget_exceeded', 'usage_unknown'].includes(String(item.status)) ||
      !Number.isSafeInteger(item.attempts) || !Number.isSafeInteger(item.max_attempts) ||
      Number(item.attempts) < 0 || Number(item.max_attempts) !== 1 ||
      !(item.artifact_sha256 === null || /^[a-f0-9]{64}$/.test(String(item.artifact_sha256))) ||
      !(item.error === null || typeof item.error === 'string')
    ) throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_EXECUTION_INVALID')
    return structuredClone(item) as unknown as MissionExecution['assignments'][number]
  })
  if (new Set(assignments.map((item) => item.assignment_id)).size !== assignments.length)
    throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_EXECUTION_INVALID')
  return {
    mission_id: missionId,
    status: input.status as MissionExecution['status'],
    assignments,
  }
}

function assertExpectedPrefix(execution: MissionExecution, tick: number): void {
  if (execution.assignments.length !== 6 || tick < 1 || tick > 6)
    throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_DISPATCH_STATE_INVALID')
  for (let index = 0; index < execution.assignments.length; index += 1) {
    const expected = index < tick - 1 ? 'succeeded' : 'queued'
    const attempts = index < tick - 1 ? 1 : 0
    if (execution.assignments[index].status !== expected || execution.assignments[index].attempts !== attempts)
      throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_DISPATCH_STATE_INVALID')
  }
}

function assertOneExactTerminalTransition(
  before: MissionExecution,
  after: MissionExecution,
  tick: number,
): string {
  if (
    after.mission_id !== before.mission_id ||
    after.assignments.length !== before.assignments.length ||
    !sameStrings(
      after.assignments.map((item) => item.assignment_id),
      before.assignments.map((item) => item.assignment_id),
    )
  ) throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_DISPATCH_UNCERTAIN')
  const expectedIndex = tick - 1
  for (let index = 0; index < after.assignments.length; index += 1) {
    const prior = before.assignments[index]
    const current = after.assignments[index]
    if (index === expectedIndex) {
      if (prior.status !== 'queued' || prior.attempts !== 0 || current.status !== 'succeeded' || current.attempts !== 1)
        throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_DISPATCH_UNCERTAIN')
    } else if (prior.status !== current.status || prior.attempts !== current.attempts) {
      throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_DISPATCH_UNCERTAIN')
    }
  }
  return after.assignments[expectedIndex].assignment_id
}

function assertStateBinding(
  missionId: string,
  authorizationSha256: string,
  input: A1SingleApprovalBrokerSubgateInput,
): void {
  if (missionId !== input.mission_id || authorizationSha256 !== input.user_authorization_sha256)
    throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_STATE_BINDING_INVALID')
}

function common(
  input: { mission_id: string; stage_receipt_key: string },
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    status: 'completed',
    mission_id: input.mission_id,
    stage_receipt_key: input.stage_receipt_key,
    external_actions: 0,
    crm_writes: 0,
    ...extra,
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_RESPONSE_INVALID')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new A1SingleApprovalBrokerApplicationPortError('A1_APPLICATION_PORT_RESPONSE_INVALID')
}

function sameStrings(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index])
}

function microUsd(value: number): number {
  return Math.round(value * 1_000_000)
}
