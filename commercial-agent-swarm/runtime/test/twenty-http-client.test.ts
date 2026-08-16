import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TwentyHttpClient,
  parseTwentyRestMapping,
} from '../src/twenty-http-client.js'

const mappingDocument = {
  version: 'twenty-proptimiza-v1',
  objects: {
    PilotTarget: object('/rest/pilotTargets', {
      control_ref: 'controlRef',
      company_ref: 'companyRef',
    }),
    companies: object('/rest/companies', { name: 'name' }),
    people: object('/rest/people', { name: 'name' }),
    opportunities: object('/rest/opportunities', { name: 'name' }),
    notes: object('/rest/notes', { body: 'body' }),
  },
}

function object(path: string, fields: Record<string, string>) {
  return {
    path,
    records_field: 'data',
    id_field: 'id',
    updated_at_field: 'updatedAt',
    initial_cursor: '2026-08-16T00:00:00.000Z',
    cursor_query_parameter: 'filter[updatedAt][gt]',
    limit_query_parameter: 'limit',
    sort_query_parameter: 'orderBy',
    sort_query_value: 'updatedAt',
    fields,
  }
}

describe('versioned Twenty REST client', () => {
  it('uses only an explicitly mapped workspace route and closed field mapping', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const client = new TwentyHttpClient({
      apiBaseUrl: 'https://crm.example',
      token: 'twenty-read-write-token',
      mapping: parseTwentyRestMapping(JSON.stringify(mappingDocument)),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} })
        return new Response(
          JSON.stringify({ data: { id: 'company-1', updatedAt: '2026-08-16T12:00:00.000Z' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    assert.deepEqual(
      await client.apply({
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        operation: 'upsert_account',
        payload: { name: 'Acme' },
        sourceVersion: 1,
      }),
      { remoteRecordId: 'company-1', remoteVersion: '2026-08-16T12:00:00.000Z' },
    )
    assert.equal(requests[0]?.url, 'https://crm.example/rest/companies')
    assert.equal(requests[0]?.init.method, 'POST')
    assert.equal((requests[0]?.init.headers as Record<string, string>)['idempotency-key'], '11111111-1111-4111-8111-111111111111')
    assert.equal(requests[0]?.init.body, JSON.stringify({ name: 'Acme' }))
  })

  it('polls updatedAt only through configured query names and returns a closed page', async () => {
    let requested = ''
    const client = new TwentyHttpClient({
      apiBaseUrl: 'https://crm.example',
      token: 'twenty-token',
      mapping: parseTwentyRestMapping(JSON.stringify(mappingDocument)),
      fetch: async (url) => {
        requested = String(url)
        return new Response(
          JSON.stringify({ data: [{ id: 'company-1', updatedAt: '2026-08-16T12:00:00.000Z', name: 'Acme' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    const page = await client.readChanges({
      stream: 'accounts',
      cursor: '2026-08-16T11:00:00.000Z',
      limit: 10,
    })
    const url = new URL(requested)
    assert.equal(url.pathname, '/rest/companies')
    assert.equal(url.searchParams.get('filter[updatedAt][gt]'), '2026-08-16T11:00:00.000Z')
    assert.equal(url.searchParams.get('limit'), '10')
    assert.equal(url.searchParams.get('orderBy'), 'updatedAt')
    assert.equal(page.nextCursor, '2026-08-16T12:00:00.000Z')
    assert.equal(page.events[0]?.recordType, 'account')
  })

  it('fails closed on missing mappings, generic routes, unknown response fields, or oversized bodies', async () => {
    assert.throws(
      () => parseTwentyRestMapping(JSON.stringify({ version: 'v1', objects: {} })),
      /TWENTY_MAPPING_INVALID/,
    )
    assert.throws(
      () => parseTwentyRestMapping(JSON.stringify({
        ...mappingDocument,
        objects: { ...mappingDocument.objects, companies: object('/changes', { name: 'name' }) },
      })),
      /TWENTY_MAPPING_INVALID/,
    )
    for (const body of [
      JSON.stringify({ data: { id: 'x', updatedAt: '2026-08-16T12:00:00Z', secret: true } }),
      'x'.repeat(1_048_577),
    ]) {
      const client = new TwentyHttpClient({
        apiBaseUrl: 'https://crm.example', token: 'token',
        mapping: parseTwentyRestMapping(JSON.stringify(mappingDocument)),
        fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      })
      await assert.rejects(
        client.apply({ idempotencyKey: 'idempotency', operation: 'upsert_account', payload: { name: 'Acme' }, sourceVersion: 1 }),
        /TWENTY_(?:RESPONSE|BODY)_INVALID/,
      )
    }
  })
})
