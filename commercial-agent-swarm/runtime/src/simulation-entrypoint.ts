import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parseApprovalMode, type ApprovalMode } from './approval-mode.js'
import { assertPrimaryServiceGid, readGroupSecretFile } from './secret-file.js'

type Environment = Record<string, string | undefined>
export const BROKER_SERVICE_GID = 10001

const DATABASE_FILES = [
  'DATABASE_URL_FILE',
  'WORK_ORDER_DATABASE_URL_FILE',
  'APPROVER_DATABASE_URL_FILE',
  'SAFETY_DATABASE_URL_FILE',
  'APPROVAL_EVIDENCE_DATABASE_URL_FILE',
] as const
const APPLICATION_FILES = [
  'WORK_ORDER_HMAC_SECRET_FILE',
  'CONTROL_PLANE_BEARER_FILE',
  'APPROVAL_SALES_GATEWAY_BEARER_FILE',
  'APPROVAL_TELEGRAM_GATEWAY_BEARER_FILE',
  'CONNECTOR_BEARER_FILE',
  'INTERNAL_BEARER_FILE',
  'APPROVAL_HMAC_SECRET_FILE',
] as const
const RAW_SECRETS = [
  'DATABASE_URL',
  'WORK_ORDER_DATABASE_URL',
  'APPROVER_DATABASE_URL',
  'SAFETY_DATABASE_URL',
  'WORK_ORDER_HMAC_SECRET',
  'CONTROL_PLANE_BEARER',
  'APPROVAL_GATEWAY_BEARER',
  'APPROVAL_SALES_GATEWAY_BEARER',
  'APPROVAL_TELEGRAM_GATEWAY_BEARER',
  'CONNECTOR_BEARER',
  'INTERNAL_BEARER',
  'APPROVAL_HMAC_SECRET',
  'CUSTOM_API_KEY',
  'MAIL_TOKEN',
  'TELEGRAM_TOKEN',
] as const

export interface SimulationBrokerConfig {
  mode: 'simulation'
  host: '0.0.0.0' | '127.0.0.1'
  port: number
  deployedVersion: string
  databaseSecretFiles: Array<{ name: string; path: string }>
  applicationSecretFiles: Record<(typeof APPLICATION_FILES)[number], string>
  workOrderAuthority: { issuer: string; audience: string; keyId: string }
  approvalMode: ApprovalMode
  approvalActors: { sales: string[]; telegram: string[] }
  secretGid: typeof BROKER_SERVICE_GID
  a3AdmissionEnabled: false
}

export interface ApplicationSecrets {
  workOrderHmac: string
  controlPlane: string
  approvalSalesGateway: string
  approvalTelegramGateway: string
  connector: string
  internal: string
  approvalHmac: string
}

export function loadSimulationBrokerConfig(
  environment: Environment,
): SimulationBrokerConfig {
  for (const name of RAW_SECRETS)
    if (environment[name]?.trim()) throw new Error(`RAW_SECRET_FORBIDDEN:${name}`)
  if (
    environment.NODE_ENV !== 'production' ||
    environment.COMMERCIAL_MODE !== 'simulation' ||
    environment.A3_ENABLED !== 'false' ||
    environment.EXTERNAL_RESEARCH_ENABLED !== 'false' ||
    environment.EXTERNAL_ACTION_KILL_SWITCH !== 'true'
  )
    throw new Error('SIMULATION_BOUNDARY_INVALID')

  const host = required(environment, 'BROKER_HOST')
  if (host !== '0.0.0.0' && host !== '127.0.0.1')
    throw new Error('BROKER_HOST_INVALID')
  const port = Number(required(environment, 'BROKER_PORT'))
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535)
    throw new Error('BROKER_PORT_INVALID')
  const deployedVersion = required(environment, 'DEPLOYED_VERSION')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(deployedVersion))
    throw new Error('DEPLOYED_VERSION_INVALID')

  const databaseSecretFiles = DATABASE_FILES.map((name) => ({
    name: name.slice(0, -'_FILE'.length),
    path: requiredSecretPath(environment, name),
  }))
  const applicationSecretFiles = Object.fromEntries(
    APPLICATION_FILES.map((name) => [name, requiredSecretPath(environment, name)]),
  ) as SimulationBrokerConfig['applicationSecretFiles']
  const approvalActors = {
    sales: parseActors(environment, 'SALES_APPROVER_IDS'),
    telegram: parseActors(environment, 'TELEGRAM_APPROVER_IDS'),
  }

  return {
    mode: 'simulation',
    host,
    port,
    deployedVersion,
    databaseSecretFiles,
    applicationSecretFiles,
    workOrderAuthority: {
      issuer: required(environment, 'WORK_ORDER_ISSUER'),
      audience: required(environment, 'WORK_ORDER_AUDIENCE'),
      keyId: required(environment, 'WORK_ORDER_KEY_ID'),
    },
    approvalMode: parseApprovalMode(environment.APPROVAL_MODE),
    approvalActors,
    secretGid: BROKER_SERVICE_GID,
    a3AdmissionEnabled: false,
  }
}

