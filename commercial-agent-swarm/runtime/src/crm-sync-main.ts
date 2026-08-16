import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import {
  loadTwentyClientConfig,
  runCrmSyncOnce,
  syncTwentyInboundOnce,
  type CrmStream,
  type CrmSyncMode,
  type CrmSyncStorePort,
  type TwentyClientPort,
} from './crm-sync.js'
import { PostgresCrmSyncStore } from './postgres-crm-sync-store.js'
import { readOwnerSecretFile } from './simulation-entrypoint.js'
import {
  parseTwentyRestMapping,
  TwentyHttpClient,
  type TwentyRestMapping,
} from './twenty-http-client.js'

const STREAMS: CrmStream[] = [
  'pilot_targets', 'accounts', 'contacts', 'opportunities', 'notes',
]

export interface CrmProcessStorePort extends CrmSyncStorePort {
  ready(): Promise<boolean>
  getCursor(
    connectorId: 'twenty',
    stream: CrmStream,
  ): Promise<{ value: string | null; version: number }>
  listOutcomeUnknown(
    limit: number,
  ): Promise<Array<{ outboxId: string; errorCode: 'TWENTY_OUTCOME_UNKNOWN' }>>
  close?(): Promise<void>
}

export interface CrmSyncProcessConfig {
  mode: CrmSyncMode
  healthHost: '127.0.0.1' | '0.0.0.0'
  healthPort: number
  pollIntervalMs: 60_000
  workerId: string
  leaseSeconds: number
  databaseUrlFile?: string
  apiBaseUrl?: string
  tokenFile?: string
  mappingFile?: string
}

export function loadCrmSyncProcessConfig(
  environment: Record<string, string | undefined>,
): CrmSyncProcessConfig {
  const mode = environment.CRM_SYNC_MODE
  if (environment.NODE_ENV !== 'production' || !['simulation', 'shadow', 'active'].includes(mode ?? ''))
    throw new Error('CRM_SYNC_MODE_INVALID')
  const host = environment.CRM_HEALTH_HOST?.trim()
  const port = Number(environment.CRM_HEALTH_PORT)
  if ((host !== '127.0.0.1' && host !== '0.0.0.0') || !Number.isSafeInteger(port) || port < 1024 || port > 65_535)
    throw new Error('CRM_SYNC_HEALTH_INVALID')
  const common = {
    mode: mode as CrmSyncMode,
    healthHost: host as '127.0.0.1' | '0.0.0.0',
    healthPort: port,
    pollIntervalMs: 60_000 as const,
    workerId: environment.CRM_SYNC_WORKER_ID?.trim() || 'crm-sync-1',
    leaseSeconds: Number(environment.CRM_SYNC_LEASE_SECONDS ?? '60'),
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(common.workerId) || !Number.isSafeInteger(common.leaseSeconds) || common.leaseSeconds < 5 || common.leaseSeconds > 300)
    throw new Error('CRM_SYNC_WORKER_INVALID')
  if (mode === 'simulation') return common
  const twenty = loadTwentyClientConfig(environment)
  const databaseUrlFile = secretPath(environment.CRM_DATABASE_URL_FILE, 'CRM_DATABASE_URL_FILE')
  const mappingFile = secretPath(environment.TWENTY_MAPPING_FILE, 'TWENTY_MAPPING_FILE')
  return {
    ...common,
    apiBaseUrl: twenty.apiBaseUrl,
    tokenFile: twenty.tokenFile,
    databaseUrlFile,
    mappingFile,
  }
}

export class CrmSyncDaemon {
  private readyState: boolean
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(private readonly options: {
    mode: CrmSyncMode
    workerId: string
    leaseSeconds: number
    pollIntervalMs: 60_000
    store: CrmProcessStorePort
    client: TwentyClientPort
  }) {
    this.readyState = options.mode === 'simulation'
  }

  async runCycle(): Promise<{ status: 'disabled' | 'ok' }> {
    if (this.options.mode === 'simulation') return { status: 'disabled' }
    try {
      if (!(await this.options.store.ready())) throw new Error('not ready')
      for (const stream of STREAMS) {
        const cursor = await this.options.store.getCursor('twenty', stream)
        await syncTwentyInboundOnce({
          mode: this.options.mode,
          stream,
          cursor,
          store: this.options.store,
          client: this.options.client,
        })
      }
      if (this.options.mode === 'active')
        await runCrmSyncOnce({
          mode: 'active', workerId: this.options.workerId,
          leaseSeconds: this.options.leaseSeconds,
          store: this.options.store, client: this.options.client,
        })
      this.failures = 0
      this.readyState = true
      return { status: 'ok' }
    } catch (error) {
      this.failures = Math.min(this.failures + 1, 3)
      this.readyState = false
      throw new Error('CRM_SYNC_CYCLE_FAILED', { cause: error })
    }
  }

  health() {
    return { live: !this.stopped, ready: this.readyState, mode: this.options.mode }
  }

  nextDelayMs(): number {
    return Math.min(
      this.options.pollIntervalMs * 2 ** this.failures,
      300_000,
    )
  }

