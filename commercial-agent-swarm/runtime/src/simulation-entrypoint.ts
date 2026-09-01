import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createPublicKey } from 'node:crypto'
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
  'INSTRUCTION_INBOX_BEARER_FILE',
  'SALES_COMMAND_BEARER_FILE',
  'SHADOW_REVIEW_BEARER_FILE',
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
  'INSTRUCTION_INBOX_BEARER',
  'SALES_COMMAND_BEARER',
  'SHADOW_REVIEW_BEARER',
  'APPROVAL_HMAC_SECRET',
  'CUSTOM_API_KEY',
  'OPENCODE_GO_API_KEY',
  'MAIL_TOKEN',
  'TELEGRAM_TOKEN',
  'HOSTINGER_WEBHOOK_MAILBOX_KEY',
  'HOSTINGER_WEBHOOK_BEARER',
] as const

export interface SimulationBrokerConfig {
  mode: 'simulation'
  host: '0.0.0.0' | '127.0.0.1'
  port: number
  deployedVersion: string
  databaseSecretFiles: Array<{ name: string; path: string }>
  applicationSecretFiles: Record<(typeof APPLICATION_FILES)[number], string>
  workOrderAuthority: { issuer: string; audience: string; keyId: string }
  a1WorkOrderAuthority: { keyId: string; publicKeyFile: string } | null
  approvalMode: ApprovalMode
  approvalActors: { sales: string[]; telegram: string[] }
  hostingerWebhookSecretFiles: { mailboxKey: string; bearer: string } | null
  secretGid: typeof BROKER_SERVICE_GID
  a3AdmissionEnabled: false
  dispatchLoopMode: 'automatic' | 'manual'
}

export interface InternalMailBrokerConfig extends Omit<SimulationBrokerConfig, 'mode' | 'a3AdmissionEnabled'> {
  mode: 'internal_mail_test'
  a3AdmissionEnabled: true
}

export type BrokerConfig = SimulationBrokerConfig | InternalMailBrokerConfig

export interface ApplicationSecrets {
  workOrderHmac: string
  controlPlane: string
  approvalSalesGateway: string
  approvalTelegramGateway: string
  connector: string
  internal: string
  instructionInbox: string
  salesCommands: string
  shadowReview: string
  approvalHmac: string
}

export function loadSimulationBrokerConfig(
  environment: Environment,
): SimulationBrokerConfig {
  rejectRawSecrets(environment)
  if (
    environment.NODE_ENV !== 'production' ||
    environment.COMMERCIAL_MODE !== 'simulation' ||
    environment.A3_ENABLED !== 'false' ||
    environment.EXTERNAL_RESEARCH_ENABLED !== 'false' ||
    environment.EXTERNAL_ACTION_KILL_SWITCH !== 'true'
  )
    throw new Error('SIMULATION_BOUNDARY_INVALID')

  return loadBrokerConfigFields(environment, 'simulation', false)
}

export function loadInternalMailBrokerConfig(
  environment: Environment,
): InternalMailBrokerConfig {
  rejectRawSecrets(environment)
  if (
    environment.NODE_ENV !== 'production' ||
    environment.COMMERCIAL_MODE !== 'internal_mail_test' ||
    environment.A3_ENABLED !== 'true' ||
    environment.EXTERNAL_RESEARCH_ENABLED !== 'false' ||
    environment.EXTERNAL_ACTION_KILL_SWITCH !== 'true' ||
    environment.HOSTINGER_MAIL_ENABLED !== 'true' ||
    environment.TELEGRAM_APPROVAL_ENABLED !== 'false'
  )
    throw new Error('INTERNAL_MAIL_BOUNDARY_INVALID')
  return loadBrokerConfigFields(environment, 'internal_mail_test', true)
}

export function loadBrokerConfig(environment: Environment): BrokerConfig {
  if (environment.COMMERCIAL_MODE === 'simulation')
    return loadSimulationBrokerConfig(environment)
  if (environment.COMMERCIAL_MODE === 'internal_mail_test')
    return loadInternalMailBrokerConfig(environment)
  throw new Error('COMMERCIAL_MODE_INVALID')
}

function loadBrokerConfigFields<M extends BrokerConfig['mode'], A extends boolean>(
  environment: Environment,
  mode: M,
  a3AdmissionEnabled: A,
): Extract<BrokerConfig, { mode: M }> {

  const host = required(environment, 'BROKER_HOST')
  if (host !== '0.0.0.0' && host !== '127.0.0.1')
    throw new Error('BROKER_HOST_INVALID')
  const port = Number(required(environment, 'BROKER_PORT'))
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535)
    throw new Error('BROKER_PORT_INVALID')
  const deployedVersion = required(environment, 'DEPLOYED_VERSION')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(deployedVersion))
    throw new Error('DEPLOYED_VERSION_INVALID')
  const dispatchLoopMode = environment.DISPATCH_LOOP_MODE ?? 'automatic'
  if (dispatchLoopMode !== 'automatic' && dispatchLoopMode !== 'manual')
    throw new Error('DISPATCH_LOOP_MODE_INVALID')

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
  const hostingerWebhookSecretFiles = optionalSecretPair(
    environment,
    'HOSTINGER_WEBHOOK_MAILBOX_KEY_FILE',
    'HOSTINGER_WEBHOOK_BEARER_FILE',
  )
  const a1WorkOrderAuthority = optionalA1WorkOrderAuthority(environment)

  return {
    mode,
    host,
    port,
    deployedVersion,
    dispatchLoopMode,
    databaseSecretFiles,
    applicationSecretFiles,
    workOrderAuthority: {
      issuer: required(environment, 'WORK_ORDER_ISSUER'),
      audience: required(environment, 'WORK_ORDER_AUDIENCE'),
      keyId: required(environment, 'WORK_ORDER_KEY_ID'),
    },
    a1WorkOrderAuthority,
    approvalMode: parseApprovalMode(environment.APPROVAL_MODE),
    approvalActors,
    hostingerWebhookSecretFiles,
    secretGid: BROKER_SERVICE_GID,
    a3AdmissionEnabled,
  } as Extract<BrokerConfig, { mode: M }>
}

