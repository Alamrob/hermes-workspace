import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { readGroupSecretFile } from './secret-file.js'
import {
  TelegramApprovalPoller,
  TelegramBotControlClient,
  TelegramBrokerControlClient,
} from './telegram-approval-poller.js'
import { FileTelegramCursorStore } from './telegram-cursor-store.js'

const SERVICE_UID = 10016
const SERVICE_GID = 10016
const TELEGRAM_SECRET_GID = 10014
const PROXY_URL = 'http://172.16.12.1:3130'
const BROKER_URL = 'http://broker:8080'
const STATE_PATH = '/var/lib/proptimiza-telegram/cursor.json'

export function loadTelegramApprovalPollerConfig(environment: Record<string, string | undefined>) {
  if (environment.NODE_ENV !== 'production') throw new Error('TELEGRAM_POLLER_ENVIRONMENT_INVALID')
  if (environment.TELEGRAM_BOT_TOKEN?.trim() || environment.TELEGRAM_APPROVER_CHAT_ID?.trim() ||
      environment.TELEGRAM_BROKER_BEARER?.trim())
    throw new Error('TELEGRAM_POLLER_RAW_SECRET_FORBIDDEN')
  const enabled = flag(environment.TELEGRAM_CONTROL_ENABLED)
  const host = environment.TELEGRAM_POLLER_HOST?.trim()
  const port = Number(environment.TELEGRAM_POLLER_PORT)
  if (host !== '0.0.0.0' || port !== 8092) throw new Error('TELEGRAM_POLLER_LISTENER_INVALID')
  if (!enabled) return { enabled, host, port } as const
  if (environment.TELEGRAM_BROKER_URL?.trim() !== BROKER_URL)
    throw new Error('TELEGRAM_POLLER_BROKER_URL_INVALID')
  if (environment.TELEGRAM_PROXY_URL?.trim() !== PROXY_URL)
    throw new Error('TELEGRAM_POLLER_PROXY_INVALID')
  if (environment.TELEGRAM_CURSOR_PATH?.trim() !== STATE_PATH)
    throw new Error('TELEGRAM_POLLER_STATE_PATH_INVALID')
  const actorId = environment.TELEGRAM_ACTOR_ID?.trim()
  if (actorId !== 'telegram-gateway') throw new Error('TELEGRAM_POLLER_ACTOR_INVALID')
  return {
    enabled, host, port, actorId,
    botTokenFile: secretPath(environment.TELEGRAM_BOT_TOKEN_FILE),
    approverChatIdFile: secretPath(environment.TELEGRAM_APPROVER_CHAT_ID_FILE),
    brokerBearerFile: secretPath(environment.TELEGRAM_BROKER_BEARER_FILE),
    brokerUrl: BROKER_URL,
    proxyUrl: PROXY_URL,
    statePath: STATE_PATH,
  } as const
}

export async function startTelegramApprovalPoller(
  environment: Record<string, string | undefined> = process.env,
): Promise<{ close: () => Promise<void> }> {
  assertIdentity()
  const config = loadTelegramApprovalPollerConfig(environment)
  let closing = false
  let lastSuccess: string | null = null
  let consecutiveErrors = 0
  let loop: Promise<void> | undefined
  let dispatcher: ProxyAgent | undefined

  if (config.enabled) {
    const chatId = (await readGroupSecretFile(config.approverChatIdFile, TELEGRAM_SECRET_GID)).trim()
    const cursor = new FileTelegramCursorStore(config.statePath)
    dispatcher = new ProxyAgent(config.proxyUrl)
    const externalFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as Parameters<typeof undiciFetch>[1]), dispatcher,
      }) as unknown as Promise<Response>) as typeof fetch
    const poller = new TelegramApprovalPoller({
      approverChatId: chatId,
      cursor,
      telegram: new TelegramBotControlClient({
        readToken: () => readGroupSecretFile(config.botTokenFile, TELEGRAM_SECRET_GID),
        chatId,
        fetch: externalFetch,
      }),
      broker: new TelegramBrokerControlClient({
        baseUrl: config.brokerUrl,
        readBearer: () => readGroupSecretFile(config.brokerBearerFile, SERVICE_GID),
        actorId: config.actorId,
      }),
    })
    loop = (async () => {
      while (!closing) {
        try {
          const result = await poller.tick()
          lastSuccess = new Date().toISOString()
          consecutiveErrors = 0
          process.stdout.write(`${JSON.stringify({ event: 'telegram_control_tick', ...result, at: lastSuccess })}\n`)
        } catch (error) {
          consecutiveErrors += 1
          const code = error instanceof Error && /^[A-Z0-9_:.-]{1,128}$/.test(error.message)
            ? error.message : 'TELEGRAM_CONTROL_FAILURE'
          process.stderr.write(`${JSON.stringify({ event: 'telegram_control_error', code, consecutive_errors: consecutiveErrors })}\n`)
          await delay(5_000)
        }
      }
    })()
  }

  const server = createServer((request, response) => {
    if (request.method === 'GET' && (request.url === '/healthz' || request.url === '/readyz')) {
      const ready = !config.enabled || consecutiveErrors < 3
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready', enabled: config.enabled, last_success: lastSuccess }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: 'not_found' }))
  })
  server.requestTimeout = 5_000
  server.headersTimeout = 3_000
  server.keepAliveTimeout = 1_000
  server.maxHeadersCount = 16
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve() })
  })

  let closePromise: Promise<void> | undefined
  return {
    close: () => (closePromise ??= (async () => {
      closing = true
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await loop
      await dispatcher?.close()
    })()),
  }
}

function flag(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'false') return false
  if (value === 'true') return true
  throw new Error('TELEGRAM_POLLER_FLAG_INVALID')
}

function secretPath(value: string | undefined): string {
  const path = value?.trim()
  if (!path || !path.startsWith('/run/secrets/') || path.includes('..'))
    throw new Error('TELEGRAM_POLLER_SECRET_PATH_INVALID')
  return path
}

function assertIdentity(): void {
  if (process.platform === 'win32') return
  if (process.getuid?.() !== SERVICE_UID || process.getgid?.() !== SERVICE_GID)
    throw new Error('TELEGRAM_POLLER_IDENTITY_INVALID')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function main(): Promise<void> {
  const service = await startTelegramApprovalPoller()
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void service.close().then(() => process.exit(0), () => process.exit(1))
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main()