  async reconcile(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('CRM_RECONCILE_LIMIT_INVALID')
    if (this.options.mode === 'simulation') return []
    return this.options.store.listOutcomeUnknown(limit)
  }

  start(): void {
    if (this.timer || this.stopped || this.options.mode === 'simulation') return
    const poll = async () => {
      try { await this.runCycle() } catch { /* readiness records the failure */ }
      if (!this.stopped) this.timer = setTimeout(poll, this.nextDelayMs())
    }
    this.timer = setTimeout(poll, 0)
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.options.store.close?.()
  }
}

interface RuntimeDependencies {
  readSecretFile(path: string): Promise<string>
  readMappingFile(path: string): Promise<string>
  createStore(databaseUrl: string): Promise<CrmProcessStorePort>
  createClient(options: {
    apiBaseUrl: string
    token: string
    mapping: TwentyRestMapping
  }): TwentyClientPort
}

export async function createCrmSyncRuntime(
  environment: Record<string, string | undefined>,
  dependencies: RuntimeDependencies,
): Promise<CrmSyncDaemon> {
  const config = loadCrmSyncProcessConfig(environment)
  if (config.mode === 'simulation')
    return new CrmSyncDaemon({
      ...config,
      store: simulationStore,
      client: simulationClient,
    })
  const [databaseUrl, token, mappingDocument] = await Promise.all([
    dependencies.readSecretFile(config.databaseUrlFile!),
    dependencies.readSecretFile(config.tokenFile!),
    dependencies.readMappingFile(config.mappingFile!),
  ])
  const mapping = parseTwentyRestMapping(mappingDocument)
  const store = await dependencies.createStore(databaseUrl)
  const client = dependencies.createClient({ apiBaseUrl: config.apiBaseUrl!, token, mapping })
  return new CrmSyncDaemon({ ...config, store, client })
}

export async function startCrmSyncProcess(
  environment: Record<string, string | undefined> = process.env,
): Promise<{ close(): Promise<void> }> {
  const runtime = await createDefaultRuntime(environment)
  const config = loadCrmSyncProcessConfig(environment)
  const server = createHealthServer(runtime)
  await listen(server, config.healthPort, config.healthHost)
  runtime.start()
  return {
    close: async () => {
      await closeServer(server)
      await runtime.close()
    },
  }
}

async function createDefaultRuntime(
  environment: Record<string, string | undefined>,
): Promise<CrmSyncDaemon> {
  let pool: Pool | undefined
  return createCrmSyncRuntime(environment, {
    readSecretFile: readOwnerSecretFile,
    readMappingFile: async (path) => {
      const document = await readFile(path, 'utf8')
      if (Buffer.byteLength(document) > 1_048_576) throw new Error('TWENTY_MAPPING_INVALID')
      return document
    },
    createStore: async (databaseUrl) => {
      pool = new Pool({ connectionString: databaseUrl, application_name: 'proptimiza-crm-sync' })
      const store = new PostgresCrmSyncStore(pool) as CrmProcessStorePort
      store.close = async () => { await pool?.end() }
      return store
    },
    createClient: (options) => new TwentyHttpClient(options),
  })
}

function createHealthServer(runtime: CrmSyncDaemon): Server {
  return createServer((request, response) => {
    const health = runtime.health()
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(health.live ? 200 : 503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: health.live ? 'ok' : 'stopped' }))
      return
    }
    if (request.method === 'GET' && request.url === '/readyz') {
      response.writeHead(health.ready ? 200 : 503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: health.ready ? 'ready' : 'not_ready' }))
      return
    }
    response.writeHead(404).end()
  })
}

const simulationStore: CrmProcessStorePort = {
  ready: async () => true, getCursor: async () => ({ value: null, version: 0 }),
  claim: async () => null, complete: async () => undefined,
  markOutcomeUnknown: async () => undefined, storeInbox: async () => false,
  advanceCursor: async (_connector, _stream, version) => version,
  listOutcomeUnknown: async () => [],
}
const simulationClient: TwentyClientPort = {
  apply: async () => { throw new Error('CRM_SIMULATION_DISABLED') },
  readChanges: async () => { throw new Error('CRM_SIMULATION_DISABLED') },
}

function secretPath(value: string | undefined, name: string): string {
  const path = value?.trim()
  if (!path || !path.startsWith('/run/secrets/') || path.includes('..'))
    throw new Error(`${name}_INVALID`)
  return path
}
function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function main(): Promise<void> {
  if (process.argv[2] === 'reconcile') {
    const runtime = await createDefaultRuntime(process.env)
    try {
      const limit = Number(process.env.CRM_RECONCILE_LIMIT ?? '100')
      process.stdout.write(`${JSON.stringify(await runtime.reconcile(limit))}\n`)
    } finally {
      await runtime.close()
    }
    return
  }
  const runtime = await startCrmSyncProcess()
  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    void runtime.close().then(() => process.exit(0), () => process.exit(1))
  }
  process.once('SIGTERM', close)
  process.once('SIGINT', close)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main()
