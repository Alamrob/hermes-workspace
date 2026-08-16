import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  runCrmSyncOnce,
  syncTwentyInboundOnce,
  TwentyOutcomeUnknownError,
  loadTwentyClientConfig,
  type CrmOutboxItem,
  type CrmSyncStorePort,
  type TwentyClientPort,
} from '../src/crm-sync.js'

const item: CrmOutboxItem = {
  outboxId: '11111111-1111-4111-8111-111111111111',
  connectorId: 'twenty',
  operation: 'upsert_account',
  payload: { name: 'Company 0' },
  sourceVersion: 1,
}

function store(overrides: Partial<CrmSyncStorePort> = {}): CrmSyncStorePort {
  return {
    claim: async () => item,
    complete: async () => undefined,
    markOutcomeUnknown: async () => undefined,
    storeInbox: async () => true,
    advanceCursor: async () => 1,
    ...overrides,
  }
}

describe('deterministic Twenty CRM sync', () => {
  it('accepts only a file-backed Twenty token and rejects inherited Hermes credentials', () => {
    assert.deepEqual(
      loadTwentyClientConfig({
        NODE_ENV: 'production',
        CRM_SYNC_MODE: 'simulation',
        TWENTY_API_BASE_URL: 'https://crm.invalid',
        TWENTY_API_TOKEN_FILE: '/run/secrets/twenty-api-token',
      }),
      {
        apiBaseUrl: 'https://crm.invalid',
        tokenFile: '/run/secrets/twenty-api-token',
      },
    )
    for (const name of [
      'TWENTY_API_TOKEN',
      'CUSTOM_API_KEY',
      'OPENAI_API_KEY',
      'HERMES_API_KEY',
    ])
      assert.throws(
        () =>
          loadTwentyClientConfig({
            NODE_ENV: 'production',
            CRM_SYNC_MODE: 'simulation',
            TWENTY_API_BASE_URL: 'https://crm.invalid',
            TWENTY_API_TOKEN_FILE: '/run/secrets/twenty-api-token',
            [name]: 'forbidden',
          }),
        /CRM_SYNC_CREDENTIAL_BOUNDARY_INVALID/,
      )
  })

  it('claims one durable item and binds the remote write to its outbox id', async () => {
    const completed: unknown[] = []
    const calls: unknown[] = []
    const client: TwentyClientPort = {
      apply: async (request) => {
        calls.push(request)
        return { remoteRecordId: 'remote-1', remoteVersion: 'v1' }
      },
      readChanges: async () => ({ events: [], nextCursor: 'cursor-1' }),
    }
    const result = await runCrmSyncOnce({
      workerId: 'worker-1',
      leaseSeconds: 60,
      store: store({ complete: async (...args) => void completed.push(args) }),
      client,
    })
    assert.deepEqual(result, { status: 'confirmed', outboxId: item.outboxId })
    assert.deepEqual(calls, [
      {
        idempotencyKey: item.outboxId,
        operation: 'upsert_account',
        payload: { name: 'Company 0' },
        sourceVersion: 1,
      },
    ])
    assert.deepEqual(completed, [[item.outboxId, 'worker-1', 'remote-1', 'v1']])
  })

  it('does not touch Twenty when the durable queue is empty', async () => {
    let calls = 0
    const result = await runCrmSyncOnce({
      workerId: 'worker-1',
      leaseSeconds: 60,
      store: store({ claim: async () => null }),
      client: {
        apply: async () => {
          calls += 1
          throw new Error('unexpected')
        },
        readChanges: async () => ({ events: [], nextCursor: 'cursor-1' }),
      },
    })
    assert.deepEqual(result, { status: 'idle' })
    assert.equal(calls, 0)
  })

  it('records an uncertain external outcome instead of retrying it', async () => {
    const uncertain: unknown[] = []
    await assert.rejects(
      runCrmSyncOnce({
        workerId: 'worker-1',
        leaseSeconds: 60,
        store: store({
          markOutcomeUnknown: async (...args) => void uncertain.push(args),
        }),
        client: {
          apply: async () => {
            throw new TwentyOutcomeUnknownError('timeout after request body')
          },
          readChanges: async () => ({ events: [], nextCursor: 'cursor-1' }),
        },
      }),
      /TWENTY_OUTCOME_UNKNOWN/,
    )
    assert.deepEqual(uncertain, [
      [item.outboxId, 'worker-1', 'TWENTY_OUTCOME_UNKNOWN'],
    ])
  })

  it('stores at most ten closed inbound events before advancing a CAS cursor', async () => {
    const events: unknown[] = []
    const cursors: unknown[] = []
    const result = await syncTwentyInboundOnce({
      stream: 'accounts',
      cursor: { value: 'cursor-0', version: 3 },
      store: store({
        storeInbox: async (event) => {
          events.push(event)
          return true
        },
        advanceCursor: async (...args) => {
          cursors.push(args)
          return 4
        },
      }),
      client: {
        apply: async () => ({ remoteRecordId: 'unused', remoteVersion: 'v0' }),
        readChanges: async (request) => {
          assert.deepEqual(request, {
            stream: 'accounts',
            cursor: 'cursor-0',
            limit: 10,
          })
          return {
            events: [
              {
                remoteEventId: 'event-1',
                recordType: 'account',
                remoteRecordId: 'remote-1',
                remoteVersion: 'v1',
                payload: { id: 'remote-1' },
              },
            ],
            nextCursor: 'cursor-1',
          }
        },
      },
    })
    assert.equal(events.length, 1)
    assert.deepEqual(cursors, [['twenty', 'accounts', 3, 'cursor-1']])
    assert.deepEqual(result, { stored: 1, cursorVersion: 4 })
  })

  it('fails closed on an oversized or malformed inbound page', async () => {
    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      remoteEventId: `event-${index}`,
      recordType: 'account' as const,
      remoteRecordId: `remote-${index}`,
      remoteVersion: 'v1',
      payload: {},
    }))
    await assert.rejects(
      syncTwentyInboundOnce({
        stream: 'accounts',
        cursor: { value: null, version: 0 },
        store: store(),
        client: {
          apply: async () => ({ remoteRecordId: 'unused', remoteVersion: 'v0' }),
          readChanges: async () => ({ events: tooMany, nextCursor: 'cursor-1' }),
        },
      }),
      /INVALID_TWENTY_CHANGE_PAGE/,
    )
  })
})
