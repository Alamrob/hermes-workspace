import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { hashAction } from './canonical.js'
import {
  InternalMailOneShot,
  InternalMailOneShotError,
  type HumanInternalMailAuthorization,
  type InternalMailOneShotPorts,
  type InternalMailReadiness,
} from './internal-mail-one-shot.js'
import { readGroupSecretFile } from './secret-file.js'
import { signWorkOrder } from './security.js'
import {
  BROKER_SERVICE_GID,
  expandDatabaseSecretFiles,
  loadInternalMailBrokerConfig,
  readApplicationSecrets,
} from './simulation-entrypoint.js'
import type { ApprovalAction } from './approvals.js'
import type { WorkOrder } from './work-orders.js'

const RESPONSE_LIMIT = 64 * 1024
const BROKER_ORIGIN = 'http://127.0.0.1:8080'

class InternalMailHttpPorts implements InternalMailOneShotPorts {
  private readonly runtimePool: Pick<Pool, 'query' | 'end'>
  private readonly safetyPool: Pick<Pool, 'query' | 'end'>

  constructor(private readonly options: {
    workOrderSecret: string
    workOrderKeyId: string
    controlBearer: string
    salesApprovalBearer: string
    connectorBearer: string
    internalBearer: string
    runtimeDatabaseUrl: string
    safetyDatabaseUrl: string
    fetchImpl?: typeof fetch
    runtimePool?: Pick<Pool, 'query' | 'end'>
    safetyPool?: Pick<Pool, 'query' | 'end'>
  }) {
    this.runtimePool = options.runtimePool ?? new Pool({ connectionString: options.runtimeDatabaseUrl, max: 1 })
    this.safetyPool = options.safetyPool ?? new Pool({ connectionString: options.safetyDatabaseUrl, max: 1 })
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.runtimePool.end(), this.safetyPool.end()])
  }

  async createWorkOrder(order: WorkOrder): Promise<void> {
    const authority = order.authority as Record<string, unknown>
    authority.key_id = this.options.workOrderKeyId
    authority.signature = signWorkOrder(order, this.options.workOrderSecret)
    await this.request('/v1/work-orders', this.options.controlBearer, order, 201)
  }

  async requestApproval(action: ApprovalAction): Promise<{ approval_id: string; action_hash: string }> {
    const value = await this.request('/v1/approvals/requests', this.options.controlBearer, action, 201)
    if (!isRecord(value) || typeof value.approval_id !== 'string' || value.action_hash !== hashAction(action))
      throw new Error('APPROVAL_REQUEST_RESPONSE_INVALID')
    return { approval_id: value.approval_id, action_hash: value.action_hash }
  }

  async approve(input: {
    approval_id: string
    action_hash: string
    actor_id: 'proptimizaspa@gmail.com'
    decided_at: string
    expires_at: string
  }): Promise<{ token: string }> {
    const value = await this.request(
      `/v1/approvals/${encodeURIComponent(input.approval_id)}/decision`,
      this.options.salesApprovalBearer,
      {
        decision: 'approved',
        actor_id: input.actor_id,
        decided_at: input.decided_at,
        expires_at: input.expires_at,
      },
      200,
    )
    if (!isRecord(value) || value.status !== 'approved' || typeof value.token !== 'string')
      throw new Error('APPROVAL_DECISION_RESPONSE_INVALID')
    return { token: value.token }
  }

  async isKillSwitchActive(input: { missionId: string; channel: '*' | 'email' }): Promise<boolean> {
    const value = await this.request(
      '/internal/v1/safety/kill-switch',
      this.options.internalBearer,
      { mission_id: input.missionId, channel: input.channel },
      200,
    )
    if (!isRecord(value) || typeof value.active !== 'boolean')
      throw new Error('KILL_SWITCH_RESPONSE_INVALID')
    return value.active
  }

  async setGlobalKillSwitch(active: boolean): Promise<void> {
    const result = await this.safetyPool.query<{ changed: boolean }>(
      "SELECT control.set_kill_switch('global','*',$1) AS changed",
      [active],
    )
    if (result.rows[0]?.changed !== true) throw new Error('KILL_SWITCH_CHANGE_FAILED')
  }

  async setEmailKillSwitch(active: boolean): Promise<void> {
    const result = await this.safetyPool.query<{ changed: boolean }>(
      "SELECT control.set_kill_switch('channel','email',$1) AS changed",
      [active],
    )
    if (result.rows[0]?.changed !== true) throw new Error('KILL_SWITCH_CHANGE_FAILED')
  }

  async send(input: {
    action: ApprovalAction
    approval_token: string
  }): Promise<{ receipt_id: string; approval_reference: string }> {
    const value = await this.request('/v1/mail/send', this.options.connectorBearer, input, 200)
    if (!isRecord(value) || typeof value.receipt_id !== 'string' || typeof value.approval_reference !== 'string')
      throw new Error('SEND_RESPONSE_INVALID')
    return { receipt_id: value.receipt_id, approval_reference: value.approval_reference }
  }

  async record(event: {
    type: string
    at: string
    mission_id: string
    details: Record<string, string | boolean>
  }): Promise<void> {
    await this.runtimePool.query('SELECT control.record_audit_event($1::jsonb)', [JSON.stringify({
      schema_version: '1.0',
      mission_id: event.mission_id,
      agent_id: 'internal-mail-one-shot',
      tool_action: event.type,
      started_at: event.at,
      completed_at: event.at,
      duration_ms: 0,
      token_cost: { input_tokens: 0, output_tokens: 0, currency: 'USD', amount: 0 },
      redacted_input: `sha256:${hashAction(event.details)}`,
      result: 'recorded',
      error: null,
      retries: 0,
      external_action: event.type === 'mail.sent_once',
      approval_reference: null,
      receipt_reference: null,
      evidence: [],
      state_changes: [event.type],
      deployed_version: 'internal-mail-test-v1',
    })])
  }

  private async request(path: string, bearer: string, body: unknown, expectedStatus: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${BROKER_ORIGIN}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'x-agent-id': 'internal-mail-one-shot',
        },
        body: JSON.stringify(body),
      })
      if (response.status !== expectedStatus) throw new Error(`BROKER_HTTP_${response.status}`)
      return await boundedJson(response)
    } finally {
      clearTimeout(timer)
    }
  }
}

