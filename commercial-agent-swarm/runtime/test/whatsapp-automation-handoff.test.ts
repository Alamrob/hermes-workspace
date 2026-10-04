import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatwootHttpError } from '../src/comms/chatwoot-outbound.js'
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
  trace_id: '11111111-1111-5111-8111-111111111111', occurred_at: '2026-10-01T12:00:00.000Z',
  accepted_at: '2026-10-01T12:00:01.000Z', updated_at: '2026-10-01T12:00:01.000Z',
  status: 'sending', attempts: 2, response_sha256: 'c'.repeat(64), outbound_message_id: null,
  handoff_reason: 'specialist_required', stop_code: 'MODEL_COMPLETED',
}

function harness(assignmentFailure?: Error) {
  const transitions: Array<{ expected: ReplyEventStatus; next: ReplyEventStatus; patch: Record<string, unknown> }> = []
  const assignments: Array<{ conversationId: string; teamId: string }> = []
  const service = new WhatsAppAutomationService(config)
  Reflect.set(service, 'store', {
    transition: async (_eventId: string, expected: ReplyEventStatus, next: ReplyEventStatus,
      patch: Record<string, unknown>) => {
      transitions.push({ expected, next, patch })
      return event
    },
  })
  Reflect.set(service, 'outbound', {
    send: async () => ({ message_id: '91' }),
    assignTeam: async (conversationId: string, teamId: string) => {
      assignments.push({ conversationId, teamId })
      if (assignmentFailure) throw assignmentFailure
      return { team_id: teamId }
    },
  })
  const deliver = Reflect.get(service, 'deliver') as (
    inputEvent: Readonly<ReplyEventRecord>, reply: { response: string; handoff_reason: string }
  ) => Promise<void>
  return { assignments, transitions, run: () => deliver.call(service, event, { response: 'Te derivaré.', handoff_reason: 'specialist_required' }) }
}

test('assigns a recommended handoff before recording a terminal sent state', async () => {
  const fixture = harness()
  await fixture.run()
  assert.deepEqual(fixture.assignments, [{ conversationId: '25', teamId: '1' }])
  assert.deepEqual(fixture.transitions, [{
    expected: 'sending', next: 'sent',
    patch: { outbound_message_id: '91', stop_code: 'REPLY_SENT_HANDOFF_ASSIGNED' },
  }])
})
test('holds the conversation without resending when team assignment is rejected', async () => {
  const fixture = harness(new ChatwootHttpError(403))
  await fixture.run()
  assert.deepEqual(fixture.transitions, [{
    expected: 'sending', next: 'held',
    patch: { outbound_message_id: '91', stop_code: 'REPLY_SENT_HANDOFF_ASSIGNMENT_REJECTED_403' },
  }])
})
