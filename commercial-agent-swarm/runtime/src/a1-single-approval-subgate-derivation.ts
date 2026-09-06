import { hashAction } from './canonical.js'
import type { AssignmentPlan } from './assignment-plan.js'
import {
  validateA1DispatchAuthorizationRequest,
  type A1DispatchAuthorizationRequest,
} from './a1-dispatch-authorization.js'
import {
  validateA1AssignmentEnqueueAuthorizationRequest,
  type A1AssignmentEnqueueAuthorizationRequest,
} from './a1-assignment-enqueue-authorization.js'
import {
  validateA1AssignmentExecutionAuthorizationRequest,
  type A1AssignmentExecutionAuthorizationRequest,
} from './a1-assignment-execution-authorization.js'
import {
  validateA1DispatchExecutionArmRequest,
  type A1DispatchExecutionArmRequest,
} from './a1-dispatch-execution-arm.js'
import {
  validateA1DispatchExecutionWindowRequest,
  type A1DispatchExecutionWindowRequest,
} from './a1-dispatch-execution-window.js'
import {
  validateA1SingleApprovalChainAuthorization,
  type A1SingleApprovalChainAuthorization,
  type A1SingleApprovalChainRequest,
} from './a1-single-approval-chain.js'

export interface A1SingleApprovalSubgateIdentifiers {
  dispatchAuthorizationId: string
  enqueueAuthorizationId: string
  executionAuthorizationId: string
  armId: string
  armAuthorizationId: string
  windowAuthorizationId: string
}

export interface A1SingleApprovalSubgateWireBodies {
  dispatchAuthorization: Record<string, unknown>
  enqueueAuthorization: Record<string, unknown>
  executionAuthorization: Record<string, unknown>
  executionArm: Record<string, unknown>
  executionWindow: Record<string, unknown>
}

export interface A1SingleApprovalValidatedSubgates {
  dispatchAuthorization: A1DispatchAuthorizationRequest
  enqueueAuthorization: A1AssignmentEnqueueAuthorizationRequest
  executionAuthorization: A1AssignmentExecutionAuthorizationRequest
  executionArm: A1DispatchExecutionArmRequest
  executionWindow: A1DispatchExecutionWindowRequest
}

export interface A1SingleApprovalSubgateBundle {
  request: A1SingleApprovalChainRequest
  authorization: A1SingleApprovalChainAuthorization
  assignmentPlan: AssignmentPlan
  identifiers: A1SingleApprovalSubgateIdentifiers
  wire: A1SingleApprovalSubgateWireBodies
  validated: A1SingleApprovalValidatedSubgates
}

export class A1SingleApprovalSubgateDerivationError extends Error {
  constructor(readonly code: string) { super(code) }
}

