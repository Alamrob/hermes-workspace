import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, request, type OutgoingHttpHeaders } from 'node:http'
import test from 'node:test'
import { createPlatformAdmission } from '../src/platform/admission.js'
import { createChatwootWebhookAdapter } from '../src/comms/chatwoot-webhook.js'
import { createChatwootIngressHandler, type ChatwootIngressRoute } from '../src/comms/chatwoot-http.js'

const now = new Date('2026-09-11T12:00:00Z')
const at = String(now.getTime() / 1000)
const path = '/webhooks/chatwoot/synthetic'
function fixture() {
  const config = JSON.parse(readFileSync(new URL('../../config/platform/synthetic-tenants.json', import.meta.url), 'utf8'))
  config.bindings = [config.bindings[0]]
  const binding = config.bindings[0]
  binding.account_id = '7'; binding.inbox_id = '9'
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const admission = createPlatformAdmission(config, { resolveKey: ref => ({ ...ref, public_key_pem: publicKey }) })
  const secret = randomBytes(32)
  const adapter = createChatwootWebhookAdapter({ admission, webhookSecret: secret, now: () => now,
    source: { deployment_id: binding.deployment_id, connector_id: binding.connector_id, account_id: '7', inbox_id: '9', principal_id: binding.principals[0].principal_id } })
  const raw = Buffer.from(JSON.stringify({ event: 'message_created', id: 41, account: { id: 7 }, inbox: { id: 9 },
    conversation: { id: 25, inbox_id: 9, account: { id: 7 } }, message_type: 'incoming', private: false,
    content_type: 'text', content: 'Consulta sintética', created_at: '2026-09-11T11:59:30Z' }))
  const headers = { 'content-type': 'application/json', 'x-chatwoot-timestamp': at,
    'x-chatwoot-signature': 'sha256=' + createHmac('sha256', secret).update(at).update('.').update(raw).digest('hex') }
  return { adapter, raw, headers, secret }
}
async function withServer(run: (port: number, input: ReturnType<typeof fixture>) => Promise<void>, commit: ChatwootIngressRoute['commit'], options = {}) {
  const input = fixture()
  const handler = createChatwootIngressHandler([{ path, adapter: input.adapter, commit }], options)
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try { await run(address.port, input) }
  finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())) }
}
function post(port: number, raw: Buffer, headers: OutgoingHttpHeaders, target = path, method = 'POST') {
  return new Promise<{ status: number; body: Record<string, string> }>((ok, no) => {
    const req = request({ hostname: '127.0.0.1', port, path: target, method, headers }, res => {
      const parts: Buffer[] = []
      res.on('data', part => parts.push(part))
      res.on('end', () => { try { ok({ status: res.statusCode!, body: JSON.parse(Buffer.concat(parts).toString()) }) } catch (error) { no(error) } })
      res.on('error', no)
    })
    req.on('error', no)
    req.end(raw)
  })
}

test('real local HTTP awaits commit receipt before acknowledgement', async () => {
  let enter!: () => void; const entered = new Promise<void>(ok => { enter = ok })
  let release!: () => void; const gate = new Promise<void>(ok => { release = ok })
  await withServer(async (port, input) => {
    let returned = false
    const pending = post(port, input.raw, input.headers).then(value => { returned = true; return value })
    try {
      await entered
      assert.equal(returned, false)
      release()
      const response = await pending
      assert.equal(response.status, 202)
      assert.equal(response.body.outcome, 'inserted')
      assert.match(response.body.event_id!, /^cw1_[a-f0-9]{64}$/)
    } finally { release() }
  }, async (context, event) => { assert.equal(context.tenant_id, event.tenant_id); enter(); await gate; return { event_id: event.event_id, outcome: 'inserted' } })
})
test('HTTP preserves raw bytes and reports a duplicate only from the commit port', async () => {
  const seen = new Set<string>() // Protocol double only; PostgreSQL dedup is verified separately.
  await withServer(async (port, input) => {
    const first = await post(port, input.raw, input.headers)
    const retry = await post(port, input.raw, input.headers)
    assert.equal(first.status, 202); assert.equal(retry.status, 200)
    assert.equal(first.body.event_id, retry.body.event_id)
    assert.equal(retry.body.outcome, 'duplicate')
    assert.equal((await post(port, Buffer.concat([input.raw, Buffer.from(' ')]), input.headers)).status, 401)
  }, async (_, event) => { const outcome = seen.has(event.event_id) ? 'duplicate' : 'inserted'; seen.add(event.event_id); return { event_id: event.event_id, outcome } })
})

