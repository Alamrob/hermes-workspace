export const AUTOMATIC_REPLY_POLICY_SCHEMA = 'proptimiza-whatsapp-automatic-reply-policy.v1'

const DECIMAL = /^[1-9][0-9]{0,18}$/
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/
const INACTIVE_STATUS = /^(?:candidate_inactive(?:_[a-z0-9]+)*|suspended|revoked)$/
const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const ACTIVATION_CONDITIONS = Object.freeze([
  'v13_or_successor_preflight_fresh',
  'agentbot_and_resources_verified',
  'reviewer_deployed_healthy',
  'supervised_trial_passed',
  'human_takeover_rehearsed',
  'human_capacity_verified',
  'approved_fact_mode_selected',
  'provider_budget_approved',
  'automatic_reply_runtime_binding_implemented',
  'automatic_reply_runtime_binding_tested',
  'automatic_reply_policy_approved',
  'go_live_authorized',
] as const)

const REQUIRED_HANDOFF_ROUTES = Object.freeze([
  'human_requested',
  'pricing_or_quote',
  'payment_or_refund',
  'complaint_or_legal',
  'privacy_or_identity',
  'credentials_or_internal_access',
  'opt_out_or_deletion',
  'emergency_or_safety',
  'attachment_requires_review',
  'missing_context_after_one_useful_question',
] as const)

export interface AutomaticReplyPolicy {
  schema: typeof AUTOMATIC_REPLY_POLICY_SCHEMA
  version: string
  status: string
  scope: {
    channel: 'whatsapp_inbound'
    account_id: string
    inbox_id: string
    inbound_only: true
    outbound_prospecting_allowed: false
    external_channels_allowed: ReadonlyArray<never>
    public_24_7_claim_allowed: false
    human_support_24_7_claim_allowed: false
  }
  runtime_contract: {
    technical_intake_continuous_candidate: true
    maximum_automated_replies_per_conversation_per_24h: number
    maximum_diagnostic_questions_per_reply: number
    maximum_response_characters: number
    human_takeover_stops_automation: true
    automatic_resume_after_takeover: false
    automatic_retry_after_uncertainty: false
    newer_message_invalidates_pending_reply: true
    one_owner_per_event: true
  }
  activation_conditions: Record<(typeof ACTIVATION_CONDITIONS)[number], boolean>
  approval: {
    approved: boolean
    approval_id: string | null
    approved_at: string | null
    activation_authority: boolean
  }
}

export interface AutomaticReplyPolicyDecision {
  allowed: boolean
  stop_code: 'AUTOMATIC_REPLY_POLICY_ACTIVE'
    | 'AUTOMATIC_REPLY_POLICY_INACTIVE'
    | 'AUTOMATIC_REPLY_POLICY_SCOPE_MISMATCH'
  policy: Readonly<AutomaticReplyPolicy>
}

