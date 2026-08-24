import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ExternalActionBrokerClient } from '../src/external-action-broker-client.js'

const BEARER = 'b'.repeat(64)

describe('external action broker client', () => {
  it('uses one exact internal origin and capability bearer', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new ExternalActionBrokerClient({
      baseUrl: 'http://external-action-broker:8091',
      readBearer: async () => BEARER,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} })
        return new Response(JSON.stringify({ blocked: false }), { status: 200 })
      }) as typeof fetch,
    })
    assert.equal(await client.isBlocked({ mailbox: 'ventas@proptimiza.com', recipient: 'contacto@proptimiza.com' }), false)
    assert.equal(calls[0]?.url, 'http://external-action-broker:8091/internal/v1/mail/block-status')
    assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, `Bearer ${BEARER}`)
  })

  it('validates mail receipts and Telegram acknowledgements', async () => {
    const responses = [
      new Response(JSON.stringify({ receipt_id: `hostinger:${'a'.repeat(64)}` }), { status: 200 }),
      new Response(JSON.stringify({ accepted: true }), { status: 200 }),
    ]
    const client = new ExternalActionBrokerClient({
      baseUrl: 'http://external-action-broker:8091',
      readBearer: async () => BEARER,
      fetch: (async () => responses.shift()!) as typeof fetch,
    })
    assert.deepEqual(await client.sendInternal({
      missionId: '22222222-2222-4222-8222-222222222222',
      mailbox: 'ventas@proptimiza.com', recipient: 'contacto@proptimiza.com',
      subject: 'Prueba', content: 'Interna', idempotencyKey: 'mail:1',
    }), { receipt_id: `hostinger:${'a'.repeat(64)}` })
    await client.postApprovalRequest({
      approval_id: '11111111-1111-4111-8111-111111111111',
      mission_id: '22222222-2222-4222-8222-222222222222', action_hash: 'c'.repeat(64),
    })
  })

  it('rejects alternate origins and never reveals its bearer on transport failure', async () => {
    assert.throws(() => new ExternalActionBrokerClient({
      baseUrl: 'https://external-action-broker:8091', readBearer: async () => BEARER,
    }), /EXTERNAL_ACTION_BROKER_ORIGIN_INVALID/)
    const client = new ExternalActionBrokerClient({
      baseUrl: 'http://external-action-broker:8091',
      readBearer: async () => BEARER,
      fetch: (async () => { throw new Error(BEARER) }) as typeof fetch,
    })
    await assert.rejects(
      () => client.isBlocked({ mailbox: 'ventas@proptimiza.com', recipient: 'contacto@proptimiza.com' }),
      (error: unknown) => { assert.equal((error as Error).message, 'EXTERNAL_ACTION_BROKER_UNAVAILABLE'); return true },
    )
  })
})
