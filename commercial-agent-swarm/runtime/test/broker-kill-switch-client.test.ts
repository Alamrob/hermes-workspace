import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BrokerKillSwitchClient } from '../src/broker-kill-switch-client.js'

const BEARER = 's'.repeat(64)

describe('broker kill-switch client', () => {
  it('queries only the exact internal safety endpoint', async () => {
    const calls: Array<{ url: string; body: unknown; authorization: string }> = []
    const client = new BrokerKillSwitchClient({
      readBearer: async () => BEARER,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input), body: JSON.parse(String(init?.body)),
          authorization: (init?.headers as Record<string, string>).authorization,
        })
        return new Response(JSON.stringify({ active: true }), { status: 200 })
      }) as typeof fetch,
    })
    assert.equal(await client.isActive({
      missionId: '11111111-1111-4111-8111-111111111111', channel: 'email',
    }), true)
    assert.deepEqual(calls, [{
      url: 'http://broker:8080/internal/v1/safety/kill-switch',
      body: { mission_id: '11111111-1111-4111-8111-111111111111', channel: 'email' },
      authorization: `Bearer ${BEARER}`,
    }])
  })

  it('fails closed without leaking its bearer', async () => {
    const client = new BrokerKillSwitchClient({
      readBearer: async () => BEARER,
      fetch: (async () => { throw new Error(BEARER) }) as typeof fetch,
    })
    await assert.rejects(() => client.isActive({ missionId: '*', channel: 'telegram' }), (error: unknown) => {
      assert.equal((error as Error).message, 'BROKER_SAFETY_UNAVAILABLE')
      return true
    })
  })
})
