import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CRM_SYNC_SERVICE_GID,
  assertCrmSyncServiceIdentity,
  CrmSyncDaemon,
  createHealthServer,
  createCrmSyncRuntime,
  loadCrmSyncProcessConfig,
} from '../src/crm-sync-main.js'
import type { CrmProcessStorePort } from '../src/crm-sync-main.js'
import type { TwentyClientPort } from '../src/crm-sync.js'

function processStore(): CrmProcessStorePort {
  return {
    ready: async () => true,
    getCursor: async () => ({ value: null, version: 0 }),
    claim: async () => null,
    complete: async () => undefined,
    markOutcomeUnknown: async () => undefined,
    storeInbox: async () => false,
    advanceCursor: async (_connector, _stream, version) => version + 1,
    listOutcomeUnknown: async () => [{ outboxId: 'outbox-1', errorCode: 'TWENTY_OUTCOME_UNKNOWN' }],
    summary: async () => ({
      availability: 'available', accounts: 0, contacts: 0, opportunities: 0,
      pipelineUsd: null,
      provenance: { source: 'twenty', sourceId: 'crm-summary:postgres', observedAt: '2026-08-16T12:00:00.000Z', synthetic: false },
    }),
  }
}

function client(calls: string[]): TwentyClientPort {
  return {
    apply: async () => {
      calls.push('outbound')
      return { remoteRecordId: 'remote', remoteVersion: 'v1' }
    },
    readChanges: async ({ stream }) => {
      calls.push(`inbound:${stream}`)
      return { events: [], nextCursor: '2026-08-16T00:00:00.000Z' }
    },
  }
}

