import { pathToFileURL } from 'node:url'
import { BrokerHttpClient } from './automation-http-clients.js'
import { readGroupSecretFile } from './secret-file.js'
import { UsageSmoke } from './usage-smoke.js'

const SERVICE_UID = 10013
const SERVICE_GID = 10013

export function loadUsageSmokeConfig(environment: Record<string, string | undefined>) {
  if (environment.NODE_ENV !== 'production' || environment.COMMERCIAL_MODE !== 'simulation')
    throw new Error('USAGE_SMOKE_ENVIRONMENT_INVALID')
  if (environment.BROKER_API_BASE !== 'http://broker:8080') throw new Error('BROKER_API_BASE_INVALID')
  if (environment.WORK_ORDER_ISSUER !== 'proptimiza-commercial-broker') throw new Error('WORK_ORDER_ISSUER_INVALID')
  if (environment.WORK_ORDER_AUDIENCE !== 'proptimiza-hermes-executor') throw new Error('WORK_ORDER_AUDIENCE_INVALID')
  const keyId = environment.WORK_ORDER_KEY_ID
  if (!keyId || !/^[A-Za-z0-9._:-]{1,128}$/.test(keyId)) throw new Error('WORK_ORDER_KEY_ID_INVALID')
  const runId = environment.USAGE_SMOKE_RUN_ID
  if (!runId || !UUID.test(runId)) throw new Error('USAGE_SMOKE_RUN_ID_INVALID')
  const required = [
    'BROKER_CONTROL_PLANE_BEARER_FILE',
    'BROKER_INTERNAL_BEARER_FILE',
    'WORK_ORDER_HMAC_SECRET_FILE',
  ] as const
  for (const name of required) {
    if (environment[name.replace(/_FILE$/, '')] !== undefined) throw new Error(`RAW_SECRET_FORBIDDEN:${name.replace(/_FILE$/, '')}`)
    if (!environment[name]?.startsWith('/run/secrets/')) throw new Error(`USAGE_SMOKE_SECRET_FILE_REQUIRED:${name}`)
  }
  if (new Set(required.map((name) => environment[name])).size !== required.length)
    throw new Error('USAGE_SMOKE_SECRET_PATH_REUSE')
  return {
    runId,
    brokerBase: environment.BROKER_API_BASE,
    issuer: environment.WORK_ORDER_ISSUER,
    audience: environment.WORK_ORDER_AUDIENCE,
    keyId,
    brokerControlFile: environment.BROKER_CONTROL_PLANE_BEARER_FILE!,
    brokerInternalFile: environment.BROKER_INTERNAL_BEARER_FILE!,
    workOrderHmacFile: environment.WORK_ORDER_HMAC_SECRET_FILE!,
  }
}

export async function runUsageSmoke(environment: Record<string, string | undefined> = process.env) {
  assertServiceIdentity()
  const config = loadUsageSmokeConfig(environment)
  const read = async (path: string) => validateSecret(await readGroupSecretFile(path, SERVICE_GID))
  const [control, internal, hmac] = await Promise.all([
    read(config.brokerControlFile),
    read(config.brokerInternalFile),
    read(config.workOrderHmacFile),
  ])
  const broker = new BrokerHttpClient(config.brokerBase, async () => control, async () => internal)
  return await new UsageSmoke({
    broker,
    runId: config.runId,
    authority: { issuer: config.issuer, audience: config.audience, keyId: config.keyId, secret: hmac },
  }).run()
}

function assertServiceIdentity(): void {
  if (process.platform === 'win32') return
  if (process.getuid?.() !== SERVICE_UID || process.getgid?.() !== SERVICE_GID)
    throw new Error('USAGE_SMOKE_SERVICE_IDENTITY_INVALID')
}

function validateSecret(value: string): string {
  const secret = value.trim()
  if (secret.length < 32 || secret.length > 4_096 || /\s/.test(secret))
    throw new Error('USAGE_SMOKE_SECRET_INVALID')
  return secret
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runUsageSmoke()
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

