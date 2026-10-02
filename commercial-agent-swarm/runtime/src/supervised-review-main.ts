import { pathToFileURL } from 'node:url'
import { assertPrimaryServiceGid } from './secret-file.js'
import { SupervisedReviewService, type SupervisedReviewConfig } from './supervised-review-service.js'

const SERVICE_UID = 10000
const SERVICE_GID = 10000

export function loadSupervisedReviewConfig(
  environment: Record<string, string | undefined>,
): SupervisedReviewConfig {
  if (environment.NODE_ENV !== 'production') throw new Error('SUPERVISED_REVIEW_NODE_ENV_INVALID')
  forbidUnsafeCapabilities(environment)
  return Object.freeze({
    bindHost: exact(environment.SUPERVISED_REVIEW_HOST, '0.0.0.0', 'SUPERVISED_REVIEW_HOST_INVALID'),
    port: integer(environment.SUPERVISED_REVIEW_PORT, 8788, 'SUPERVISED_REVIEW_PORT_INVALID'),
    accountId: decimal(environment.CHATWOOT_ACCOUNT_ID, 'CHATWOOT_ACCOUNT_ID_INVALID'),
    inboxId: decimal(environment.CHATWOOT_INBOX_ID, 'CHATWOOT_INBOX_ID_INVALID'),
    handoffTeamId: exact(environment.CHATWOOT_HANDOFF_TEAM_ID, '1', 'CHATWOOT_HANDOFF_TEAM_ID_INVALID'),
    stateFile: exact(environment.SUPERVISED_REVIEW_STATE_FILE,
      '/var/lib/proptimiza/supervised-review/state.json', 'SUPERVISED_REVIEW_STATE_FILE_INVALID'),
    webhookSecretFile: exact(environment.CHATWOOT_SUPERVISED_WEBHOOK_SECRET_FILE,
      '/run/secrets/chatwoot_supervised_webhook_secret', 'CHATWOOT_SUPERVISED_WEBHOOK_SECRET_FILE_INVALID'),
    reviewerTokenFile: exact(environment.CHATWOOT_REVIEWER_TOKEN_FILE,
      '/run/secrets/chatwoot_reviewer_token', 'CHATWOOT_REVIEWER_TOKEN_FILE_INVALID'),
    reviewerMachineSecretFile: exact(environment.CHATWOOT_REVIEWER_MACHINE_SECRET_FILE,
      '/run/secrets/proptimiza_chatwoot_review_ingress_secret', 'CHATWOOT_REVIEWER_MACHINE_SECRET_FILE_INVALID'),
    pilotGateFile: exact(environment.SUPERVISED_REVIEW_GATE_FILE,
      '/run/controls/supervised-review-enabled', 'SUPERVISED_REVIEW_GATE_FILE_INVALID'),
    pilotScopeFile: exact(environment.SUPERVISED_REVIEW_SCOPE_FILE,
      '/run/controls/supervised-review-scope.json', 'SUPERVISED_REVIEW_SCOPE_FILE_INVALID'),
    expectedSecretGid: SERVICE_GID,
    chatwootBaseUrl: exact(environment.CHATWOOT_API_BASE,
      'http://proptimiza-chatwoot-web-1:3000', 'CHATWOOT_API_BASE_INVALID'),
  })
}

export async function startSupervisedReview(
  environment: Record<string, string | undefined> = process.env,
): Promise<SupervisedReviewService> {
  assertIdentity()
  const service = new SupervisedReviewService(loadSupervisedReviewConfig(environment))
  await service.start()
  return service
}

function assertIdentity(): void {
  if (process.platform === 'win32') return
  assertPrimaryServiceGid(SERVICE_GID)
  if (process.getuid?.() !== SERVICE_UID) throw new Error('SUPERVISED_REVIEW_SERVICE_IDENTITY_INVALID')
}

function forbidUnsafeCapabilities(environment: Record<string, string | undefined>): void {
  const forbidden = [
    'CHATWOOT_SUPERVISED_WEBHOOK_SECRET', 'CHATWOOT_REVIEWER_TOKEN', 'CHATWOOT_REVIEWER_MACHINE_SECRET',
    'CHATWOOT_AGENT_BOT_TOKEN', 'CHATWOOT_AGENT_BOT_TOKEN_FILE', 'OPENCODE_GO_API_KEY',
    'OPENCODE_GO_API_KEY_FILE', 'HERMES_CONVERSATION_PYTHON', 'HERMES_CONVERSATION_SCRIPT',
    'SSH_AUTH_SOCK', 'CRM_API_TOKEN', 'HOSTINGER_MAIL_PASSWORD', 'APPROVAL_GATEWAY_SECRET',
  ]
  for (const key of forbidden) if (environment[key] !== undefined)
    throw new Error(`SUPERVISED_REVIEW_CAPABILITY_FORBIDDEN:${key}`)
}

function exact(value: string | undefined, expected: string, code: string): string {
  if (value !== expected) throw new Error(code)
  return value
}

function decimal(value: string | undefined, code: string): string {
  if (!value || !/^[1-9][0-9]{0,18}$/.test(value)) throw new Error(code)
  return value
}

function integer(value: string | undefined, expected: number, code: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed !== expected) throw new Error(code)
  return parsed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const service = await startSupervisedReview()
    process.stdout.write(`${JSON.stringify({ event: 'supervised_review_started', status: 'ready' })}\n`)
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
      ? error.message : 'SUPERVISED_REVIEW_START_FAILED'
    process.stderr.write(`${JSON.stringify({ event: 'supervised_review_start_failed', error_code: code })}\n`)
    process.exit(1)
  }
}