async function main(environment: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadInternalMailBrokerConfig(environment)
  const readinessPath = requiredSecretPath(environment, 'INTERNAL_MAIL_READINESS_FILE')
  const authorizationPath = requiredSecretPath(environment, 'INTERNAL_MAIL_AUTHORIZATION_FILE')
  const [secrets, expanded, readinessText, authorizationText] = await Promise.all([
    readApplicationSecrets(config),
    expandDatabaseSecretFiles(config, environment),
    readGroupSecretFile(readinessPath, BROKER_SERVICE_GID),
    readGroupSecretFile(authorizationPath, BROKER_SERVICE_GID),
  ])
  const readiness = parseJson<InternalMailReadiness>(readinessText, 'READINESS_JSON_INVALID')
  const authorization = parseJson<HumanInternalMailAuthorization>(authorizationText, 'AUTHORIZATION_JSON_INVALID')
  const ports = new InternalMailHttpPorts({
    workOrderSecret: secrets.workOrderHmac,
    workOrderKeyId: config.workOrderAuthority.keyId,
    controlBearer: secrets.controlPlane,
    salesApprovalBearer: secrets.approvalSalesGateway,
    connectorBearer: secrets.connector,
    internalBearer: secrets.internal,
    runtimeDatabaseUrl: required(expanded, 'DATABASE_URL'),
    safetyDatabaseUrl: required(expanded, 'SAFETY_DATABASE_URL'),
  })
  try {
    const outcome = await new InternalMailOneShot({ ports }).run({ readiness, authorization })
    process.stdout.write(`${JSON.stringify({
      schema_version: '1.0',
      status: 'sent_once',
      mission_id: outcome.mission_id,
      receipt_recorded: Boolean(outcome.receipt_id),
      approval_recorded: Boolean(outcome.approval_reference),
      secret_disclosed: false,
    })}\n`)
  } finally {
    try { await ports.setEmailKillSwitch(true) } catch { /* terminal state is reported by the caller/watchdog */ }
    try { await ports.setGlobalKillSwitch(true) } catch { /* terminal state is reported by the caller/watchdog */ }
    await ports.close()
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('RESPONSE_BODY_REQUIRED')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > RESPONSE_LIMIT) {
      await reader.cancel()
      throw new Error('RESPONSE_TOO_LARGE')
    }
    chunks.push(part.value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('RESPONSE_JSON_INVALID') }
}

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}

function requiredSecretPath(environment: Record<string, string | undefined>, name: string): string {
  const value = required(environment, name)
  if (!value.startsWith('/run/secrets/')) throw new Error(`${name}_INVALID`)
  return value
}

function parseJson<T>(text: string, code: string): T {
  try {
    const value = JSON.parse(text)
    if (!isRecord(value)) throw new Error(code)
    return value as T
  } catch { throw new Error(code) }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main() }
  catch (error) {
    const code = error instanceof InternalMailOneShotError ? error.code :
      error instanceof Error && /^[A-Z][A-Z0-9_:-]{2,128}$/.test(error.message) ? error.message : 'INTERNAL_MAIL_ONE_SHOT_FAILED'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  }
}

export { InternalMailHttpPorts, main as runInternalMailOneShotMain }