export interface SecretFileMetadata {
  isFile: boolean
  isSymbolicLink: boolean
  uid: number
  mode: number
  size: number
}

export function validateSecretFileMetadata(
  metadata: SecretFileMetadata,
  expectedUid: number,
): void {
  if (
    !metadata.isFile ||
    metadata.isSymbolicLink ||
    metadata.uid !== expectedUid ||
    (metadata.mode & 0o400) === 0 ||
    (metadata.mode & 0o177) !== 0 ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 1 ||
    metadata.size > 16_384
  )
    throw new Error('UNSAFE_SECRET_FILE')
}

export async function readOwnerSecretFile(
  path: string,
  expectedUid = process.getuid?.(),
): Promise<string> {
  if (!isAbsolute(path) || expectedUid === undefined)
    throw new Error('UNSAFE_SECRET_FILE')
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0
  const handle = await open(path, fsConstants.O_RDONLY | noFollow)
  try {
    const metadata = await handle.stat()
    validateSecretFileMetadata(
      {
        isFile: metadata.isFile(),
        isSymbolicLink: metadata.isSymbolicLink(),
        uid: metadata.uid,
        mode: metadata.mode,
        size: metadata.size,
      },
      expectedUid,
    )
    const value = (await handle.readFile('utf8')).trim()
    if (!value || value.includes('\u0000')) throw new Error('UNSAFE_SECRET_FILE')
    return value
  } finally {
    await handle.close()
  }
}

export async function expandDatabaseSecretFiles(
  config: SimulationBrokerConfig,
  environment: Environment,
): Promise<Environment> {
  const expanded: Environment = { ...environment }
  for (const secret of config.databaseSecretFiles)
    expanded[secret.name] = await readGroupSecretFile(secret.path, config.secretGid)
  return expanded
}

export async function readApplicationSecrets(
  config: SimulationBrokerConfig,
): Promise<ApplicationSecrets> {
  const files = config.applicationSecretFiles
  const secrets = {
    workOrderHmac: await readGroupSecretFile(files.WORK_ORDER_HMAC_SECRET_FILE, config.secretGid),
    controlPlane: await readGroupSecretFile(files.CONTROL_PLANE_BEARER_FILE, config.secretGid),
    approvalSalesGateway: await readGroupSecretFile(
      files.APPROVAL_SALES_GATEWAY_BEARER_FILE,
      config.secretGid,
    ),
    approvalTelegramGateway: await readGroupSecretFile(
      files.APPROVAL_TELEGRAM_GATEWAY_BEARER_FILE,
      config.secretGid,
    ),
    connector: await readGroupSecretFile(files.CONNECTOR_BEARER_FILE, config.secretGid),
    internal: await readGroupSecretFile(files.INTERNAL_BEARER_FILE, config.secretGid),
    approvalHmac: await readGroupSecretFile(files.APPROVAL_HMAC_SECRET_FILE, config.secretGid),
  }
  assertDistinctApplicationSecrets(secrets)
  return secrets
}

export function assertBrokerServiceIdentity(actualGid = process.getgid?.()): void {
  assertPrimaryServiceGid(BROKER_SERVICE_GID, actualGid)
}

export function assertDistinctApplicationSecrets(
  secrets: ApplicationSecrets,
): void {
  const values = Object.values(secrets)
  if (
    values.some((value) => Buffer.byteLength(value) < 32) ||
    new Set(values).size !== values.length
  )
    throw new Error('APPLICATION_SECRETS_NOT_DISTINCT')
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}

function requiredSecretPath(environment: Environment, name: string): string {
  const path = required(environment, name)
  if (!isAbsolute(path) || !path.startsWith('/run/secrets/'))
    throw new Error(`${name}_INVALID`)
  return path
}

function parseActors(environment: Environment, name: string): string[] {
  const actors = required(environment, name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (
    actors.length === 0 ||
    new Set(actors).size !== actors.length ||
    actors.some((value) => !/^[A-Za-z0-9._:@-]{1,128}$/.test(value))
  )
    throw new Error(`${name}_INVALID`)
  return actors
}