test('commit failure and mismatched receipt never emit successful acknowledgement or internal details', async () => {
  for (const commit of [async () => { throw new Error('private database diagnostic') },
    async () => ({ event_id: 'wrong-event', outcome: 'inserted' as const })]) {
    await withServer(async (port, input) => {
      const response = await post(port, input.raw, input.headers)
      assert.equal(response.status, 503)
      assert.deepEqual(response.body, { error: 'temporarily_unavailable' })
    }, commit)
  }
})

test('duplicate auth headers, unsupported encoding and unassigned paths do not reach persistence', async () => {
  let calls = 0
  await withServer(async (port, input) => {
    const duplicated: OutgoingHttpHeaders = { ...input.headers, 'x-chatwoot-signature': [input.headers['x-chatwoot-signature'], input.headers['x-chatwoot-signature']] }
    assert.equal((await post(port, input.raw, duplicated)).status, 400)
    assert.equal((await post(port, input.raw, { ...input.headers, 'content-encoding': 'gzip' })).status, 415)
    assert.equal((await post(port, input.raw, { ...input.headers, 'content-type': 'text/plain' })).status, 415)
    assert.equal((await post(port, input.raw, input.headers, path + '?tenant_id=mallaguardian')).status, 404)
    assert.equal((await post(port, input.raw, input.headers, path, 'PUT')).status, 405)
    assert.equal(calls, 0)
  }, async (_, event) => { calls++; return { event_id: event.event_id, outcome: 'inserted' } })
})

test('streaming and declared oversize requests are bounded before persistence', async () => {
  let calls = 0
  await withServer(async (port, input) => {
    assert.equal((await post(port, Buffer.alloc(1025, 32), { ...input.headers, 'transfer-encoding': 'chunked' })).status, 413)
    assert.equal((await post(port, Buffer.alloc(1025, 32), { ...input.headers, 'content-length': '1025' })).status, 413)
    assert.equal(calls, 0)
  }, async (_, event) => { calls++; return { event_id: event.event_id, outcome: 'inserted' } }, { maxBodyBytes: 1024 })
})

test('production bot acknowledges authenticated non-incoming events without persistence or retries', async () => {
  let calls = 0
  await withServer(async (port, input) => {
    const body = JSON.parse(input.raw.toString())
    body.message_type = 'outgoing'
    const raw = Buffer.from(JSON.stringify(body))
    const headers = { ...input.headers,
      'x-chatwoot-signature': 'sha256=' + createHmac('sha256', input.secret).update(at).update('.').update(raw).digest('hex') }
    const response = await post(port, raw, headers)
    assert.equal(response.status, 200)
    assert.equal(response.body.outcome, 'ignored')
    assert.equal(calls, 0)
  }, async (_, event) => { calls++; return { event_id: event.event_id, outcome: 'inserted' } },
  { acknowledgeUnsupportedEvents: true })
})

test('unfinished body times out and releases the request without calling persistence', async () => {
  let calls = 0
  await withServer(async (port, input) => {
    const status = await new Promise<number>((ok, no) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: input.headers }, res => {
        res.resume(); res.on('end', () => { ok(res.statusCode!); req.destroy() })
      })
      req.on('error', no); req.write('{')
    })
    assert.equal(status, 408)
    assert.equal(calls, 0)
  }, async (_, event) => { calls++; return { event_id: event.event_id, outcome: 'inserted' } }, { bodyTimeoutMs: 30 })
})


test('aborted body cannot crash ingress or reach persistence; the next request still succeeds', async () => {
  const input = fixture()
  let calls = 0
  let entered!: () => void; const arrival = new Promise<void>(ok => { entered = ok })
  let closed!: () => void; const closure = new Promise<void>(ok => { closed = ok })
  const handler = createChatwootIngressHandler([{ path, adapter: input.adapter, commit: async (_, event) => {
    calls++; return { event_id: event.event_id, outcome: 'inserted' }
  } }])
  const server = createServer((req, res) => { req.once('close', closed); entered(); void handler(req, res) })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  try {
    const req = request({ hostname: '127.0.0.1', port: address.port, path, method: 'POST', headers: input.headers })
    req.on('error', () => {}); req.write('{')
    await arrival; req.destroy(); await closure
    assert.equal(calls, 0)
    assert.equal((await post(address.port, input.raw, input.headers)).status, 202)
    assert.equal(calls, 1)
  } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())) }
})
