import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import test from 'node:test'
import { MockAgent } from 'undici'
import {
  ChatwootReadClient,
  ChatwootReviewClient,
  chatwootOwnedLabelsSha256,
  type ChatwootOwnedOperationalLabel,
} from '../src/comms/chatwoot-outbound.js'

const origin = 'http://proptimiza-chatwoot-web-1:3000'
const timestamp = 1_700_000_000
const nonce = 'ffeeddccbbaa99887766554433221100'
const secret = 'review-secret-0123456789abcdef0123456789abcdef0123456789abcdef'
const token = 'review-token-012345678901234567890123'
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const headers = (method: 'GET' | 'POST', path: string, body = '') => ({
  api_access_token: token,
  accept: 'application/json',
  'x-forwarded-proto': 'https',
  'x-proptimiza-automation-role': 'reviewer',
  'x-proptimiza-automation-timestamp': String(timestamp),
  'x-proptimiza-automation-nonce': nonce,
  'x-proptimiza-automation-signature': 'sha256=' + createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${method}.${path}.${sha(body)}.${sha(token)}`, 'utf8').digest('hex'),
})
const options = (agent: MockAgent) => ({
  baseUrl: origin,
  accountId: '1',
  inboxId: '1',
  readToken: async () => token,
  machineSecret: async () => secret,
  nowSeconds: () => timestamp,
  nonce: () => nonce,
  dispatcher: agent,
})

test('read-only client exposes no mutation methods', () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const client = new ChatwootReadClient(options(agent))
  assert.equal('send' in client, false)
  assert.equal('createPrivateNote' in client, false)
  assert.equal('assignTeam' in client, false)
  assert.equal('ownedLabelState' in client, false)
  assert.equal('mergeOwnedLabels' in client, false)
  return agent.close()
})

test('review client reads with the isolated reviewer role', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const path = '/api/v1/accounts/1/conversations/25/messages'
  const content = 'Necesito orientación.'
  agent.get(origin).intercept({ path, method: 'GET', headers: headers('GET', path) }).reply(200, { payload: [
    { id: 42, message_type: 'incoming', private: false, content, sender_type: 'Contact' },
  ] })
  const value = await new ChatwootReviewClient(options(agent)).snapshot('25', '42', sha(content))
  assert.equal(value.current, true)
  await agent.close()
})

test('review client can create only a private note, not a public send', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const path = '/api/v1/accounts/1/conversations/25/messages'
  const body = JSON.stringify({ content: 'Revisión humana pendiente.', message_type: 'outgoing', private: true, content_type: 'text' })
  agent.get(origin).intercept({ path, method: 'POST', headers: {
    ...headers('POST', path, body), 'content-type': 'application/json',
  }, body }).reply(200, { id: 91 })
  const client = new ChatwootReviewClient(options(agent))
  assert.equal('send' in client, false)
  assert.deepEqual(await client.createPrivateNote('25', 'Revisión humana pendiente.'), { message_id: '91' })
  await agent.close()
})

test('review assignment is exact and fails closed on a mismatched team', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const path = '/api/v1/accounts/1/conversations/25/assignments'
  const body = JSON.stringify({ team_id: 1 })
  agent.get(origin).intercept({ path, method: 'POST', headers: {
    ...headers('POST', path, body), 'content-type': 'application/json',
  }, body }).reply(200, { id: 2 })
  await assert.rejects(() => new ChatwootReviewClient(options(agent)).assignTeam('25', '1'), /CHATWOOT_TEAM_ASSIGNMENT_INVALID/)
  await agent.close()
})

test('review client reads only the owned-label digest and applies an exact compare-and-merge delta', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const path = '/api/v1/accounts/1/conversations/25/labels'
  const initial = chatwootOwnedLabelsSha256(['proptimiza-human-handoff'])
  const target = chatwootOwnedLabelsSha256(['proptimiza-supervised-review'])
  const body = JSON.stringify({
    add: ['proptimiza-supervised-review'],
    remove: ['proptimiza-human-handoff'],
    expected_owned_labels_sha256: initial,
  })
  agent.get(origin).intercept({ path, method: 'GET', headers: headers('GET', path) })
    .reply(200, { owned_labels_sha256: initial })
  agent.get(origin).intercept({ path, method: 'POST', headers: {
    ...headers('POST', path, body), 'content-type': 'application/json',
  }, body }).reply(200, { owned_labels_sha256: target })
  const client = new ChatwootReviewClient(options(agent))
  assert.deepEqual(await client.ownedLabelState('25'), { owned_labels_sha256: initial })
  assert.deepEqual(await client.mergeOwnedLabels('25', ['proptimiza-supervised-review'],
    ['proptimiza-human-handoff'], initial), { owned_labels_sha256: target })
  await agent.close()
})

test('review client rejects foreign labels and expanded label receipts', async () => {
  const agent = new MockAgent(); agent.disableNetConnect()
  const client = new ChatwootReviewClient(options(agent))
  await assert.rejects(() => client.mergeOwnedLabels('25', ['foreign-label' as ChatwootOwnedOperationalLabel], [],
    'a'.repeat(64)), /CHATWOOT_REVIEW_LABEL_DELTA_INVALID/)
  const path = '/api/v1/accounts/1/conversations/25/labels'
  agent.get(origin).intercept({ path, method: 'GET', headers: headers('GET', path) })
    .reply(200, { owned_labels_sha256: 'a'.repeat(64), labels: ['human-private'] })
  await assert.rejects(() => client.ownedLabelState('25'), /CHATWOOT_REVIEW_LABEL_RECEIPT_INVALID/)
  await agent.close()
})
