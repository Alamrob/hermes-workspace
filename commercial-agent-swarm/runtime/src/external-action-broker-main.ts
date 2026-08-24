import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { BrokerKillSwitchClient } from './broker-kill-switch-client.js'
import { ExternalActionBrokerApplication } from './external-action-broker.js'
import { HostingerMailApiClient } from './hostinger-mail-api.js'
import { readGroupSecretFile } from './secret-file.js'
import { TelegramBotApiClient } from './telegram-bot-api.js'

const SERVICE_UID = 10014
const SERVICE_GID = 10014
const PROXY_URL = 'http://external-egress-proxy:3128'
const MAX_BODY_BYTES = 32_768

export type ExternalActionBrokerConfig = ReturnType<typeof loadExternalActionBrokerConfig>

export function loadExternalActionBrokerConfig(environment: Record<string, string | undefined>) {
  if (environment.NODE_ENV !== 'production') throw new Error('EXTERNAL_ACTION_ENVIRONMENT_INVALID')
  const host = environment.EXTERNAL_ACTION_BROKER_HOST
  const port = Number(environment.EXTERNAL_ACTION_BROKER_PORT)
  if (host !== '0.0.0.0' || !Number.isSafeInteger(port) || port !== 8091)
    throw new Error('EXTERNAL_ACTION_LISTENER_INVALID')
  const hostingerEnabled = flag(environment, 'HOSTINGER_MAIL_ENABLED')
  const telegramEnabled = flag(environment, 'TELEGRAM_APPROVAL_ENABLED')
  const providersEnabled = hostingerEnabled || telegramEnabled
  const bearerFile = secretFile(environment, 'EXTERNAL_ACTION_BROKER_BEARER_FILE')
  const brokerInternalFile = providersEnabled
    ? secretFile(environment, 'BROKER_INTERNAL_BEARER_FILE')
    : null
  const hostingerTokenFile = hostingerEnabled ? secretFile(environment, 'HOSTINGER_MAIL_TOKEN_FILE') : null
  const telegramTokenFile = telegramEnabled ? secretFile(environment, 'TELEGRAM_BOT_TOKEN_FILE') : null
  const telegramChatId = telegramEnabled ? environment.TELEGRAM_APPROVER_CHAT_ID?.trim() : null
  if (telegramEnabled && (!telegramChatId || !/^-?[0-9]{5,20}$/.test(telegramChatId)))
    throw new Error('TELEGRAM_APPROVER_CHAT_ID_INVALID')
  const proxyUrl = environment.EXTERNAL_ACTION_PROXY_URL?.trim()
  if (providersEnabled && proxyUrl !== PROXY_URL)
    throw new Error('EXTERNAL_ACTION_PROXY_INVALID')
  return {
    host, port, hostingerEnabled, telegramEnabled, bearerFile, brokerInternalFile,
    hostingerTokenFile, telegramTokenFile, telegramChatId, proxyUrl: proxyUrl ?? null,
  }
}

