import { pathToFileURL } from 'node:url'
import { assertPrimaryServiceGid } from './secret-file.js'
import { WhatsAppAutomationService, type WhatsAppAutomationConfig } from './whatsapp-automation-service.js'

const SERVICE_UID = 10000
const SERVICE_GID = 10000

export function loadWhatsAppAutomationConfig(
  environment: Record<string, string | undefined>,
): WhatsAppAutomationConfig {
  if (environment.NODE_ENV !== 'production') throw new Error('WHATSAPP_AUTOMATION_NODE_ENV_INVALID')
  forbidRawSecrets(environment)
  const config: WhatsAppAutomationConfig = {
    bindHost: exact(environment.WHATSAPP_AUTOMATION_HOST, '0.0.0.0', 'WHATSAPP_AUTOMATION_HOST_INVALID'),
    port: integer(environment.WHATSAPP_AUTOMATION_PORT, 8787, 8787, 'WHATSAPP_AUTOMATION_PORT_INVALID'),
    accountId: decimal(environment.CHATWOOT_ACCOUNT_ID, 'CHATWOOT_ACCOUNT_ID_INVALID'),
    inboxId: decimal(environment.CHATWOOT_INBOX_ID, 'CHATWOOT_INBOX_ID_INVALID'),
    handoffTeamId: exact(environment.CHATWOOT_HANDOFF_TEAM_ID, '1', 'CHATWOOT_HANDOFF_TEAM_ID_INVALID'),
    stateFile: exact(environment.WHATSAPP_AUTOMATION_STATE_FILE,
      '/var/lib/proptimiza/whatsapp-automation/state.json', 'WHATSAPP_AUTOMATION_STATE_FILE_INVALID'),
    webhookSecretFile: secretPath(environment.CHATWOOT_AGENT_BOT_SECRET_FILE,
      '/run/secrets/chatwoot_agent_bot_secret', 'CHATWOOT_AGENT_BOT_SECRET_FILE_INVALID'),
    agentBotTokenFile: secretPath(environment.CHATWOOT_AGENT_BOT_TOKEN_FILE,
      '/run/secrets/chatwoot_agent_bot_token', 'CHATWOOT_AGENT_BOT_TOKEN_FILE_INVALID'),
    readerTokenFile: secretPath(environment.CHATWOOT_READER_TOKEN_FILE,
      '/run/secrets/chatwoot_reader_token', 'CHATWOOT_READER_TOKEN_FILE_INVALID'),
    openCodeKeyFile: secretPath(environment.OPENCODE_GO_API_KEY_FILE,
      '/run/secrets/opencode_go_api_key', 'OPENCODE_GO_API_KEY_FILE_INVALID'),
    expectedSecretGid: SERVICE_GID,
    chatwootBaseUrl: exact(environment.CHATWOOT_API_BASE,
      'http://proptimiza-chatwoot-web-1:3000', 'CHATWOOT_API_BASE_INVALID'),
    hermesPython: exact(environment.HERMES_CONVERSATION_PYTHON,
      '/opt/hermes/.venv/bin/python', 'HERMES_CONVERSATION_PYTHON_INVALID'),
    hermesChildScript: exact(environment.HERMES_CONVERSATION_SCRIPT,
      '/app/scripts/hermes_conversation_child.py', 'HERMES_CONVERSATION_SCRIPT_INVALID'),
    hermesCwd: exact(environment.HERMES_CONVERSATION_CWD, '/tmp', 'HERMES_CONVERSATION_CWD_INVALID'),
    httpProxy: exact(environment.HTTP_PROXY, 'http://egress-proxy:3128', 'WHATSAPP_AUTOMATION_PROXY_INVALID'),
    noProxy: exact(environment.NO_PROXY,
      'proptimiza-chatwoot-web-1,localhost,127.0.0.1', 'WHATSAPP_AUTOMATION_NO_PROXY_INVALID'),
    childTimeoutSeconds: integer(environment.WHATSAPP_AUTOMATION_TIMEOUT_SECONDS, 10, 300,
      'WHATSAPP_AUTOMATION_TIMEOUT_INVALID'),
    maximumOutputTokens: integer(environment.WHATSAPP_AUTOMATION_MAXIMUM_OUTPUT_TOKENS, 64, 2000,
      'WHATSAPP_AUTOMATION_TOKENS_INVALID'),
    maximumTotalTokens: integer(environment.WHATSAPP_AUTOMATION_MAXIMUM_TOTAL_TOKENS, 8192, 8192,
      'WHATSAPP_AUTOMATION_TOTAL_TOKENS_INVALID'),
    maximumUsd: decimalNumber(environment.WHATSAPP_AUTOMATION_MAXIMUM_USD, 0.01, 0.1,
      'WHATSAPP_AUTOMATION_BUDGET_INVALID'),
    killSwitchFile: secretPath(environment.WHATSAPP_AUTOMATION_REPLY_GATE_FILE,
      '/run/controls/whatsapp-replies-enabled', 'WHATSAPP_AUTOMATION_REPLY_GATE_FILE_INVALID'),
    automaticReplyPolicyFile: secretPath(environment.WHATSAPP_AUTOMATION_POLICY_FILE,
      '/run/controls/whatsapp-automatic-reply-policy.json', 'WHATSAPP_AUTOMATION_POLICY_FILE_INVALID'),
  }
  return Object.freeze(config)
}
export async function startWhatsAppAutomation(
  environment: Record<string, string | undefined> = process.env,
): Promise<WhatsAppAutomationService> {
  assertIdentity()
  const service = new WhatsAppAutomationService(loadWhatsAppAutomationConfig(environment))
  await service.start()
  return service
}

function assertIdentity(): void {
  if (process.platform === 'win32') return
  assertPrimaryServiceGid(SERVICE_GID)
  if (process.getuid?.() !== SERVICE_UID) throw new Error('WHATSAPP_AUTOMATION_SERVICE_IDENTITY_INVALID')
}

function forbidRawSecrets(environment: Record<string, string | undefined>): void {
  for (const key of ['CHATWOOT_AGENT_BOT_SECRET', 'CHATWOOT_AGENT_BOT_TOKEN', 'CHATWOOT_READER_TOKEN',
    'OPENCODE_GO_API_KEY', 'WHATSAPP_AUTOMATION_POLICY'])
    if (environment[key] !== undefined) throw new Error(`WHATSAPP_AUTOMATION_RAW_SECRET_FORBIDDEN:${key}`)
}
function exact(value: string | undefined, expected: string, code: string): string {
  if (value !== expected) throw new Error(code)
  return value
}
function secretPath(value: string | undefined, expected: string, code: string): string {
  return exact(value, expected, code)
}
function decimal(value: string | undefined, code: string): string {
  if (!value || !/^[1-9][0-9]{0,18}$/.test(value)) throw new Error(code)
  return value
}
function integer(value: string | undefined, minimum: number, maximum: number, code: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code)
  return parsed
}
function decimalNumber(value: string | undefined, minimum: number, maximum: number, code: string): number {
  if (!value || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error(code)
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(code)
  return parsed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const service = await startWhatsAppAutomation()
    process.stdout.write(`${JSON.stringify({ event: 'whatsapp_automation_started', status: 'ready' })}\n`)
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void service.stop().then(() => process.exit(0), () => process.exit(1))
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_:-]{2,160}$/.test(error.message)
      ? error.message : 'WHATSAPP_AUTOMATION_START_FAILED'
    process.stderr.write(`${JSON.stringify({ event: 'whatsapp_automation_start_failed', error_code: code })}\n`)
    process.exit(1)
  }
}
