import assert from 'node:assert/strict'
import test from 'node:test'
import {
  automaticReplyResponseAllowed,
  decideAutomaticReplyPolicy,
  parseAutomaticReplyPolicy,
} from '../src/automatic-reply-policy.js'

const activationKeys = [
  'v13_or_successor_preflight_fresh', 'agentbot_and_resources_verified', 'reviewer_deployed_healthy',
  'supervised_trial_passed', 'human_takeover_rehearsed', 'human_capacity_verified',
  'approved_fact_mode_selected', 'provider_budget_approved',
  'automatic_reply_runtime_binding_implemented', 'automatic_reply_runtime_binding_tested',
  'automatic_reply_policy_approved', 'go_live_authorized',
]

function policy(active = false): Record<string, unknown> {
  return {
    schema: 'proptimiza-whatsapp-automatic-reply-policy.v1',
    version: '0.1.0-candidate',
    status: active ? 'active' : 'candidate_inactive_not_wired',
    scope: {
      channel: 'whatsapp_inbound', account_id: '1', inbox_id: '1', inbound_only: true,
      outbound_prospecting_allowed: false, external_channels_allowed: [],
      public_24_7_claim_allowed: false, human_support_24_7_claim_allowed: false,
    },
    runtime_contract: {
      technical_intake_continuous_candidate: true,
      maximum_automated_replies_per_conversation_per_24h: 3,
      maximum_diagnostic_questions_per_reply: 1,
      maximum_response_characters: 1200,
      human_takeover_stops_automation: true, automatic_resume_after_takeover: false,
      automatic_retry_after_uncertainty: false, newer_message_invalidates_pending_reply: true,
      one_owner_per_event: true,
    },
    entry_guards: {
      policy_version_active_required: true, global_kill_switch_open_required: true,
      a3_blocked_required: true, timer_disabled_required: true,
      account_and_inbox_exact_required: true, latest_inbound_message_exact_required: true,
      human_reply_absent_required: true, conversation_hold_absent_required: true,
      approved_fact_resolution_required: true, provider_budget_required: true,
    },
    response_policy: {
      mandatory_handoff_routes: [
        'human_requested', 'pricing_or_quote', 'payment_or_refund', 'complaint_or_legal',
        'privacy_or_identity', 'credentials_or_internal_access', 'opt_out_or_deletion',
        'emergency_or_safety', 'attachment_requires_review',
        'missing_context_after_one_useful_question',
      ],
      facts_must_be_approved: true, prices_must_be_approved: true,
      external_research_allowed: false, secrets_requested_or_disclosed: false,
      commercial_commitments_allowed: false, human_handoff_summary_minimized: true,
    },
    failure_policy: {
      failed_event_action: 'hold_for_human', uncertain_event_action: 'hold_without_retry',
      provider_unavailable_action: 'hold_for_human', catalog_unavailable_action: 'hold_for_human',
      human_capacity_unavailable_action: 'pause_automation',
      guardrail_drift_action: 'activate_kill_switch_and_pause',
    },
    activation_conditions: Object.fromEntries(activationKeys.map((key) => [key, active])),
    approval: active ? {
      approved: true, approval_id: '11111111-1111-5111-8111-111111111111',
      approved_at: '2026-10-04T12:00:00.000Z', activation_authority: true,
    } : { approved: false, approval_id: null, approved_at: null, activation_authority: false },
  }
}

test('accepts a valid inactive candidate but never permits replies', () => {
  const parsed = parseAutomaticReplyPolicy(JSON.stringify(policy()))
  assert.equal(decideAutomaticReplyPolicy(parsed, '1', '1').stop_code, 'AUTOMATIC_REPLY_POLICY_INACTIVE')
  assert.equal(decideAutomaticReplyPolicy(parsed, '1', '1').allowed, false)
})

test('requires every activation condition and consumable approval for active policy', () => {
  const active = policy(true)
  const parsed = parseAutomaticReplyPolicy(JSON.stringify(active))
  assert.equal(decideAutomaticReplyPolicy(parsed, '1', '1').allowed, true)
  ;(active.activation_conditions as Record<string, boolean>).human_capacity_verified = false
  assert.throws(() => parseAutomaticReplyPolicy(JSON.stringify(active)), /AUTOMATIC_REPLY_POLICY_INVALID/)
})

test('pins account and inbox even when a policy is otherwise active', () => {
  const parsed = parseAutomaticReplyPolicy(JSON.stringify(policy(true)))
  assert.equal(decideAutomaticReplyPolicy(parsed, '2', '1').stop_code,
    'AUTOMATIC_REPLY_POLICY_SCOPE_MISMATCH')
})

test('rejects unsafe limits and incomplete mandatory handoff routes', () => {
  const unsafe = policy()
  ;(unsafe.runtime_contract as Record<string, unknown>).maximum_automated_replies_per_conversation_per_24h = 4
  assert.throws(() => parseAutomaticReplyPolicy(JSON.stringify(unsafe)), /AUTOMATIC_REPLY_POLICY_INVALID/)
  const incomplete = policy()
  ;(incomplete.response_policy as Record<string, unknown>).mandatory_handoff_routes = ['human_requested']
  assert.throws(() => parseAutomaticReplyPolicy(JSON.stringify(incomplete)), /AUTOMATIC_REPLY_POLICY_INVALID/)
})

test('enforces response size and at most one diagnostic question', () => {
  const parsed = parseAutomaticReplyPolicy(JSON.stringify(policy(true)))
  assert.equal(automaticReplyResponseAllowed('Cuéntame tu principal desafío. ¿Qué deseas mejorar?', parsed), true)
  assert.equal(automaticReplyResponseAllowed('¿Qué vendes? ¿Cuántas consultas recibes?', parsed), false)
  assert.equal(automaticReplyResponseAllowed('a'.repeat(1201), parsed), false)
  assert.equal(automaticReplyResponseAllowed('   ', parsed), false)
})
