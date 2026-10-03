import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ChatwootIncomingEvent } from '../src/comms/chatwoot-webhook.js'
import { SupervisedReviewStore } from '../src/supervised-review-store.js'

function event(messageId = '41', conversationId = '25', text = 'Texto privado que no debe persistirse.'): ChatwootIncomingEvent {
  return {
    schema_version: 'platform-chatwoot-incoming.v1',
    event_id: `cw1_${messageId.padStart(64, '0')}`,
    tenant_id: 'proptimiza', deployment_id: 'chatwoot-production', connector_id: 'whatsapp-supervised-review',
    account_id: '1', inbox_id: '1', conversation_id: conversationId, message_id: messageId,
    correlation_id: 'correlation', causation_id: 'causation',
    trace_id: '11111111-1111-5111-8111-111111111111',
    occurred_at: '2026-10-02T12:00:00.000Z', received_at: '2026-10-02T12:00:01.000Z',
    data_classification: 'restricted_external', instruction_eligible: false,
    content: { trust: 'untrusted_data', text }, semantic_sha256: 'a'.repeat(64), raw_sha256: 'b'.repeat(64),
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'proptimiza-review-store-'))
  const path = join(root, 'state', 'state.json')
  const store = new SupervisedReviewStore(path, () => new Date('2026-10-02T12:00:01Z'))
  await store.initialize()
  return { root, path, store }
}

test('deduplicates input durably without retaining conversation text', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.store.commit(event())).outcome, 'inserted')
    assert.equal((await f.store.commit(event())).outcome, 'duplicate')
    assert.equal(f.store.snapshot().pending, 1)
    const raw = await readFile(f.path, 'utf8')
    assert.equal(raw.includes('Texto privado que no debe persistirse'), false)
    const document = JSON.parse(raw)
    assert.equal(document.schema, 'proptimiza-supervised-review-store.v2')
    assert.match(document.events[`cw1_${'41'.padStart(64, '0')}`].content_sha256, /^[0-9a-f]{64}$/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('restart terminally quarantines every interrupted review stage', async () => {
  const f = await fixture()
  try {
    const preparing = event('41', '25')
    const writing = event('42', '26')
    const labeling = event('43', '27')
    const assigning = event('44', '28')
    await f.store.commit(preparing)
    await f.store.transition(preparing.event_id, 'pending', 'preparing')
    await f.store.commit(writing)
    await f.store.transition(writing.event_id, 'pending', 'preparing')
    await f.store.transition(writing.event_id, 'preparing', 'writing', {
      review_note_sha256: 'c'.repeat(64), handoff_reason: 'none',
    })
    await f.store.commit(labeling)
    await f.store.transition(labeling.event_id, 'pending', 'preparing')
    await f.store.transition(labeling.event_id, 'preparing', 'writing', {
      review_note_sha256: 'd'.repeat(64), handoff_reason: 'human_requested',
    })
    await f.store.transition(labeling.event_id, 'writing', 'labeling', {
      private_note_message_id: '91', operational_label: 'proptimiza-human-handoff',
    })
    await f.store.commit(assigning)
    await f.store.transition(assigning.event_id, 'pending', 'preparing')
    await f.store.transition(assigning.event_id, 'preparing', 'writing', {
      review_note_sha256: 'e'.repeat(64), handoff_reason: 'human_requested',
    })
    await f.store.transition(assigning.event_id, 'writing', 'labeling', {
      private_note_message_id: '92', operational_label: 'proptimiza-human-handoff',
    })
    await f.store.transition(assigning.event_id, 'labeling', 'assigning', {
      owned_labels_sha256: 'f'.repeat(64),
    })
    const restarted = new SupervisedReviewStore(f.path)
    await restarted.initialize()
    assert.equal((await restarted.get(preparing.event_id))?.stop_code, 'PREPARATION_RESULT_UNCERTAIN_AFTER_RESTART')
    assert.equal((await restarted.get(writing.event_id))?.stop_code, 'CHATWOOT_REVIEW_RESULT_UNCERTAIN_AFTER_RESTART')
    assert.equal((await restarted.get(labeling.event_id))?.stop_code, 'CHATWOOT_LABEL_RESULT_UNCERTAIN_AFTER_RESTART')
    assert.equal((await restarted.get(assigning.event_id))?.stop_code, 'CHATWOOT_REVIEW_RESULT_UNCERTAIN_AFTER_RESTART')
    assert.equal(restarted.snapshot().counts.uncertain, 4)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('migrates a valid v1 store without inventing label state', async () => {
  const f = await fixture()
  try {
    const item = event()
    await f.store.commit(item)
    const document = JSON.parse(await readFile(f.path, 'utf8'))
    document.schema = 'proptimiza-supervised-review-store.v1'
    delete document.events[item.event_id].operational_label
    delete document.events[item.event_id].owned_labels_sha256
    await writeFile(f.path, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 })
    const migrated = new SupervisedReviewStore(f.path)
    await migrated.initialize()
    const record = await migrated.get(item.event_id)
    assert.equal(record?.operational_label, null)
    assert.equal(record?.owned_labels_sha256, null)
    assert.equal(JSON.parse(await readFile(f.path, 'utf8')).schema, 'proptimiza-supervised-review-store.v2')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('rejects transitions out of terminal states', async () => {
  const f = await fixture()
  try {
    const item = event()
    await f.store.commit(item)
    await f.store.transition(item.event_id, 'pending', 'held', { stop_code: 'SUPERVISED_REVIEW_GATE_DISABLED' })
    await assert.rejects(() => f.store.transition(item.event_id, 'held', 'preparing'),
      /SUPERVISED_REVIEW_STORE_TRANSITION_INVALID/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('rejects an expanded persisted record instead of retaining added content', async () => {
  const f = await fixture()
  try {
    const item = event()
    await f.store.commit(item)
    const document = JSON.parse(await readFile(f.path, 'utf8'))
    document.events[item.event_id].content = 'contenido agregado'
    await writeFile(f.path, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 })
    await assert.rejects(() => new SupervisedReviewStore(f.path).initialize(), /SUPERVISED_REVIEW_STORE_INVALID/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
