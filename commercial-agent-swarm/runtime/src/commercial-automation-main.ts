import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { BrokerHttpClient, PaperclipHttpClient } from './automation-http-clients.js'
import { CommercialAutomation, type AuthorizedAutomationStage } from './commercial-automation.js'
import { constantTimeSecretEqual } from './security.js'
import { readGroupSecretFile } from './secret-file.js'

const SERVICE_UID = 10013
const SERVICE_GID = 10013

export type CommercialAutomationConfig = ReturnType<typeof loadCommercialAutomationConfig>

export function loadCommercialAutomationConfig(environment: Record<string, string | undefined>) {
  if (environment.NODE_ENV !== 'production') throw new Error('AUTOMATION_NODE_ENV_INVALID')
  if (environment.COMMERCIAL_MODE !== 'simulation') throw new Error('AUTOMATION_COMMERCIAL_MODE_INVALID')
  const configuredMode = environment.AUTOMATION_MODE
  if (configuredMode !== 'observe' && configuredMode !== 'dispatch') throw new Error('AUTOMATION_MODE_INVALID')
  const mode: 'observe' | 'dispatch' = configuredMode
  const configuredHumanHold = environment.AUTOMATION_HUMAN_HOLD
  if (configuredHumanHold !== 'true' && configuredHumanHold !== 'false') throw new Error('AUTOMATION_HUMAN_HOLD_INVALID')
  const humanHold = configuredHumanHold === 'true'
  const host = environment.AUTOMATION_HOST
  const port = Number(environment.AUTOMATION_PORT)
  if (host !== '0.0.0.0' || !Number.isSafeInteger(port) || port !== 8090) throw new Error('AUTOMATION_LISTENER_INVALID')
  const required = [
    'AUTOMATION_TRIGGER_BEARER_FILE', 'PAPERCLIP_BOARD_API_KEY_FILE',
    'BROKER_CONTROL_PLANE_BEARER_FILE', 'BROKER_INTERNAL_BEARER_FILE',
    'WORK_ORDER_HMAC_SECRET_FILE',
  ] as const
  for (const key of required) {
    if (environment[key.replace(/_FILE$/, '')] !== undefined) throw new Error(`RAW_SECRET_FORBIDDEN:${key.replace(/_FILE$/, '')}`)
    if (!environment[key]?.startsWith('/run/secrets/')) throw new Error(`AUTOMATION_SECRET_FILE_REQUIRED:${key}`)
  }
  if (new Set(required.map((key) => environment[key])).size !== required.length) throw new Error('AUTOMATION_SECRET_PATH_REUSE')
  const companyId = requiredUuid(environment.PAPERCLIP_COMPANY_ID, 'PAPERCLIP_COMPANY_ID')
  const projectId = requiredUuid(environment.PAPERCLIP_PROJECT_ID, 'PAPERCLIP_PROJECT_ID')
  if (environment.PAPERCLIP_API_BASE !== 'http://paperclip:3100') throw new Error('PAPERCLIP_API_BASE_INVALID')
  if (environment.BROKER_API_BASE !== 'http://broker:8080') throw new Error('BROKER_API_BASE_INVALID')
  if (environment.WORK_ORDER_ISSUER !== 'proptimiza-commercial-broker') throw new Error('WORK_ORDER_ISSUER_INVALID')
  if (environment.WORK_ORDER_AUDIENCE !== 'proptimiza-hermes-executor') throw new Error('WORK_ORDER_AUDIENCE_INVALID')
  const keyId = environment.WORK_ORDER_KEY_ID
  if (!keyId || !/^[A-Za-z0-9._:-]{1,128}$/.test(keyId)) throw new Error('WORK_ORDER_KEY_ID_INVALID')
  return {
    mode, humanHold, host, port, companyId, projectId,
    paperclipBase: environment.PAPERCLIP_API_BASE,
    brokerBase: environment.BROKER_API_BASE,
    issuer: environment.WORK_ORDER_ISSUER,
    audience: environment.WORK_ORDER_AUDIENCE,
    keyId,
    triggerFile: environment.AUTOMATION_TRIGGER_BEARER_FILE!,
    paperclipFile: environment.PAPERCLIP_BOARD_API_KEY_FILE!,
    brokerControlFile: environment.BROKER_CONTROL_PLANE_BEARER_FILE!,
    brokerInternalFile: environment.BROKER_INTERNAL_BEARER_FILE!,
    workOrderHmacFile: environment.WORK_ORDER_HMAC_SECRET_FILE!,
  }
}

