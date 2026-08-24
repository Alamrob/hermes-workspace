import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HostingerMailApiClient } from '../src/hostinger-mail-api.js'

const TOKEN = 'h'.repeat(64)
const action = {
  mailbox: 'ventas@proptimiza.com' as const,
  recipient: 'contacto@proptimiza.com' as const,
  subject: 'Prueba interna controlada',
  content: 'Mensaje interno sin prospectos.',
  idempotencyKey: 'internal-mail:test:1',
}

function account(extra: unknown[] = []) {
  return {
    data: {
      orderResourceId: 'ORabc123',
      mailboxes: [
        { resourceId: 'ACventas123', address: 'ventas@proptimiza.com' },
        { resourceId: 'ACcontacto123', address: 'contacto@proptimiza.com' },
        ...extra,
      ],
    },
  }
}

describe('Hostinger Mail API client', () => {
  it('resolves the exact two-mailbox scope and sends one text-only internal message', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new HostingerMailApiClient({
      readToken: async () => TOKEN,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init: init ?? {} })
        if (url.endsWith('/api/v1/me'))
          return new Response(JSON.stringify(account()), { status: 200, headers: { 'content-type': 'application/json' } })
        return new Response(null, { status: 204 })
      }) as typeof fetch,
    })

    await client.ready()
    const receipt = await client.sendInternal(action)
    assert.match(receipt.receipt_id, /^hostinger:[a-f0-9]{64}$/)
    assert.equal(calls.length, 2)
    assert.equal(calls[1]?.url, 'https://api.mail.hostinger.com/api/v1/mailboxes/ACventas123/send')
    assert.equal(calls[1]?.init.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
      to: ['contacto@proptimiza.com'],
      displayName: 'Equipo Proptimiza',
      subject: action.subject,
      text: action.content,
    })
    assert.equal(String((calls[1]?.init.headers as Record<string, string>).authorization), `Bearer ${TOKEN}`)
  })

  it('rejects a token that exposes any mailbox outside the approved pair', async () => {
    const client = new HostingerMailApiClient({
      readToken: async () => TOKEN,
      fetch: (async () => new Response(JSON.stringify(account([
        { resourceId: 'ACother123', address: 'other@proptimiza.com' },
      ])), { status: 200 })) as typeof fetch,
    })
    await assert.rejects(() => client.sendInternal(action), /HOSTINGER_TOKEN_SCOPE_INVALID/)
  })

  it('rejects recipient, sender, subject and idempotency mutations before network access', async () => {
    let calls = 0
    const client = new HostingerMailApiClient({
      readToken: async () => TOKEN,
      fetch: (async () => { calls += 1; return new Response(null, { status: 204 }) }) as typeof fetch,
    })
    await assert.rejects(() => client.sendInternal({ ...action, recipient: 'prospect@example.com' as never }), /HOSTINGER_ACTION_NOT_ALLOWED/)
    await assert.rejects(() => client.sendInternal({ ...action, mailbox: 'other@proptimiza.com' as never }), /HOSTINGER_ACTION_NOT_ALLOWED/)
    await assert.rejects(() => client.sendInternal({ ...action, subject: 'bad\r\nBcc: target@example.com' }), /HOSTINGER_SUBJECT_INVALID/)
    await assert.rejects(() => client.sendInternal({ ...action, idempotencyKey: 'bad key' }), /HOSTINGER_IDEMPOTENCY_KEY_INVALID/)
    assert.equal(calls, 0)
  })

  it('does not retry an uncertain send and never exposes the token in its error', async () => {
    let calls = 0
    const client = new HostingerMailApiClient({
      readToken: async () => TOKEN,
      fetch: (async (input: string | URL | Request) => {
        calls += 1
        if (String(input).endsWith('/api/v1/me')) return new Response(JSON.stringify(account()), { status: 200 })
        throw new Error(`network ${TOKEN}`)
      }) as typeof fetch,
    })
    await assert.rejects(() => client.sendInternal(action), (error: unknown) => {
      assert.equal((error as Error).message, 'HOSTINGER_DELIVERY_UNCERTAIN')
      return true
    })
    assert.equal(calls, 2)
  })

  it('returns the same deterministic receipt for the same approved action', async () => {
    const client = new HostingerMailApiClient({
      readToken: async () => TOKEN,
      fetch: (async (input: string | URL | Request) => String(input).endsWith('/api/v1/me')
        ? new Response(JSON.stringify(account()), { status: 200 })
        : new Response(null, { status: 204 })) as typeof fetch,
    })
    const first = await client.sendInternal(action)
    const second = await client.sendInternal(action)
    assert.equal(first.receipt_id, second.receipt_id)
  })
})
