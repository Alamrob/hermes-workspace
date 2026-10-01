import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWhatsAppAutomationConfig } from '../src/whatsapp-automation-main.js'
import { isValidReplyGateValue, replyGateAllowsReplies } from '../src/whatsapp-automation-service.js'

function environment(): Record<string, string> {
  return {
    NODE_ENV: 'production', WHATSAPP_AUTOMATION_HOST: '0.0.0.0', WHATSAPP_AUTOMATION_PORT: '8787',
    CHATWOOT_ACCOUNT_ID: '1', CHATWOOT_INBOX_ID: '1', CHATWOOT_HANDOFF_TEAM_ID: '1',
    WHATSAPP_AUTOMATION_STATE_FILE: '/var/lib/proptimiza/whatsapp-automation/state.json',
    CHATWOOT_AGENT_BOT_SECRET_FILE: '/run/secrets/chatwoot_agent_bot_secret',
    CHATWOOT_AGENT_BOT_TOKEN_FILE: '/run/secrets/chatwoot_agent_bot_token',
    CHATWOOT_READER_TOKEN_FILE: '/run/secrets/chatwoot_reader_token',
    OPENCODE_GO_API_KEY_FILE: '/run/secrets/opencode_go_api_key',
    CHATWOOT_API_BASE: 'http://proptimiza-chatwoot-web-1:3000',
    HERMES_CONVERSATION_PYTHON: '/opt/hermes/.venv/bin/python',
    HERMES_CONVERSATION_SCRIPT: '/app/scripts/hermes_conversation_child.py', HERMES_CONVERSATION_CWD: '/tmp',
    HTTP_PROXY: 'http://egress-proxy:3128', NO_PROXY: 'proptimiza-chatwoot-web-1,localhost,127.0.0.1',
    WHATSAPP_AUTOMATION_TIMEOUT_SECONDS: '90', WHATSAPP_AUTOMATION_MAXIMUM_OUTPUT_TOKENS: '500',
    WHATSAPP_AUTOMATION_MAXIMUM_TOTAL_TOKENS: '8192',
    WHATSAPP_AUTOMATION_MAXIMUM_USD: '0.05',
    WHATSAPP_AUTOMATION_REPLY_GATE_FILE: '/run/controls/whatsapp-replies-enabled',
  }
}

test('loads only the pinned production topology and file-backed credentials', () => {
  const config = loadWhatsAppAutomationConfig(environment())
  assert.equal(config.port, 8787)
  assert.equal(config.maximumTotalTokens, 8192)
  assert.equal(config.maximumUsd, 0.05)
  assert.equal(Object.isFrozen(config), true)
})
test('rejects raw credentials and topology drift', () => {
  for (const patch of [
    { CHATWOOT_AGENT_BOT_TOKEN: 'not-allowed' }, { CHATWOOT_READER_TOKEN: 'not-allowed' },
    { CHATWOOT_API_BASE: 'https://chat.alam.cl' },
    { HTTP_PROXY: 'http://other:3128' }, { WHATSAPP_AUTOMATION_REPLY_GATE_FILE: '/tmp/enabled' },
    { WHATSAPP_AUTOMATION_MAXIMUM_TOTAL_TOKENS: '8193' },
    { WHATSAPP_AUTOMATION_MAXIMUM_USD: '0.11' },
    { CHATWOOT_HANDOFF_TEAM_ID: '2' },
  ]) assert.throws(() => loadWhatsAppAutomationConfig({ ...environment(), ...patch }))
})

test('accepts a closed reply gate at startup without allowing any reply', () => {
  assert.equal(isValidReplyGateValue('enabled'), true)
  assert.equal(isValidReplyGateValue('disabled'), true)
  assert.equal(isValidReplyGateValue(''), false)
  assert.equal(isValidReplyGateValue('true'), false)
  assert.equal(isValidReplyGateValue('enabled\n'), false)
  assert.equal(replyGateAllowsReplies('enabled'), true)
  assert.equal(replyGateAllowsReplies('disabled'), false)
  assert.equal(replyGateAllowsReplies('true'), false)
})
