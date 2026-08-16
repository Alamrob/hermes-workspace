import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PostgresCrmSyncStore } from '../src/postgres-crm-sync-store.js'

describe('PostgreSQL CRM sync capability adapter', () => {
  it('maps a claimed database row into the closed Twenty outbox contract', async () => {
    const queries: unknown[] = []
    const store = new PostgresCrmSyncStore({
      query: async (sql, values) => {
        queries.push([sql, values])
        return {
          rows: [
            {
              outbox_id: '11111111-1111-4111-8111-111111111111',
              connector_id: 'twenty',
              operation: 'upsert_account',
              payload: { name: 'Company 0' },
              source_version: '1',
            },
          ],
        }
      },
    })
    assert.deepEqual(await store.claim('worker-1', 60), {
      outboxId: '11111111-1111-4111-8111-111111111111',
      connectorId: 'twenty',
      operation: 'upsert_account',
      payload: { name: 'Company 0' },
      sourceVersion: 1,
    })
    assert.match(String((queries[0] as unknown[])[0]), /claim_crm_outbox/)
  })

  it('uses only narrow CRM capability functions for writes and cursor CAS', async () => {
    const queries: string[] = []
    const store = new PostgresCrmSyncStore({
      query: async (sql) => {
        queries.push(sql)
        if (sql.includes('complete_crm_outbox')) return { rows: [{ completed: true }] }
        if (sql.includes('store_crm_inbox')) return { rows: [{ inserted: true }] }
        if (sql.includes('advance_crm_cursor')) return { rows: [{ version: '4' }] }
        if (sql.includes('get_crm_cursor')) return { rows: [{ cursor_value: 'cursor-3', cursor_version: '3' }] }
        if (sql.includes('crm_sync_ready')) return { rows: [{ ready: true }] }
        if (sql.includes('list_crm_outcome_unknown')) return { rows: [{ outbox_id: 'outbox', error_code: 'TWENTY_OUTCOME_UNKNOWN' }] }
        return { rows: [{ recorded: true }] }
      },
    })
    await store.complete('outbox', 'worker', 'remote', 'v1')
    await store.markOutcomeUnknown('outbox', 'worker', 'TWENTY_OUTCOME_UNKNOWN')
    assert.equal(
      await store.storeInbox({
        remoteEventId: 'event',
        recordType: 'account',
        remoteRecordId: 'remote',
        remoteVersion: 'v1',
        payload: {},
      }),
      true,
    )
    assert.equal(await store.advanceCursor('twenty', 'accounts', 3, 'next'), 4)
    assert.deepEqual(await store.getCursor('twenty', 'accounts'), {
      value: 'cursor-3', version: 3,
    })
    assert.equal(await store.ready(), true)
    assert.deepEqual(await store.listOutcomeUnknown(10), [
      { outboxId: 'outbox', errorCode: 'TWENTY_OUTCOME_UNKNOWN' },
    ])
    assert.equal(
      queries.every(
        (sql) =>
          sql.includes('integration.') &&
          !/\bFROM integration\.(?:crm_outbox|crm_inbox|crm_sync_cursors)\b/.test(
            sql,
          ),
      ),
      true,
    )
  })
})