export function deriveA1SingleApprovalSubgates(
  requestValue: unknown,
  authorizationValue: unknown,
  authorizationBytes: Buffer,
  now = new Date(),
): A1SingleApprovalSubgateBundle {
  try {
    const authorization = validateA1SingleApprovalChainAuthorization(
      authorizationValue,
      requestValue,
      authorizationBytes,
      now,
    )
    const request = requestValue as A1SingleApprovalChainRequest
    const assignmentPlan = structuredClone(request.assignment_plan)
    const rationale = authorization.rationale
    const reviewedAt = authorization.reviewed_at
    const shortExpiry = new Date(Math.min(
      Date.parse(authorization.expires_at),
      Date.parse(reviewedAt) + 10 * 60_000,
    )).toISOString()

    const dispatchIdempotencyKey = stageIdempotencyKey(
      'a1-dispatch-auth',
      authorization.stage_receipt_keys.register_assignment_plan_authorization,
    )
    const enqueueIdempotencyKey = stageIdempotencyKey(
      'a1-enqueue-auth',
      authorization.stage_receipt_keys.register_enqueue_authorization,
    )
    const executionIdempotencyKey = stageIdempotencyKey(
      'a1-execution-auth',
      authorization.stage_receipt_keys.register_execution_authorization,
    )
    const armIdempotencyKey = stageIdempotencyKey(
      'a1-execution-arm',
      authorization.stage_receipt_keys.create_execution_arm,
    )
    const windowIdempotencyKey = stageIdempotencyKey(
      'a1-execution-window',
      authorization.stage_receipt_keys.open_execution_window,
    )

    const identifiers: A1SingleApprovalSubgateIdentifiers = {
      dispatchAuthorizationId: deterministicUuid(hashAction({
        mission_id: request.mission_id,
        idempotency_key: dispatchIdempotencyKey,
      })),
      enqueueAuthorizationId: deterministicUuid(hashAction({
        mission_id: request.mission_id,
        idempotency_key: enqueueIdempotencyKey,
      })),
      executionAuthorizationId: deterministicUuid(hashAction({
        mission_id: request.mission_id,
        idempotency_key: executionIdempotencyKey,
      })),
      armId: deterministicUuid(hashAction({
        type: 'a1-dispatch-execution-arm',
        mission_id: request.mission_id,
        idempotency_key: armIdempotencyKey,
      })),
      armAuthorizationId: deterministicUuid(hashAction({
        type: 'a1-dispatch-execution-arm-authorization',
        mission_id: request.mission_id,
        idempotency_key: armIdempotencyKey,
      })),
      windowAuthorizationId: deterministicUuid(hashAction({
        type: 'a1-dispatch-execution-window',
        mission_id: request.mission_id,
        idempotency_key: windowIdempotencyKey,
      })),
    }

    const common = {
      decision: 'approved',
      rationale,
      reviewer_id: authorization.reviewer_id,
      reviewer_email: authorization.reviewer_email,
      reviewed_at: reviewedAt,
      expected_mission_sha256: request.expected_mission_sha256,
      user_authorization_sha256: authorization.user_authorization_sha256,
    } as const

    const wire: A1SingleApprovalSubgateWireBodies = {
      dispatchAuthorization: {
        ...common,
        expires_at: authorization.expires_at,
        attestations: {
          exact_assignment_plan_confirmed: true,
          authorization_record_only: true,
          no_assignments_created: true,
          no_dispatch_queued: true,
          no_execution: true,
          no_contact: true,
          no_crm_write: true,
          no_external_actions: true,
          no_provider_credit_spend: true,
          global_kill_switch_required: true,
        },
        idempotency_key: dispatchIdempotencyKey,
        assignment_plan: structuredClone(assignmentPlan),
      },
      enqueueAuthorization: {
        ...common,
        expires_at: authorization.expires_at,
        expected_assignment_plan_sha256: request.assignment_plan_sha256,
        expected_dispatch_authorization_id: identifiers.dispatchAuthorizationId,
        attestations: {
          exact_enqueue_confirmed: true,
          authorization_record_only: true,
          no_assignments_enqueued_by_authorization: true,
          no_execution: true,
          no_contact: true,
          no_crm_write: true,
          no_external_actions: true,
          no_provider_credit_spend: true,
          global_kill_switch_required: true,
        },
        idempotency_key: enqueueIdempotencyKey,
        assignment_plan: structuredClone(assignmentPlan),
      },
      executionAuthorization: {
        ...common,
        expires_at: authorization.expires_at,
        expected_assignment_plan_sha256: request.assignment_plan_sha256,
        expected_job_set_sha256: request.job_set_sha256,
        expected_enqueue_authorization_id: identifiers.enqueueAuthorizationId,
        maximum_provider_credit_spend_usd: request.maximum_provider_credit_spend_usd,
        attestations: {
          exact_job_set_confirmed: true,
          authorization_record_only: true,
          no_jobs_claimed_by_authorization: true,
          no_execution: true,
          no_internet: true,
          no_contact: true,
          no_crm_write: true,
          no_external_actions: true,
          no_provider_credit_spend: true,
          global_kill_switch_required: true,
          execution_arm_requires_separate_gate: true,
        },
        idempotency_key: executionIdempotencyKey,
        assignment_plan: structuredClone(assignmentPlan),
      },
      executionArm: {
        ...common,
        starts_at: reviewedAt,
        expires_at: shortExpiry,
        expected_assignment_plan_sha256: request.assignment_plan_sha256,
        expected_job_set_sha256: request.job_set_sha256,
        expected_execution_authorization_id: identifiers.executionAuthorizationId,
        worker_id: request.worker_id,
        maximum_claims: request.assignment_count,
        maximum_provider_credit_spend_usd: request.maximum_provider_credit_spend_usd,
        attestations: {
          exact_job_set_confirmed: true,
          single_use_arm_confirmed: true,
          arm_creation_only: true,
          no_jobs_claimed_by_arm_creation: true,
          no_execution: true,
          no_internet: true,
          no_contact: true,
          no_crm_write: true,
          no_external_actions: true,
          no_provider_credit_spend: true,
          global_kill_switch_must_remain_active: true,
          dispatcher_window_requires_separate_gate: true,
          external_channels_blocked: true,
          timer_disabled_confirmed: true,
        },
        idempotency_key: armIdempotencyKey,
        assignment_plan: structuredClone(assignmentPlan),
      },
      executionWindow: {
        ...common,
        opens_at: reviewedAt,
        expires_at: shortExpiry,
        expected_arm_id: identifiers.armId,
        expected_arm_authorization_id: identifiers.armAuthorizationId,
        expected_execution_authorization_id: identifiers.executionAuthorizationId,
        expected_assignment_plan_sha256: request.assignment_plan_sha256,
        expected_job_set_sha256: request.job_set_sha256,
        worker_id: request.worker_id,
        maximum_claims: request.assignment_count,
        maximum_provider_credit_spend_usd: request.maximum_provider_credit_spend_usd,
        attestations: {
          exact_arm_confirmed: true,
          exact_mission_confirmed: true,
          single_mission_window_confirmed: true,
          provider_credit_spend_authorized: true,
          automatic_recontainment_required: true,
          global_kill_switch_may_open_only_for_window: true,
          external_channels_blocked: true,
          maximum_external_actions_zero: true,
          no_contact: true,
          no_crm_write: true,
          a3_blocked: true,
          mail_blocked: true,
          telegram_blocked: true,
          timer_disabled_confirmed: true,
        },
        idempotency_key: windowIdempotencyKey,
      },
    }

    const validated: A1SingleApprovalValidatedSubgates = {
      dispatchAuthorization: validateA1DispatchAuthorizationRequest(wire.dispatchAuthorization, now),
      enqueueAuthorization: validateA1AssignmentEnqueueAuthorizationRequest(wire.enqueueAuthorization, now),
      executionAuthorization: validateA1AssignmentExecutionAuthorizationRequest(wire.executionAuthorization, now),
      executionArm: validateA1DispatchExecutionArmRequest(wire.executionArm, now),
      executionWindow: validateA1DispatchExecutionWindowRequest(wire.executionWindow, now),
    }

    return { request, authorization, assignmentPlan, identifiers, wire, validated }
  } catch (error) {
    if (error instanceof A1SingleApprovalSubgateDerivationError) throw error
    throw new A1SingleApprovalSubgateDerivationError('A1_SINGLE_APPROVAL_SUBGATE_DERIVATION_INVALID')
  }
}

function stageIdempotencyKey(prefix: string, receipt: string): string {
  return `${prefix}:${receipt.slice(0, 32)}`
}

function deterministicUuid(sha256: string): string {
  const chars = sha256.slice(0, 32).split('')
  chars[12] = '5'
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16]!, 16) % 4]!
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
