import assert from 'node:assert/strict'
import test from 'node:test'
import type { AutomaticReplyPolicy } from '../src/automatic-reply-policy.js'
import { WhatsAppAutomationService, type WhatsAppAutomationConfig } from '../src/whatsapp-automation-service.js'
import type { ReplyEventRecord, ReplyEventStatus } from '../src/whatsapp-automation-store.js'

const config: WhatsAppAutomationConfig = {
  bindHost: '0.0.0.0', port: 8787, accountId: '1', inboxId: '1', handoffTeamId: '1',
  stateFile: '/var/lib/proptimiza/whatsapp-automation/state.json',
  webhookSecretFile: '/run/secrets/chatwoot_agent_bot_secret',
  agentBotTokenFile: '/run/secrets/chatwoot_agent_bot_token',
  readerTokenFile: '/run/secrets/chatwoot_reader_token', openCodeKeyFile: '/run/secrets/opencode_go_api_key',
  expectedSecretGid: 10000, chatwootBaseUrl: 'http://proptimiza-chatwoot-web-1:3000',
  hermesPython: '/opt/hermes/.venv/bin/python', hermesChildScript: '/app/scripts/hermes_conversation_child.py',
  hermesCwd: '/tmp', httpProxy: 'http://egress-proxy:3128',
  noProxy: 'proptimiza-chatwoot-web-1,localhost,127.0.0.1', childTimeoutSeconds: 90,
  maximumOutputTokens: 500, maximumTotalTokens: 8192, maximumUsd: 0.05,
  killSwitchFile: '/run/controls/whatsapp-replies-enabled',
  automaticReplyPolicyFile: '/run/controls/whatsapp-automatic-reply-policy.json',
}

const event: ReplyEventRecord = {
  event_id: `cw1_${'1'.repeat(64)}`, semantic_sha256: 'a'.repeat(64), content_sha256: 'b'.repeat(64),
  account_id: '1', inbox_id: '1', conversation_id: '25', message_id: '41',
  trace_id: '11111111-1111-5111-8111-111111111111', occurred_at: '2026-10-04T12:00:00.000Z',
  accepted_at: '2026-10-04T12:00:01.000Z', updated_at: '2026-10-04T12:00:01.000Z',
  status: 'pending', attempts: 0, response_sha256: null, outbound_message_id: null,
  handoff_reason: null, stop_code: null,
}

const activePolicy = {
  runtime_contract: {
    maximum_automated_replies_per_conversation_per_24h: 3,
    maximum_diagnostic_questions_per_reply: 1,
    maximum_response_characters: 1200,
  },
} as unknown as AutomaticReplyPolicy

function harness(options: { policy: 'inactive' | 'active'; policySequence?: Array<'inactive' | 'active'>;
  sentCount?: number; infer?: () => Promise<{
  response: string; handoff_reason: string
}> }) {
  const service = new WhatsAppAutomationService(config)
  const transitions: Array<{ expected: ReplyEventStatus; next: ReplyEventStatus; patch: Record<string, unknown> }> = []
  let snapshots = 0
  let policyChecks = 0
  Reflect.set(service, 'replyGateAllows', async () => true)
  Reflect.set(service, 'automaticReplyPolicyDecision', async () => {
    const selected = options.policySequence?.[Math.min(policyChecks, options.policySequence.length - 1)] ?? options.policy
    policyChecks++
    return selected === 'active'
    ? { allowed: true, stop_code: 'AUTOMATIC_REPLY_POLICY_ACTIVE', policy: activePolicy }
    : { allowed: false, stop_code: 'AUTOMATIC_REPLY_POLICY_INACTIVE', policy: null }
  })
  Reflect.set(service, 'store', {
    conversationHoldReason: async () => null,
    automatedReplyCountSince: async () => options.sentCount ?? 0,
    transition: async (_eventId: string, expected: ReplyEventStatus, next: ReplyEventStatus,
      patch: Record<string, unknown> = {}) => {
      transitions.push({ expected, next, patch })
      return event
    },
  })
  Reflect.set(service, 'outbound', {
    snapshot: async () => {
      snapshots++
      return {
        current: true, human_replied: false,
        target: { content: 'Necesito ayuda con una integración.' }, transcript: [],
      }
    },
    send: async () => { throw new Error('SEND_MUST_NOT_RUN') },
  })
  if (options.infer) Reflect.set(service, 'infer', options.infer)
  const process = Reflect.get(service, 'process') as (record: Readonly<ReplyEventRecord>) => Promise<void>
  return { transitions, snapshots: () => snapshots, policyChecks: () => policyChecks,
    run: () => process.call(service, event) }
}

test('holds an event before Chatwoot reads or Hermes when the policy is inactive', async () => {
  const fixture = harness({ policy: 'inactive' })
  await fixture.run()
  assert.equal(fixture.snapshots(), 0)
  assert.deepEqual(fixture.transitions, [{
    expected: 'pending', next: 'held', patch: { stop_code: 'AUTOMATIC_REPLY_POLICY_INACTIVE' },
  }])
})

test('holds the fourth automated reply in a rolling day before Chatwoot or Hermes', async () => {
  const fixture = harness({ policy: 'active', sentCount: 3 })
  await fixture.run()
  assert.equal(fixture.snapshots(), 0)
  assert.deepEqual(fixture.transitions, [{
    expected: 'pending', next: 'held', patch: { stop_code: 'AUTOMATIC_REPLY_DAILY_LIMIT_REACHED' },
  }])
})

test('never sends a model reply that violates the active response policy', async () => {
  const fixture = harness({
    policy: 'active',
    infer: async () => ({ response: '¿Qué vendes? ¿Cuántas consultas recibes?', handoff_reason: 'specialist_required' }),
  })
  await fixture.run()
  assert.equal(fixture.snapshots(), 1)
  assert.equal(fixture.transitions[0]?.next, 'model_running')
  assert.equal(fixture.transitions[1]?.next, 'held')
  assert.equal(fixture.transitions[1]?.patch.stop_code, 'AUTOMATIC_REPLY_RESPONSE_POLICY_REJECTED')
})

test('rechecks the policy after the final Chatwoot snapshot and immediately before send', async () => {
  const fixture = harness({
    policy: 'active', policySequence: ['active', 'active', 'inactive'],
    infer: async () => ({ response: 'Entiendo. ¿Qué proceso deseas mejorar?', handoff_reason: 'none' }),
  })
  await fixture.run()
  assert.equal(fixture.snapshots(), 2)
  assert.equal(fixture.policyChecks(), 3)
  assert.equal(fixture.transitions.at(-1)?.next, 'held')
  assert.equal(fixture.transitions.at(-1)?.patch.stop_code, 'AUTOMATIC_REPLY_POLICY_INACTIVE')
})