export function parseAutomaticReplyPolicy(text: string): Readonly<AutomaticReplyPolicy> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('AUTOMATIC_REPLY_POLICY_INVALID') }
  const root = record(value)
  const scope = record(root.scope)
  const contract = record(root.runtime_contract)
  const guards = record(root.entry_guards)
  const response = record(root.response_policy)
  const failure = record(root.failure_policy)
  const activation = record(root.activation_conditions)
  const approval = record(root.approval)

  const version = string(root.version)
  const status = string(root.status)
  const accountId = string(scope.account_id)
  const inboxId = string(scope.inbox_id)
  const externalChannels = array(scope.external_channels_allowed)
  const maximumReplies = integer(contract.maximum_automated_replies_per_conversation_per_24h)
  const maximumQuestions = integer(contract.maximum_diagnostic_questions_per_reply)
  const maximumCharacters = integer(contract.maximum_response_characters)

  if (root.schema !== AUTOMATIC_REPLY_POLICY_SCHEMA || !VERSION.test(version)
    || (status !== 'active' && !INACTIVE_STATUS.test(status))
    || scope.channel !== 'whatsapp_inbound' || !DECIMAL.test(accountId) || !DECIMAL.test(inboxId)
    || scope.inbound_only !== true || scope.outbound_prospecting_allowed !== false
    || externalChannels.length !== 0 || scope.public_24_7_claim_allowed !== false
    || scope.human_support_24_7_claim_allowed !== false
    || contract.technical_intake_continuous_candidate !== true
    || maximumReplies < 1 || maximumReplies > 3
    || maximumQuestions !== 1 || maximumCharacters < 200 || maximumCharacters > 1200
    || contract.human_takeover_stops_automation !== true
    || contract.automatic_resume_after_takeover !== false
    || contract.automatic_retry_after_uncertainty !== false
    || contract.newer_message_invalidates_pending_reply !== true
    || contract.one_owner_per_event !== true
    || !allTrue(guards, [
      'policy_version_active_required', 'global_kill_switch_open_required', 'a3_blocked_required',
      'timer_disabled_required', 'account_and_inbox_exact_required', 'latest_inbound_message_exact_required',
      'human_reply_absent_required', 'conversation_hold_absent_required',
      'approved_fact_resolution_required', 'provider_budget_required',
    ])
    || response.facts_must_be_approved !== true || response.prices_must_be_approved !== true
    || response.external_research_allowed !== false || response.secrets_requested_or_disclosed !== false
    || response.commercial_commitments_allowed !== false || response.human_handoff_summary_minimized !== true
    || !containsEveryString(response.mandatory_handoff_routes, REQUIRED_HANDOFF_ROUTES)
    || failure.failed_event_action !== 'hold_for_human'
    || failure.uncertain_event_action !== 'hold_without_retry'
    || failure.provider_unavailable_action !== 'hold_for_human'
    || failure.catalog_unavailable_action !== 'hold_for_human'
    || failure.human_capacity_unavailable_action !== 'pause_automation'
    || failure.guardrail_drift_action !== 'activate_kill_switch_and_pause')
    throw new Error('AUTOMATIC_REPLY_POLICY_INVALID')

  const activationConditions = Object.fromEntries(ACTIVATION_CONDITIONS.map((key) => {
    if (typeof activation[key] !== 'boolean') throw new Error('AUTOMATIC_REPLY_POLICY_INVALID')
    return [key, activation[key]]
  })) as AutomaticReplyPolicy['activation_conditions']
  const approved = boolean(approval.approved)
  const activationAuthority = boolean(approval.activation_authority)
  const approvalId = nullableString(approval.approval_id)
  const approvedAt = nullableString(approval.approved_at)
  if (status === 'active') {
    if (!Object.values(activationConditions).every((condition) => condition === true)
      || !approved || !activationAuthority || approvalId === null || !APPROVAL_ID.test(approvalId)
      || approvedAt === null || !Number.isFinite(Date.parse(approvedAt)))
      throw new Error('AUTOMATIC_REPLY_POLICY_INVALID')
  } else if (approved || activationAuthority || approvalId !== null || approvedAt !== null) {
    throw new Error('AUTOMATIC_REPLY_POLICY_INVALID')
  }

  return Object.freeze({
    schema: AUTOMATIC_REPLY_POLICY_SCHEMA,
    version,
    status,
    scope: Object.freeze({
      channel: 'whatsapp_inbound', account_id: accountId, inbox_id: inboxId,
      inbound_only: true, outbound_prospecting_allowed: false,
      external_channels_allowed: Object.freeze([]), public_24_7_claim_allowed: false,
      human_support_24_7_claim_allowed: false,
    }),
    runtime_contract: Object.freeze({
      technical_intake_continuous_candidate: true,
      maximum_automated_replies_per_conversation_per_24h: maximumReplies,
      maximum_diagnostic_questions_per_reply: maximumQuestions,
      maximum_response_characters: maximumCharacters,
      human_takeover_stops_automation: true,
      automatic_resume_after_takeover: false,
      automatic_retry_after_uncertainty: false,
      newer_message_invalidates_pending_reply: true,
      one_owner_per_event: true,
    }),
    activation_conditions: Object.freeze(activationConditions),
    approval: Object.freeze({
      approved, approval_id: approvalId, approved_at: approvedAt,
      activation_authority: activationAuthority,
    }),
  })
}

export function decideAutomaticReplyPolicy(
  policy: Readonly<AutomaticReplyPolicy>,
  accountId: string,
  inboxId: string,
): AutomaticReplyPolicyDecision {
  if (policy.scope.account_id !== accountId || policy.scope.inbox_id !== inboxId)
    return Object.freeze({ allowed: false, stop_code: 'AUTOMATIC_REPLY_POLICY_SCOPE_MISMATCH', policy })
  if (policy.status !== 'active')
    return Object.freeze({ allowed: false, stop_code: 'AUTOMATIC_REPLY_POLICY_INACTIVE', policy })
  return Object.freeze({ allowed: true, stop_code: 'AUTOMATIC_REPLY_POLICY_ACTIVE', policy })
}

export function automaticReplyResponseAllowed(
  response: string,
  policy: Readonly<AutomaticReplyPolicy>,
): boolean {
  const length = [...response].length
  const questions = response.match(/\?/g)?.length ?? 0
  return response.trim().length > 0
    && length <= policy.runtime_contract.maximum_response_characters
    && questions <= policy.runtime_contract.maximum_diagnostic_questions_per_reply
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AUTOMATIC_REPLY_POLICY_INVALID')
  return value as Record<string, unknown>
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('AUTOMATIC_REPLY_POLICY_INVALID')
  return value
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('AUTOMATIC_REPLY_POLICY_INVALID')
  return value
}
function nullableString(value: unknown): string | null {
  if (value === null) return null
  return string(value)
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('AUTOMATIC_REPLY_POLICY_INVALID')
  return value
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error('AUTOMATIC_REPLY_POLICY_INVALID')
  return Number(value)
}
function allTrue(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => value[key] === true)
}
function containsEveryString(value: unknown, required: readonly string[]): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    && required.every((item) => value.includes(item))
}
