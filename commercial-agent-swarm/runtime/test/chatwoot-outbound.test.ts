import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import test from 'node:test'
import { MockAgent } from 'undici'
import { ChatwootOutboundClient } from '../src/comms/chatwoot-outbound.js'

const origin = 'http://proptimiza-chatwoot-web-1:3000'
const timestamp = 1_700_000_000
const nonce = '00112233445566778899aabbccddeeff'
const machineSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const machineHeaders = (method: 'GET' | 'POST', path: string, token: string, body = '') => ({
  'x-proptimiza-automation-timestamp': String(timestamp),
  'x-proptimiza-automation-nonce': nonce,
  'x-proptimiza-automation-signature': 'sha256=' + createHmac('sha256', machineSecret)
    .update(`${timestamp}.${nonce}.${method}.${path}.${sha(body)}.${sha(token)}`, 'utf8').digest('hex'),
})
function client(agent: MockAgent) {
  return new ChatwootOutboundClient({ baseUrl: origin, accountId: '1', inboxId: '1',
    readToken: async () => 'reader-token', sendToken: async () => 'sender-token',
    machineSecret: async () => machineSecret, nowSeconds: () => timestamp, nonce: () => nonce, dispatcher: agent })
}

test('builds a bounded transcript and recognizes its own AgentBot replies', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const path = '/api/v1/accounts/1/conversations/25/messages'
  agent.get(origin).intercept({ path, method: 'GET',
    headers: { api_access_token: 'reader-token', accept: 'application/json', 'x-forwarded-proto': 'https',
      ...machineHeaders('GET', path, 'reader-token') }
  }).reply(200, { payload: [
    { id: 40, message_type: 'incoming', private: false, content: 'Hola', sender_type: 'Contact' },
    { id: 41, message_type: 'outgoing', private: false, content: '¿Cómo te ayudamos?', sender_type: 'AgentBot' },
    { id: 42, message_type: 'incoming', private: false, content: 'Necesito automatizar ventas', sender_type: 'Contact' },
  ] })
  const snapshot = await client(agent).snapshot('25', '42', sha('Necesito automatizar ventas'))
  assert.equal(snapshot.current, true)
  assert.equal(snapshot.human_replied, false)
  assert.equal(snapshot.transcript.length, 3)
  assert.deepEqual(Object.keys(snapshot.transcript[0]!).sort(), ['content', 'kind', 'message_id', 'sequence'])
  await agent.close()
})
test('reopens automation on a new customer turn and treats later unsupported activity as newer', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const path = '/api/v1/accounts/1/conversations/25/messages'
  agent.get(origin).intercept({ path, method: 'GET',
    headers: { api_access_token: 'reader-token', accept: 'application/json', 'x-forwarded-proto': 'https',
      ...machineHeaders('GET', path, 'reader-token') }
  }).reply(200, { payload: [
    { id: 40, message_type: 'outgoing', private: false, content: 'Te atiendo personalmente.', sender_type: 'User' },
    { id: 41, message_type: 'incoming', private: false, content: 'Gracias', sender_type: 'Contact' },
    { id: 42, message_type: 'incoming', private: false, content: '', sender_type: 'Contact', content_type: 'image' },
  ] })
  const snapshot = await client(agent).snapshot('25', '41', sha('Gracias'))
  assert.equal(snapshot.current, false)
  assert.equal(snapshot.human_replied, false)
  assert.equal(snapshot.transcript.length, 2)
  await agent.close()
})

test('blocks automation when a human replies after the target customer message', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const path = '/api/v1/accounts/1/conversations/25/messages'
  agent.get(origin).intercept({ path, method: 'GET',
    headers: { api_access_token: 'reader-token', accept: 'application/json', 'x-forwarded-proto': 'https',
      ...machineHeaders('GET', path, 'reader-token') }
  }).reply(200, { payload: [
    { id: 40, message_type: 'incoming', private: false, content: 'Necesito ayuda', sender_type: 'Contact' },
    { id: 41, message_type: 'outgoing', private: false, content: 'Ya lo reviso.', sender_type: 'User' },
  ] })
  const snapshot = await client(agent).snapshot('25', '40', sha('Necesito ayuda'))
  assert.equal(snapshot.current, false)
  assert.equal(snapshot.human_replied, true)
  assert.equal(snapshot.transcript.length, 2)
  await agent.close()
})