export async function readA1WorkOrderPublicKeys(
  config: BrokerConfig,
): Promise<Record<string, string>> {
  if (config.a1WorkOrderAuthority === null) return {}
  const pem = await readGroupSecretFile(
    config.a1WorkOrderAuthority.publicKeyFile,
    config.secretGid,
  )
  try {
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('type')
  } catch {
    throw new Error('A1_WORK_ORDER_ED25519_PUBLIC_KEY_INVALID')
  }
  return { [config.a1WorkOrderAuthority.keyId]: pem }
}

function rejectRawSecrets(environment: Environment): void {
  for (const name of RAW_SECRETS)
    if (environment[name]?.trim()) throw new Error(`RAW_SECRET_FORBIDDEN:${name}`)
}

export async function readHostingerWebhookMailboxSecrets(
  config: BrokerConfig,
  applicationSecrets: ApplicationSecrets,
): Promise<Record<string, string>> {
  const files = config.hostingerWebhookSecretFiles
  if (files === null) return {}
  const values = {
    mailboxKey: await readGroupSecretFile(files.mailboxKey, config.secretGid),
    bearer: await readGroupSecretFile(files.bearer, config.secretGid),
  }
  assertHostingerWebhookSecrets(values, applicationSecrets)
  return { [values.mailboxKey]: values.bearer }
}

export function assertHostingerWebhookSecrets(
  values: { mailboxKey: string; bearer: string },
  applicationSecrets: ApplicationSecrets,
): void {
  if (
    !/^[A-Za-z0-9_-]{32,128}$/.test(values.mailboxKey) ||
    !/^[\x21-\x7e]{32,8192}$/.test(values.bearer)
  )
    throw new Error('HOSTINGER_WEBHOOK_SECRET_FORMAT_INVALID')
  if (
    values.mailboxKey === values.bearer ||
    Object.values(applicationSecrets).includes(values.mailboxKey) ||
    Object.values(applicationSecrets).includes(values.bearer)
  )
    throw new Error('HOSTINGER_WEBHOOK_SECRET_REUSE')
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
  config: BrokerConfig,
  environment: Environment,
): Promise<Environment> {
  const expanded: Environment = { ...environment }
  for (const secret of config.databaseSecretFiles)
    expanded[secret.name] = await readGroupSecretFile(secret.path, config.secretGid)
  return expanded
}

export async function readApplicationSecrets(
  config: BrokerConfig,
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
    instructionInbox: await readGroupSecretFile(
      files.INSTRUCTION_INBOX_BEARER_FILE,
      config.secretGid,
    ),
    salesCommands: await readGroupSecretFile(
      files.SALES_COMMAND_BEARER_FILE,
      config.secretGid,
    ),
    shadowReview: await readGroupSecretFile(
      files.SHADOW_REVIEW_BEARER_FILE,
      config.secretGid,
    ),
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

function optionalSecretPair(
  environment: Environment,
  firstName: string,
  secondName: string,
): { mailboxKey: string; bearer: string } | null {
  const first = environment[firstName]?.trim()
  const second = environment[secondName]?.trim()
  if (!first && !second) return null
  if (!first || !second) throw new Error('HOSTINGER_WEBHOOK_SECRET_PAIR_REQUIRED')
  return {
    mailboxKey: requiredSecretPath(environment, firstName),
    bearer: requiredSecretPath(environment, secondName),
  }
}

function optionalA1WorkOrderAuthority(
  environment: Environment,
): { keyId: string; publicKeyFile: string } | null {
  const keyId = environment.A1_WORK_ORDER_ED25519_KEY_ID?.trim()
  const publicKeyFile = environment.A1_WORK_ORDER_ED25519_PUBLIC_KEY_FILE?.trim()
  if (!keyId && !publicKeyFile) return null
  if (!keyId || !publicKeyFile || !/^[A-Za-z0-9._:-]{1,128}$/.test(keyId))
    throw new Error('A1_WORK_ORDER_ED25519_CONFIG_INVALID')
  return {
    keyId,
    publicKeyFile: requiredSecretPath(environment, 'A1_WORK_ORDER_ED25519_PUBLIC_KEY_FILE'),
  }
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
