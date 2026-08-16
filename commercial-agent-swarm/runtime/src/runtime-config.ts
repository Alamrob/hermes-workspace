const BROKER_FORBIDDEN = [
  /^CUSTOM_API_/i,
  /^(?:OPENAI|ANTHROPIC|LLM|HERMES|MAIL|SMTP|IMAP|TELEGRAM|WHATSAPP|CRM|HUBSPOT|HOSTINGER|DOCKER|SSH|AWS|GITHUB)_/i,
]
const EXECUTOR_FORBIDDEN = [
  /^DATABASE_URL(?:_FILE)?$/i,
  /^(?:APPROVER|SAFETY|WORK_ORDER)_DATABASE_URL(?:_FILE)?$/i,
  /^(?:MAIL|SMTP|IMAP|TELEGRAM|WHATSAPP|CRM|HUBSPOT|HOSTINGER|DOCKER|SSH|PG|AWS|GITHUB)_/i,
]
const CREDENTIAL_NAME =
  /(?:KEY|TOKEN|PASSWORD|PASSWD|SECRET|COOKIE|CREDENTIAL)/i
export const EXECUTOR_SOCKET_DIRECTORY = '/run/commercial-swarm'
export const EXECUTOR_SOCKET_PATH = `${EXECUTOR_SOCKET_DIRECTORY}/executor.sock`
export const HERMES_TEMPORARY_ROOT = '/run/commercial-swarm/hermes-executor'
export const EXECUTOR_UID = 10000
export const EXECUTOR_GID = 10000
export const EXECUTOR_CHILD_UID = 10002
export const EXECUTOR_CHILD_GID = 10002
export const EXECUTOR_IPC_GID = 11000

export interface BrokerRuntimeConfig {
  socketPath: string
  clientTimeoutMs: number
  hermesTimeoutMs: number
  leaseSeconds: number
  childTimeoutSeconds: number
}
export interface ExecutorRuntimeConfig {
  socketPath: string
  socketDirectory: string
  ipcGid: number
  executorUid: 10000
  executorGid: 10000
  childUid: 10002
  childGid: 10002
  profileSeed: string
  seedSha256: string
  temporaryRoot: string
  customApiKeyFile: string
  hermesTimeoutMs: number
}

export function loadBrokerRuntimeConfig(
  env: Record<string, string | undefined>,
): BrokerRuntimeConfig {
  rejectNames(env, BROKER_FORBIDDEN, 'BROKER_SECRET_BOUNDARY', [
    'HERMES_TIMEOUT_MS',
    'OPENCODE_USAGE_RECONCILIATION_ENABLED',
    'OPENCODE_USAGE_SERVICE_ACCOUNT_ID',
    'OPENCODE_USAGE_TOKEN_FILE',
  ])
  const socketPath = required(env, 'EXECUTOR_SOCKET_PATH')
  const hermesTimeoutMs = integer(env, 'HERMES_TIMEOUT_MS', 1, 3_600_000)
  const clientTimeoutMs = integer(
    env,
    'EXECUTOR_CLIENT_TIMEOUT_MS',
    hermesTimeoutMs + 5_000,
    3_660_000,
  )
  const leaseSeconds = integer(env, 'DISPATCH_LEASE_SECONDS', 2, 3600)
  const childTimeoutSeconds = Math.ceil(hermesTimeoutMs / 1000)
  if (
    leaseSeconds * 1000 <= clientTimeoutMs ||
    childTimeoutSeconds >= leaseSeconds
  )
    throw new Error('EXECUTOR_TIMEOUT_ORDER_INVALID')
  return {
    socketPath,
    clientTimeoutMs,
    hermesTimeoutMs,
    leaseSeconds,
    childTimeoutSeconds,
  }
}
export function loadExecutorRuntimeConfig(
  env: Record<string, string | undefined>,
): ExecutorRuntimeConfig {
  rejectNames(env, EXECUTOR_FORBIDDEN, 'EXECUTOR_SECRET_BOUNDARY', [
    'CUSTOM_API_KEY_FILE',
  ])
  const socketPath = required(env, 'EXECUTOR_SOCKET_PATH')
  const socketDirectory = required(env, 'EXECUTOR_SOCKET_DIRECTORY')
  if (
    socketPath !== EXECUTOR_SOCKET_PATH ||
    socketDirectory !== EXECUTOR_SOCKET_DIRECTORY
  )
    throw new Error('UNSAFE_EXECUTOR_SOCKET_PATH')
  const temporaryRoot = required(env, 'HERMES_TEMPORARY_ROOT')
  if (temporaryRoot !== HERMES_TEMPORARY_ROOT)
    throw new Error('UNSAFE_HERMES_TEMPORARY_ROOT')
  const ipcGid = integer(env, 'EXECUTOR_IPC_GID', 1, 65535)
  if (ipcGid !== EXECUTOR_IPC_GID)
    throw new Error('EXECUTOR_IPC_GID_INVALID')
  return {
    socketPath,
    socketDirectory,
    ipcGid,
    executorUid: EXECUTOR_UID,
    executorGid: EXECUTOR_GID,
    childUid: EXECUTOR_CHILD_UID,
    childGid: EXECUTOR_CHILD_GID,
    profileSeed: required(env, 'HERMES_PROFILE_SEED'),
    seedSha256: required(env, 'HERMES_PROFILE_SEED_SHA256'),
    temporaryRoot,
    customApiKeyFile: required(env, 'CUSTOM_API_KEY_FILE'),
    hermesTimeoutMs: integer(env, 'HERMES_TIMEOUT_MS', 1, 3_600_000),
  }
}
function rejectNames(
  env: Record<string, string | undefined>,
  rules: Array<RegExp>,
  code: string,
  allowed: Array<string> = [],
) {
  for (const [name, value] of Object.entries(env))
    if (
      value &&
      !allowed.includes(name) &&
      (rules.some((rule) => rule.test(name)) || CREDENTIAL_NAME.test(name))
    )
      throw new Error(`${code}:${name}`)
}
function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}
function integer(
  env: Record<string, string | undefined>,
  name: string,
  min: number,
  max: number,
): number {
  const value = Number(required(env, name))
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name}_INVALID`)
  return value
}
