import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import test from 'node:test'
import type { ChatwootIncomingEvent } from '../src/comms/chatwoot-webhook.js'
import { WhatsAppReplyStore } from '../src/whatsapp-automation-store.js'

function event(messageId = '41', conversationId = '25', text = 'Texto que no debe persistirse.'): ChatwootIncomingEvent {
  return {
    schema_version: 'platform-chatwoot-incoming.v1',
    event_id: `cw1_${messageId.padStart(64, '0')}`,
    tenant_id: 'proptimiza', deployment_id: 'chatwoot-production', connector_id: 'whatsapp-agentbot',
    account_id: '1', inbox_id: '1', conversation_id: conversationId, message_id: messageId,
    correlation_id: 'correlation', causation_id: 'causation',
    trace_id: '11111111-1111-5111-8111-111111111111',
    occurred_at: '2026-09-30T12:00:00.000Z', received_at: '2026-09-30T12:00:01.000Z',
    data_classification: 'restricted_external', instruction_eligible: false,
    content: { trust: 'untrusted_data', text }, semantic_sha256: 'a'.repeat(64), raw_sha256: 'b'.repeat(64),
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'proptimiza-wa-store-'))
  const path = join(root, 'state', 'state.json')
  const store = new WhatsAppReplyStore(path, () => new Date('2026-09-30T12:00:01Z'))
  await store.initialize()
  return { root, path, store }
}

test('durably deduplicates an inbound event without retaining customer content', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.store.commit(event())).outcome, 'inserted')
    assert.equal((await f.store.commit(event())).outcome, 'duplicate')
    assert.equal(f.store.snapshot().pending, 1)
    const raw = await readFile(f.path, 'utf8')
    assert.equal(raw.includes('Texto que no debe persistirse'), false)
    assert.match(JSON.parse(raw).events[`cw1_${'41'.padStart(64, '0')}`].content_sha256, /^[0-9a-f]{64}$/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('restart converts in-flight model and send states to terminal uncertainty', async () => {
  const f = await fixture()
  try {
    const one = event('41', '25'), two = event('42', '26')
    await f.store.commit(one); await f.store.transition(one.event_id, 'pending', 'model_running')
    await f.store.commit(two); await f.store.transition(two.event_id, 'pending', 'model_running')
    await f.store.transition(two.event_id, 'model_running', 'ready', { response_sha256: 'c'.repeat(64) })
    await f.store.transition(two.event_id, 'ready', 'sending')
    const restarted = new WhatsAppReplyStore(f.path)
    await restarted.initialize()
    assert.equal((await restarted.get(one.event_id))?.stop_code, 'MODEL_RESULT_UNCERTAIN_AFTER_RESTART')
    assert.equal((await restarted.get(two.event_id))?.stop_code, 'SEND_RESULT_UNCERTAIN_AFTER_RESTART')
    assert.equal(restarted.snapshot().counts.uncertain, 2)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('a human takeover or model-requested handoff holds later events in the conversation', async () => {
  const f = await fixture()
  try {
    const first = event('41', '25')
    await f.store.commit(first)
    await f.store.transition(first.event_id, 'pending', 'model_running')
    await f.store.transition(first.event_id, 'model_running', 'ready', {
      response_sha256: 'c'.repeat(64), handoff_reason: 'human_requested',
    })
    await f.store.transition(first.event_id, 'ready', 'sending')
    await f.store.transition(first.event_id, 'sending', 'sent', { outbound_message_id: '91' })
    assert.equal(await f.store.conversationHoldReason('25'), 'human_requested')
    assert.equal(await f.store.conversationHoldReason('26'), null)

    const second = event('42', '26')
    await f.store.commit(second)
    await f.store.transition(second.event_id, 'pending', 'model_running')
    await f.store.transition(second.event_id, 'model_running', 'ready', {
      response_sha256: 'd'.repeat(64), handoff_reason: 'specialist_required',
    })
    await f.store.transition(second.event_id, 'ready', 'sending')
    await f.store.transition(second.event_id, 'sending', 'held', {
      outbound_message_id: '92', stop_code: 'REPLY_SENT_HANDOFF_ASSIGNMENT_UNCERTAIN',
    })
    assert.equal(await f.store.conversationHoldReason('26'), 'specialist_required')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('counts only known automated replies inside the requested rolling window', async () => {
  const f = await fixture()
  try {
    const sent = event('41', '25')
    await f.store.commit(sent)
    await f.store.transition(sent.event_id, 'pending', 'model_running')
    await f.store.transition(sent.event_id, 'model_running', 'ready', { response_sha256: 'c'.repeat(64) })
    await f.store.transition(sent.event_id, 'ready', 'sending')
    await f.store.transition(sent.event_id, 'sending', 'sent', { outbound_message_id: '91' })

    const sentButHeld = event('42', '25')
    await f.store.commit(sentButHeld)
    await f.store.transition(sentButHeld.event_id, 'pending', 'model_running')
    await f.store.transition(sentButHeld.event_id, 'model_running', 'ready', { response_sha256: 'd'.repeat(64) })
    await f.store.transition(sentButHeld.event_id, 'ready', 'sending')
    await f.store.transition(sentButHeld.event_id, 'sending', 'held', {
      outbound_message_id: '92', stop_code: 'REPLY_SENT_HANDOFF_ASSIGNMENT_UNCERTAIN',
    })

    const notSent = event('43', '25')
    await f.store.commit(notSent)
    await f.store.transition(notSent.event_id, 'pending', 'held', { stop_code: 'AUTOMATION_KILL_SWITCH_ACTIVE' })

    const possiblySent = event('44', '25')
    await f.store.commit(possiblySent)
    await f.store.transition(possiblySent.event_id, 'pending', 'model_running')
    await f.store.transition(possiblySent.event_id, 'model_running', 'ready', { response_sha256: 'e'.repeat(64) })
    await f.store.transition(possiblySent.event_id, 'ready', 'sending')
    await f.store.transition(possiblySent.event_id, 'sending', 'uncertain', { stop_code: 'CHATWOOT_SEND_UNCERTAIN' })

    assert.equal(await f.store.automatedReplyCountSince('25', new Date('2026-09-29T12:00:00Z')), 3)
    assert.equal(await f.store.automatedReplyCountSince('25', new Date('2026-10-01T12:00:00Z')), 0)
    assert.equal(await f.store.automatedReplyCountSince('26', new Date('2026-09-29T12:00:00Z')), 0)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('failed, uncertain, human takeover and response-policy rejection require a human before future events', async () => {
  const statuses: Array<{ message: string; conversation: string; status: 'failed' | 'uncertain' | 'held'; code: string }> = [
    { message: '51', conversation: '31', status: 'failed', code: 'CHATWOOT_REJECTED_403' },
    { message: '52', conversation: '32', status: 'uncertain', code: 'CHATWOOT_SEND_UNCERTAIN' },
    { message: '53', conversation: '33', status: 'held', code: 'HUMAN_REPLY_OBSERVED' },
    { message: '54', conversation: '34', status: 'held', code: 'AUTOMATIC_REPLY_RESPONSE_POLICY_REJECTED' },
  ]
  const f = await fixture()
  try {
    for (const item of statuses) {
      const incoming = event(item.message, item.conversation)
      await f.store.commit(incoming)
      await f.store.transition(incoming.event_id, 'pending', item.status, { stop_code: item.code })
      assert.equal(await f.store.conversationHoldReason(item.conversation), item.code)
    }
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