export async function startCommercialAutomation(environment: Record<string, string | undefined> = process.env) {
  assertServiceIdentity()
  const { config, trigger, automation } = await initializeCommercialAutomation(environment)
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    if (request.method === 'GET' && request.url === '/healthz') return json(response, 200, { status: 'ok' })
    if (request.method === 'GET' && request.url === '/readyz') return json(response, 200, {
      status: 'ready', mode: config.mode, human_hold: config.humanHold,
    })
    if (request.method !== 'POST' || request.url !== '/internal/v1/tick') return json(response, 404, { error: 'not_found' })
    if (!authorized(request.headers.authorization, trigger)) return json(response, 401, { error: 'unauthorized' })
    let size = 0
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk)
      if (size > 1_024) return json(response, 413, { error: 'payload_too_large' })
    }
    try {
      return json(response, 200, await automation.tick())
    } catch (error) {
      if (error instanceof Error && error.message === 'AUTOMATION_TICK_IN_PROGRESS') return json(response, 409, { error: 'tick_in_progress' })
      reportCommercialAutomationError(error)
      return json(response, 503, { error: 'automation_unavailable' })
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 5_000
  server.keepAliveTimeout = 2_000
  server.maxHeadersCount = 32
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve() })
  })
  return { close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

export async function runCommercialAutomationPreflight(environment: Record<string, string | undefined> = process.env) {
  assertServiceIdentity()
  const { automation } = await initializeCommercialAutomation(environment)
  return automation.preflightAla52()
}

export async function runCommercialAutomationAuthorizedOneShot(environment: Record<string, string | undefined> = process.env) {
  assertServiceIdentity()
  const stage = environment.AUTOMATION_AUTHORIZED_STAGE
  if (stage !== 'ALA-52' && stage !== 'ALA-53') throw new Error('AUTOMATION_AUTHORIZED_STAGE_INVALID')
  const { config, automation } = await initializeCommercialAutomation(environment)
  if (config.humanHold !== false) throw new Error('AUTOMATION_ONE_SHOT_HOLD_ACTIVE')
  return automation.runAuthorizedOneShot(stage as AuthorizedAutomationStage)
}

async function initializeCommercialAutomation(environment: Record<string, string | undefined>) {
  const config = loadCommercialAutomationConfig(environment)
  const read = async (path: string) => validateSecret(await readGroupSecretFile(path, SERVICE_GID))
  const [trigger, paperclipToken, brokerControl, brokerInternal, workOrderSecret] = await Promise.all([
    read(config.triggerFile), read(config.paperclipFile), read(config.brokerControlFile),
    read(config.brokerInternalFile), read(config.workOrderHmacFile),
  ])
  const values = [trigger, paperclipToken, brokerControl, brokerInternal, workOrderSecret]
  for (let left = 0; left < values.length; left++)
    for (let right = left + 1; right < values.length; right++)
      if (constantTimeSecretEqual(values[left], values[right])) throw new Error('AUTOMATION_SECRET_VALUE_REUSE')

  const paperclip = new PaperclipHttpClient(config.paperclipBase, config.companyId, () => read(config.paperclipFile))
  const broker = new BrokerHttpClient(config.brokerBase, () => read(config.brokerControlFile), () => read(config.brokerInternalFile))
  const automation = new CommercialAutomation({
    paperclip, broker, mode: config.mode, humanHold: config.humanHold,
    companyId: config.companyId, projectId: config.projectId,
    authority: { issuer: config.issuer, audience: config.audience, keyId: config.keyId, secret: workOrderSecret },
  })
  return { config, trigger, automation }
}

const SAFE_AUTOMATION_TICK_ERRORS = new Set([
  'PAPERCLIP_RESPONSE_INVALID',
  'PAPERCLIP_COMMENT_INVALID',
  'PAPERCLIP_UNAVAILABLE',
  'BROKER_RESPONSE_INVALID',
  'BROKER_UNAVAILABLE',
  'AUTOMATION_PREDECESSOR_EVIDENCE_REQUIRED',
  'AUTOMATION_PREDECESSOR_NOT_COMPLETED',
  'AUTOMATION_PREDECESSOR_QA_DENIED',
  'AUTOMATION_PREDECESSOR_DRAFT_URL_INVALID',
  'AUTOMATION_PREDECESSOR_DRAFT_INVALID',
  'AUTOMATION_PREDECESSOR_DRAFT_DUPLICATE',
  'AUTOMATION_PREDECESSOR_DRAFT_TEXT_INVALID',
  'AUTOMATION_PREDECESSOR_DRAFT_COUNT_INVALID',
  'AUTOMATION_PREDECESSOR_ASSIGNMENT_INVALID',
  'AUTOMATION_PREDECESSOR_RESULT_INVALID',
  'AUTOMATION_PREDECESSOR_QA_INCOMPLETE',
  'AUTOMATION_PREDECESSOR_ACCOUNT_URL_INVALID',
  'AUTOMATION_PREDECESSOR_ACCOUNT_INVALID',
  'AUTOMATION_PREDECESSOR_ACCOUNT_DUPLICATE',
  'AUTOMATION_PREDECESSOR_ACCOUNT_COUNT_INVALID',
])

export function normalizeCommercialAutomationError(error: unknown): string {
  if (!(error instanceof Error)) return 'AUTOMATION_UNEXPECTED_ERROR'
  if (SAFE_AUTOMATION_TICK_ERRORS.has(error.message)) return error.message
  if (/^(?:PAPERCLIP|BROKER)_HTTP_[45][0-9]{2}$/.test(error.message)) return error.message
  return 'AUTOMATION_UNEXPECTED_ERROR'
}

export function reportCommercialAutomationError(
  error: unknown,
  write: (line: string) => void = (line) => console.error(line),
): void {
  write(JSON.stringify({
    schema_version: '1.0',
    event: 'commercial_automation_tick_failed',
    component: 'commercial-automation',
    error_code: normalizeCommercialAutomationError(error),
    external_actions: 0,
  }))
}

function assertServiceIdentity(): void {
  if (process.platform === 'win32') return
  if (process.getuid?.() !== SERVICE_UID || process.getgid?.() !== SERVICE_GID) throw new Error('AUTOMATION_SERVICE_IDENTITY_INVALID')
}
function validateSecret(value: string): string {
  const secret = value.trim()
  if (secret.length < 32 || secret.length > 4_096 || /\s/.test(secret)) throw new Error('AUTOMATION_SECRET_INVALID')
  return secret
}
function authorized(value: string | undefined, expected: string): boolean {
  const token = value?.match(/^Bearer ([^\s]+)$/)?.[1]
  return token !== undefined && constantTimeSecretEqual(token, expected)
}
function requiredUuid(value: string | undefined, name: string): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name}_INVALID`)
  return value
}
function json(response: import('node:http').ServerResponse, status: number, body: unknown) {
  const encoded = Buffer.from(JSON.stringify(body))
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': encoded.length })
  response.end(encoded)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await startCommercialAutomation()
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void service.close().finally(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