export async function startExternalActionBroker(
  environment: Record<string, string | undefined> = process.env,
): Promise<{ close: () => Promise<void> }> {
  assertServiceIdentity()
  const config = loadExternalActionBrokerConfig(environment)
  const read = (path: string) => readGroupSecretFile(path, SERVICE_GID)
  const bearer = await read(config.bearerFile)
  const brokerInternal = config.brokerInternalFile
    ? await read(config.brokerInternalFile)
    : null
  if (brokerInternal !== null && bearer.trim() === brokerInternal.trim())
    throw new Error('EXTERNAL_ACTION_SECRET_REUSE')
  const dispatcher = config.hostingerEnabled || config.telegramEnabled
    ? new ProxyAgent(PROXY_URL)
    : null
  const externalFetch = dispatcher
    ? (((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        undiciFetch(input as Parameters<typeof undiciFetch>[0], {
          ...(init as Parameters<typeof undiciFetch>[1]), dispatcher,
        }) as unknown as Promise<Response>) as typeof fetch)
    : undefined
  const safety = config.brokerInternalFile
    ? new BrokerKillSwitchClient({ readBearer: () => read(config.brokerInternalFile!) })
    : { isActive: async () => true }
  const hostinger = config.hostingerEnabled
    ? new HostingerMailApiClient({
        readToken: () => read(config.hostingerTokenFile!), fetch: externalFetch,
      })
    : undefined
  const telegram = config.telegramEnabled
    ? new TelegramBotApiClient({
        readToken: () => read(config.telegramTokenFile!),
        chatId: config.telegramChatId!, fetch: externalFetch,
      })
    : undefined
  try {
    await Promise.all([hostinger?.ready(), telegram?.ready()])
    const app = new ExternalActionBrokerApplication({
      bearer: bearer.trim(), hostingerEnabled: config.hostingerEnabled,
      telegramEnabled: config.telegramEnabled, safety, hostinger, telegram,
    })
    const server = createExternalActionBrokerHttpServer(app)
    server.requestTimeout = 15_000
    server.headersTimeout = 5_000
    server.keepAliveTimeout = 2_000
    server.maxHeadersCount = 32
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => { server.off('error', reject); resolve() })
    })
    let closing: Promise<void> | undefined
    return {
      close: () => (closing ??= (async () => {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        await dispatcher?.close()
      })()),
    }
  } catch (error) {
    await dispatcher?.close()
    throw error
  }
}

export function createExternalActionBrokerHttpServer(app: ExternalActionBrokerApplication) {
  return createServer((request, response) => {
    void (async () => {
      try {
        const body = await readJsonBody(request)
        const path = new URL(request.url ?? '/', 'http://external-action-broker.local').pathname
        const result = await app.handle({
          method: request.method ?? 'GET', path,
          authorization: stringHeader(request.headers.authorization), body,
        })
        response.writeHead(result.status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        })
        response.end(JSON.stringify(result.body))
      } catch (error) {
        const status = error instanceof PayloadTooLargeError ? 413 : error instanceof InvalidJsonError ? 400 : 500
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: status === 413 ? 'payload_too_large' : status === 400 ? 'invalid_json' : 'internal_error' }))
      }
    })()
  })
}

function flag(environment: Record<string, string | undefined>, name: string): boolean {
  const value = environment[name]
  if (value === undefined || value === '' || value === 'false') return false
  if (value === 'true') return true
  throw new Error(`EXTERNAL_ACTION_FLAG_INVALID:${name}`)
}

function secretFile(environment: Record<string, string | undefined>, name: string): string {
  const rawName = name.replace(/_FILE$/, '')
  if (environment[rawName]?.trim()) throw new Error(`EXTERNAL_ACTION_RAW_SECRET_FORBIDDEN:${rawName}`)
  const value = environment[name]?.trim()
  if (!value || !value.startsWith('/run/secrets/') || value.includes('..'))
    throw new Error(`EXTERNAL_ACTION_SECRET_FILE_INVALID:${name}`)
  return value
}

function assertServiceIdentity(): void {
  if (process.platform === 'win32') return
  if (process.getuid?.() !== SERVICE_UID || process.getgid?.() !== SERVICE_GID)
    throw new Error('EXTERNAL_ACTION_SERVICE_IDENTITY_INVALID')
}

async function readJsonBody(request: AsyncIterable<Buffer | Uint8Array | string> & { headers: Record<string, unknown> }): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (declared > MAX_BODY_BYTES) throw new PayloadTooLargeError()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError()
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new InvalidJsonError() }
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

class PayloadTooLargeError extends Error {}
class InvalidJsonError extends Error {}

async function main(): Promise<void> {
  const broker = await startExternalActionBroker()
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void broker.close().then(() => process.exit(0), () => process.exit(1))
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main()