describe('CRM sync deployable process', () => {
  it('binds every file-backed CRM secret to the fixed crm-sync group', () => {
    const config = loadCrmSyncProcessConfig({
      NODE_ENV: 'production', CRM_SYNC_MODE: 'simulation',
      CRM_HEALTH_HOST: '127.0.0.1', CRM_HEALTH_PORT: '8081',
    })
    assert.equal(config.secretGid, CRM_SYNC_SERVICE_GID)
    assert.equal(config.secretGid, 10011)
    assert.doesNotThrow(() => assertCrmSyncServiceIdentity(10011))
    assert.throws(() => assertCrmSyncServiceIdentity(10000), /SERVICE_PRIMARY_GID_INVALID/)
    assert.throws(() => assertCrmSyncServiceIdentity(10001), /SERVICE_PRIMARY_GID_INVALID/)
  })

  it('constructs simulation without reading a token, mapping, database, or client', async () => {
    const touched: string[] = []
    const runtime = await createCrmSyncRuntime(
      { NODE_ENV: 'production', CRM_SYNC_MODE: 'simulation', CRM_HEALTH_HOST: '127.0.0.1', CRM_HEALTH_PORT: '8081' },
      {
        readSecretFile: async () => { touched.push('secret'); return 'never' },
        readMappingFile: async () => { touched.push('mapping'); return 'never' },
        createStore: async () => { touched.push('database'); return processStore() },
        createClient: () => { touched.push('client'); return client([]) },
      },
    )
    assert.deepEqual(await runtime.runCycle(), { status: 'disabled' })
    assert.deepEqual(touched, [])
    assert.deepEqual(runtime.health(), { live: true, ready: true, mode: 'simulation' })
  })

  it('runs shadow inbound only and active adds one outbox attempt on the fixed 60s cadence', async () => {
    for (const mode of ['shadow', 'active'] as const) {
      const calls: string[] = []
      const store = processStore()
      if (mode === 'active')
        store.claim = async () => ({
          outboxId: '11111111-1111-4111-8111-111111111111',
          connectorId: 'twenty', operation: 'upsert_account',
          payload: { name: 'Acme' }, sourceVersion: 1,
        })
      const daemon = new CrmSyncDaemon({
        mode, workerId: 'crm-worker-1', leaseSeconds: 60,
        pollIntervalMs: 60_000, store, client: client(calls),
      })
      assert.deepEqual(await daemon.runCycle(), { status: 'ok' })
      assert.equal(calls.filter((call) => call.startsWith('inbound:')).length, 5)
      assert.equal(calls.includes('outbound'), mode === 'active')
      assert.equal(daemon.nextDelayMs(), 60_000)
      assert.deepEqual(await daemon.reconcile(10), [{ outboxId: 'outbox-1', errorCode: 'TWENTY_OUTCOME_UNKNOWN' }])
    }
  })

  it('limits shadow ingestion to the exact configured pilot stream', async () => {
    const config = loadCrmSyncProcessConfig({
      NODE_ENV: 'production', CRM_SYNC_MODE: 'shadow', CRM_SYNC_STREAMS: 'pilot_targets',
      CRM_HEALTH_HOST: '0.0.0.0', CRM_HEALTH_PORT: '8081',
      CRM_DATABASE_URL_FILE: '/run/secrets/crm-db',
      TWENTY_API_TOKEN_FILE: '/run/secrets/twenty-token',
      TWENTY_MAPPING_FILE: '/run/config/twenty-mapping.json',
      TWENTY_API_ALLOWED_HOST: 'twenty-server:3000',
      TWENTY_API_BASE_URL: 'http://twenty-server:3000',
    })
    const calls: string[] = []
    const daemon = new CrmSyncDaemon({
      mode: 'shadow', streams: config.streams, workerId: 'crm-worker-1', leaseSeconds: 60,
      pollIntervalMs: 60_000, store: processStore(), client: client(calls),
    })
    assert.deepEqual(await daemon.runCycle(), { status: 'ok' })
    assert.deepEqual(calls, ['inbound:pilot_targets'])
    for (const value of ['', 'pilot_targets,pilot_targets', 'companies,unknown', ' companies'])
      assert.throws(
        () => loadCrmSyncProcessConfig({
          NODE_ENV: 'production', CRM_SYNC_MODE: 'simulation', CRM_SYNC_STREAMS: value,
          CRM_HEALTH_HOST: '127.0.0.1', CRM_HEALTH_PORT: '8081',
        }),
        /CRM_SYNC_STREAMS_INVALID/,
      )
  })

  it('fails configuration closed and applies bounded backoff/readiness after a cycle error', async () => {
    assert.throws(
      () => loadCrmSyncProcessConfig({ NODE_ENV: 'production', CRM_SYNC_MODE: 'pull-only' }),
      /CRM_SYNC_MODE_INVALID/,
    )
    const daemon = new CrmSyncDaemon({
      mode: 'shadow', workerId: 'worker', leaseSeconds: 60,
      pollIntervalMs: 60_000,
      store: { ...processStore(), getCursor: async () => { throw new Error('db secret detail') } },
      client: client([]),
    })
    await assert.rejects(daemon.runCycle(), /CRM_SYNC_CYCLE_FAILED/)
    assert.deepEqual(daemon.health(), { live: true, ready: false, mode: 'shadow' })
    assert.equal(daemon.nextDelayMs(), 120_000)
  })

  it('returns an explicit disabled CRM summary in simulation and the store summary otherwise', async () => {
    const simulation = new CrmSyncDaemon({
      mode: 'simulation', workerId: 'worker', leaseSeconds: 60,
      pollIntervalMs: 60_000, store: processStore(), client: client([]),
    })
    const disabled = await simulation.summary()
    assert.deepEqual({ ...disabled, provenance: { ...disabled.provenance, observedAt: 'TIME' } }, {
      availability: 'unavailable', accounts: null, contacts: null,
      opportunities: null, pipelineUsd: null, message: 'CRM sync disabled',
      provenance: { source: 'twenty', sourceId: 'crm:simulation-disabled', observedAt: 'TIME', synthetic: false },
    })
    assert.equal(Number.isFinite(Date.parse(disabled.provenance.observedAt)), true)
    const shadow = new CrmSyncDaemon({
      mode: 'shadow', workerId: 'worker', leaseSeconds: 60,
      pollIntervalMs: 60_000, store: processStore(), client: client([]),
    })
    assert.deepEqual(await shadow.summary(), {
      availability: 'available', accounts: 0, contacts: 0, opportunities: 0,
      pipelineUsd: null,
      provenance: { source: 'twenty', sourceId: 'crm-summary:postgres', observedAt: '2026-08-16T12:00:00.000Z', synthetic: false },
    })
  })

  it('serves CRM summary only on the exact internal GET route with its bearer', async () => {
    const runtime = new CrmSyncDaemon({
      mode: 'simulation', workerId: 'worker', leaseSeconds: 60,
      pollIntervalMs: 60_000, store: processStore(), client: client([]),
    })
    const server = createHealthServer(runtime, 'crm-read-model-token')
    await new Promise<void>((resolve, reject) =>
      server.once('error', reject).listen(0, '127.0.0.1', resolve),
    )
    try {
      const address = server.address()
      assert(address && typeof address === 'object')
      const url = `http://127.0.0.1:${address.port}/internal/v1/read-model/crm-summary`
      assert.equal((await fetch(url)).status, 401)
      const response = await fetch(url, {
        headers: { authorization: 'Bearer crm-read-model-token' },
      })
      assert.equal(response.status, 200)
      assert.equal((await response.json() as any).provenance.sourceId, 'crm:simulation-disabled')
      assert.equal((await fetch(`${url}/extra`, {
        headers: { authorization: 'Bearer crm-read-model-token' },
      })).status, 404)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('accepts the exact allowlisted internal Twenty origin and rejects internal SSRF variants', () => {
    const base = {
      NODE_ENV: 'production', CRM_SYNC_MODE: 'shadow',
      CRM_HEALTH_HOST: '0.0.0.0', CRM_HEALTH_PORT: '8081',
      CRM_DATABASE_URL_FILE: '/run/secrets/crm-db',
      TWENTY_API_TOKEN_FILE: '/run/secrets/twenty-token',
      TWENTY_MAPPING_FILE: '/run/config/twenty-mapping.json',
      TWENTY_API_ALLOWED_HOST: 'twenty-server:3000',
    }
    assert.equal(loadCrmSyncProcessConfig({
      ...base, TWENTY_API_BASE_URL: 'http://twenty-server:3000',
    }).allowedHttpHost, 'twenty-server:3000')
    for (const value of ['/run/secrets/twenty-mapping', '/run/config/../secrets/mapping', 'relative.json'])
      assert.throws(
        () => loadCrmSyncProcessConfig({ ...base, TWENTY_API_BASE_URL: 'http://twenty-server:3000', TWENTY_MAPPING_FILE: value }),
        /TWENTY_MAPPING_FILE_INVALID/,
      )
    for (const value of ['http://127.0.0.1:3000', 'http://169.254.169.254', 'http://twenty-server:3001'])
      assert.throws(
        () => loadCrmSyncProcessConfig({ ...base, TWENTY_API_BASE_URL: value }),
        /TWENTY_API_BASE_URL_INVALID/,
      )
  })
})