test('drops stale transcript segments after a 24 hour silence', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const path = '/api/v1/accounts/1/conversations/25/messages'
  agent.get(origin).intercept({ path, method: 'GET',
    headers: { api_access_token: 'reader-token', accept: 'application/json', 'x-forwarded-proto': 'https',
      ...machineHeaders('GET', path, 'reader-token') }
  }).reply(200, { payload: [
    { id: 40, message_type: 'incoming', private: false, content: 'Venden mallas de seguridad?', sender_type: 'Contact', created_at: 1_700_000_000 },
    { id: 41, message_type: 'outgoing', private: false, content: 'Sí, tenemos mallas.', sender_type: 'AgentBot', created_at: 1_700_000_030 },
    { id: 42, message_type: 'incoming', private: false, content: 'Quiero automatizar mis cotizaciones', sender_type: 'Contact', created_at: 1_700_090_000 },
  ] })
  const snapshot = await client(agent).snapshot('25', '42', sha('Quiero automatizar mis cotizaciones'))
  assert.deepEqual(snapshot.transcript.map((message) => message.message_id), ['42'])
  await agent.close()
})

test('excludes system and unknown senders from the model transcript and human-reply gate', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const path = '/api/v1/accounts/1/conversations/25/messages'
  agent.get(origin).intercept({ path, method: 'GET',
    headers: { api_access_token: 'reader-token', accept: 'application/json', 'x-forwarded-proto': 'https',
      ...machineHeaders('GET', path, 'reader-token') }
  }).reply(200, { payload: [
    { id: 40, message_type: 'incoming', private: false, content: 'Necesito ayuda', sender_type: 'Contact' },
    { id: 41, message_type: 'outgoing', private: false, content: 'Error interno con el bot', sender_type: 'System' },
    { id: 42, message_type: 'outgoing', private: false, content: 'Actividad sin actor', sender_type: null },
  ] })
  const snapshot = await client(agent).snapshot('25', '40', sha('Necesito ayuda'))
  assert.equal(snapshot.current, false)
  assert.equal(snapshot.human_replied, false)
  assert.deepEqual(snapshot.transcript.map((message) => message.message_id), ['40'])
  await agent.close()
})

test('posts one public outgoing message through the account-scoped internal API', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const path = '/api/v1/accounts/1/conversations/25/messages'
  const body = JSON.stringify({ content: 'Respuesta segura.', message_type: 'outgoing', private: false, content_type: 'text' })
  agent.get(origin).intercept({ path, method: 'POST',
    headers: { api_access_token: 'sender-token', accept: 'application/json',
      'content-type': 'application/json', 'x-forwarded-proto': 'https', ...machineHeaders('POST', path, 'sender-token', body) },
    body
  }).reply(200, { id: 91 })
  assert.deepEqual(await client(agent).send('25', 'Respuesta segura.'), { message_id: '91' })
  await agent.close()
})

test('assigns a handoff to the pinned sales team through the signed internal API', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const path = '/api/v1/accounts/1/conversations/25/assignments'
  const body = JSON.stringify({ team_id: 1 })
  agent.get(origin).intercept({ path, method: 'POST',
    headers: { api_access_token: 'reader-token', accept: 'application/json',
      'content-type': 'application/json', 'x-forwarded-proto': 'https', ...machineHeaders('POST', path, 'reader-token', body) },
    body
  }).reply(200, { id: 1, name: 'ventas-proptimiza' })
  assert.deepEqual(await client(agent).assignTeam('25', '1'), { team_id: '1' })
  await agent.close()
})
