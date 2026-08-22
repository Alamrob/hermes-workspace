import type { TelegramTransport } from './approvals.js'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { DisabledExternalMailTransport } from './disabled-transports.js'
import {
  FeatureGatedHostingerMailTransport,
  FeatureGatedTelegramApprovalTransport,
} from './external-adapters.js'
import type { MailTransport } from './mail.js'
import {
  FetchOpenCodeUsageExportReader,
  OpenCodeUsageExportClient,
  OpenCodeUsageProbe,
  type OpenCodeUsageExportReadPort,
} from './opencode-usage-api.js'
import { readGroupSecretFile } from './secret-file.js'

type Environment = Record<string, string | undefined>
// The Usage export credential belongs to the broker service, never the Hermes
// executor supervisor or its child.
export const OPENCODE_USAGE_SERVICE_GID = 10001
export const OPENCODE_USAGE_PROXY_URL = 'http://egress-proxy:3128'

interface KillSwitchPort {
  isActive(input: { missionId: string; channel: string }): Promise<boolean>
}

interface HostingerPort {
  isBlocked(input: { mailbox: string; recipient: string }): Promise<boolean>
  sendInternal(input: {
    mailbox: 'ventas@proptimiza.com'
    recipient: 'contacto@proptimiza.com'
    subject: string
    content: string
    idempotencyKey: string
  }): Promise<{ receipt_id: string }>
}

interface TelegramPort {
  postApprovalRequest(request: {
    approval_id: string
    mission_id: string
    action_hash: string
  }): Promise<void>
}

export function createBrokerExternalTransports(
  environment: Environment,
  dependencies: {
    killSwitch?: KillSwitchPort
    hostinger?: HostingerPort
    telegram?: TelegramPort
  } = {},
): { mail: MailTransport; telegram: TelegramTransport | undefined } {
  const hostingerEnabled = flag(environment, 'HOSTINGER_MAIL_ENABLED')
  const telegramEnabled = flag(environment, 'TELEGRAM_APPROVAL_ENABLED')
  if (!hostingerEnabled && !telegramEnabled)
    return { mail: new DisabledExternalMailTransport(), telegram: undefined }
  if (environment.NODE_ENV !== 'production') throw new Error('EXTERNAL_TRANSPORT_ENVIRONMENT_INVALID')
  if (hostingerEnabled && !dependencies.hostinger) throw new Error('HOSTINGER_PORT_REQUIRED')
  if (telegramEnabled && !dependencies.telegram) throw new Error('TELEGRAM_PORT_REQUIRED')
  if (!dependencies.killSwitch) throw new Error('KILL_SWITCH_PORT_REQUIRED')
  return {
    mail: hostingerEnabled
      ? new FeatureGatedHostingerMailTransport({
          enabled: true,
          killSwitch: dependencies.killSwitch,
          hostinger: dependencies.hostinger!,
        })
      : new DisabledExternalMailTransport(),
    telegram: telegramEnabled
      ? new FeatureGatedTelegramApprovalTransport({
          enabled: true,
          killSwitch: dependencies.killSwitch,
          telegram: dependencies.telegram!,
        })
      : undefined,
  }
}

export type OpenCodeUsageProbeFactoryResult =
  | { enabled: false }
  | { enabled: true; serviceAccountId: string; probe: OpenCodeUsageProbe }

export function createOpenCodeUsageProbeFromEnvironment(
  environment: Environment,
  dependencies: {
    reader?: OpenCodeUsageExportReadPort
    readToken?: (path: string, expectedGid: number) => Promise<string>
  } = {},
): OpenCodeUsageProbeFactoryResult {
  if (environment.OPENCODE_USAGE_TOKEN?.trim())
    throw new Error('OPENCODE_USAGE_RAW_TOKEN_FORBIDDEN')
  if (!flag(environment, 'OPENCODE_USAGE_RECONCILIATION_ENABLED'))
    return { enabled: false }
  if (environment.NODE_ENV !== 'production') throw new Error('OPENCODE_USAGE_ENVIRONMENT_INVALID')
  const serviceAccountId = environment.OPENCODE_USAGE_SERVICE_ACCOUNT_ID?.trim()
  if (!serviceAccountId || !/^[A-Za-z0-9._:-]{8,256}$/.test(serviceAccountId))
    throw new Error('OPENCODE_USAGE_SERVICE_ACCOUNT_INVALID')
  const tokenFile = secretPath(environment.OPENCODE_USAGE_TOKEN_FILE)
  const proxyUrl = environment.OPENCODE_USAGE_PROXY_URL?.trim()
  if (proxyUrl !== OPENCODE_USAGE_PROXY_URL)
    throw new Error('OPENCODE_USAGE_PROXY_INVALID')
  const readToken = dependencies.readToken ?? readGroupSecretFile
  const client = new OpenCodeUsageExportClient({
    reader:
      dependencies.reader ??
      new FetchOpenCodeUsageExportReader({ fetch: createProxyFetch(proxyUrl) }),
    readToken: () => readToken(tokenFile, OPENCODE_USAGE_SERVICE_GID),
  })
  return {
    enabled: true,
    serviceAccountId,
    probe: new OpenCodeUsageProbe({ client }),
  }
}

function createProxyFetch(proxyUrl: typeof OPENCODE_USAGE_PROXY_URL): typeof fetch {
  const dispatcher = new ProxyAgent(proxyUrl)
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>) as typeof fetch
}

function flag(environment: Environment, name: string): boolean {
  const value = environment[name]
  if (value === undefined || value === '' || value === 'false') return false
  if (value === 'true') return true
  throw new Error(`EXTERNAL_TRANSPORT_FLAG_INVALID:${name}`)
}

function secretPath(value: string | undefined): string {
  const path = value?.trim()
  if (!path || !path.startsWith('/run/secrets/') || path.includes('..'))
    throw new Error('OPENCODE_USAGE_TOKEN_FILE_INVALID')
  return path
}
