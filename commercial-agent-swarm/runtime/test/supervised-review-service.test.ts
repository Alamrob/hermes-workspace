import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ChatwootHttpError,
  chatwootOwnedLabelsSha256,
  type ChatwootConversationSnapshot,
} from '../src/comms/chatwoot-outbound.js'
import type { ChatwootIncomingEvent } from '../src/comms/chatwoot-webhook.js'
import type { CommercialFact } from '../src/commercial-fact-authority.js'
import {
  processSupervisedReviewEvent,
  type SupervisedReviewClientPort,
} from '../src/supervised-review-service.js'
import { SupervisedReviewStore } from '../src/supervised-review-store.js'

function inbound(text = 'Hola, estoy interesado en sus productos.'): ChatwootIncomingEvent {
  return {
    schema_version: 'platform-chatwoot-incoming.v1', event_id: `cw1_${'41'.padStart(64, '0')}`,
    tenant_id: 'proptimiza', deployment_id: 'chatwoot-production', connector_id: 'whatsapp-supervised-review',
    account_id: '1', inbox_id: '1', conversation_id: '25', message_id: '41',
    correlation_id: 'correlation', causation_id: 'causation', trace_id: '11111111-1111-5111-8111-111111111111',
    occurred_at: '2026-10-02T12:00:00.000Z', received_at: '2026-10-02T12:00:01.000Z',
    data_classification: 'restricted_external', instruction_eligible: false,
    content: { trust: 'untrusted_data', text }, semantic_sha256: 'a'.repeat(64), raw_sha256: 'b'.repeat(64),
  }
}

function snapshot(text: string, overrides: Partial<ChatwootConversationSnapshot> = {}): ChatwootConversationSnapshot {
  return {
    target: { message_id: '41', sequence: 41, kind: 'incoming', content: text },
    transcript: [{ message_id: '41', sequence: 41, kind: 'incoming', content: text }],
    latest_message_id: '41', current: true, human_replied: false, ...overrides,
  }
}

async function fixture(text = 'Hola, estoy interesado en sus productos.') {
  const root = await mkdtemp(join(tmpdir(), 'proptimiza-review-service-'))
  const path = join(root, 'state', 'state.json')
  const store = new SupervisedReviewStore(path, () => new Date('2026-10-02T12:00:01Z'))
  await store.initialize()
  const event = inbound(text)
  await store.commit(event)
  const record = await store.get(event.event_id)
  assert.ok(record)
  return { root, store, record, text }
}

function clientFor(text: string, actions: string[], overrides: Partial<SupervisedReviewClientPort> = {}): SupervisedReviewClientPort {
  return {
    snapshot: async (_conversation, _message, hash) => {
      actions.push('read')
      assert.equal(hash, createHash('sha256').update(text, 'utf8').digest('hex'))
      return snapshot(text)
    },
    createPrivateNote: async (_conversation, note) => {
      actions.push('private-note')
      assert.match(note, /REVISIÓN HUMANA OBLIGATORIA/)
      assert.doesNotMatch(note, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
      return { message_id: '91' }
    },
    ownedLabelState: async () => {
      actions.push('label-read')
      return { owned_labels_sha256: chatwootOwnedLabelsSha256([]) }
    },
    mergeOwnedLabels: async (_conversation, add, remove, expected) => {
      actions.push(`label:${add.join('+') || 'none'}:${remove.join('+') || 'none'}`)
      assert.equal(expected, chatwootOwnedLabelsSha256([]))
      return { owned_labels_sha256: chatwootOwnedLabelsSha256(add) }
    },
    assignTeam: async (_conversation, team) => { actions.push(`assign:${team}`); return { team_id: team } },
    ...overrides,
  }
}

test('stages one private note for review and has no public-send dependency', async () => {
  const f = await fixture()
  try {
    const actions: string[] = []
    await processSupervisedReviewEvent(f.store, clientFor(f.text, actions), f.record, true, true)
    const record = await f.store.get(f.record.event_id)
    assert.deepEqual(actions, ['read', 'private-note', 'label-read', 'label:proptimiza-supervised-review:none'])
    assert.equal(record?.status, 'staged')
    assert.equal(record?.private_note_message_id, '91')
    assert.equal(record?.operational_label, 'proptimiza-supervised-review')
    assert.equal(record?.owned_labels_sha256, chatwootOwnedLabelsSha256(['proptimiza-supervised-review']))
    assert.equal(record?.team_assigned, false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('uses only a resolved approved fact and records its id in the private review note', async () => {
  const f = await fixture('¿Qué servicios ofrece Proptimiza?')
  try {
    const actions: string[] = []
    let note = ''
    const client = clientFor(f.text, actions, {
      createPrivateNote: async (_conversation, value) => { actions.push('private-note'); note = value; return { message_id: '91' } },
    })
    const fact = Object.freeze({
      id: 'fact:offer:consulting', category: 'offer',
      statement: 'Proptimiza diagnostica y mejora procesos comerciales y operativos.',
      source_ref: 'catalog:commercial:v1', approved_by_role: 'commercial_owner',
      approved_at: '2026-10-02T10:00:00.000Z', expires_at: '2026-10-03T10:00:00.000Z',
    } satisfies CommercialFact)
    await processSupervisedReviewEvent(f.store, client, f.record, true, true, [fact])
    assert.deepEqual(actions, ['read', 'private-note', 'label-read', 'label:proptimiza-supervised-review:none'])
    assert.match(note, /diagnostica y mejora procesos comerciales y operativos/i)
    assert.match(note, /Hechos aplicados: fact:offer:consulting/)
    assert.doesNotMatch(note, /catalog:commercial:v1/)
    assert.equal((await f.store.get(f.record.event_id))?.status, 'staged')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('stages a note before assigning an explicit human handoff to team 1', async () => {
  const f = await fixture('Quiero hablar con una persona.')
  try {
    const actions: string[] = []
    await processSupervisedReviewEvent(f.store, clientFor(f.text, actions), f.record, true, true)
    const record = await f.store.get(f.record.event_id)
    assert.deepEqual(actions, ['read', 'private-note', 'label-read', 'label:proptimiza-human-handoff:none', 'assign:1'])
    assert.equal(record?.status, 'staged')
    assert.equal(record?.handoff_reason, 'human_requested')
    assert.equal(record?.operational_label, 'proptimiza-human-handoff')
    assert.equal(record?.team_assigned, true)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('holds without mutation when the gate is disabled', async () => {
  const f = await fixture()
  try {
    const actions: string[] = []
    await processSupervisedReviewEvent(f.store, clientFor(f.text, actions), f.record, false, true)
    assert.deepEqual(actions, [])
    assert.equal((await f.store.get(f.record.event_id))?.stop_code, 'SUPERVISED_REVIEW_GATE_DISABLED')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('holds an out-of-scope conversation before reading Chatwoot', async () => {
  const f = await fixture()
  try {
    const actions: string[] = []
    await processSupervisedReviewEvent(f.store, clientFor(f.text, actions), f.record, true, false)
    assert.deepEqual(actions, [])
    assert.equal((await f.store.get(f.record.event_id))?.stop_code, 'SUPERVISED_REVIEW_OUT_OF_SCOPE')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('holds when a human has replied before preparation', async () => {
  const f = await fixture()
  try {
    const actions: string[] = []
    const client = clientFor(f.text, actions, {
      snapshot: async () => { actions.push('read'); return snapshot(f.text, { current: false, human_replied: true }) },
    })
    await processSupervisedReviewEvent(f.store, client, f.record, true, true)
    assert.deepEqual(actions, ['read'])
    assert.equal((await f.store.get(f.record.event_id))?.stop_code, 'HUMAN_REPLY_OBSERVED')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('quarantines an uncertain note result without retrying', async () => {
  const f = await fixture()
  try {
    const actions: string[] = []
    const client = clientFor(f.text, actions, {
      createPrivateNote: async () => { actions.push('private-note'); throw new Error('NETWORK_TIMEOUT') },
    })
    await processSupervisedReviewEvent(f.store, client, f.record, true, true)
    assert.deepEqual(actions, ['read', 'private-note'])
    const record = await f.store.get(f.record.event_id)
    assert.equal(record?.status, 'uncertain')
    assert.equal(record?.stop_code, 'REVIEW_NOTE_RESULT_UNCERTAIN')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('keeps the private note and holds a rejected human assignment', async () => {
  const f = await fixture('Quiero hablar con una persona.')
  try {
    const actions: string[] = []
    const client = clientFor(f.text, actions, {
      assignTeam: async () => { actions.push('assign:1'); throw new ChatwootHttpError(403) },
    })
    await processSupervisedReviewEvent(f.store, client, f.record, true, true)
    assert.deepEqual(actions, ['read', 'private-note', 'label-read', 'label:proptimiza-human-handoff:none', 'assign:1'])
    const record = await f.store.get(f.record.event_id)
    assert.equal(record?.status, 'held')
    assert.equal(record?.private_note_message_id, '91')
    assert.equal(record?.stop_code, 'HUMAN_HANDOFF_ASSIGNMENT_REJECTED_403')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('quarantines a malformed note receipt because the remote effect may exist', async () => {
  const f = await fixture()
  try {
    const actions: string[] = []
    const client = clientFor(f.text, actions, {
      createPrivateNote: async () => { actions.push('private-note'); return { message_id: 'invalid' } },
    })
    await processSupervisedReviewEvent(f.store, client, f.record, true, true)
    assert.deepEqual(actions, ['read', 'private-note'])
    assert.equal((await f.store.get(f.record.event_id))?.status, 'uncertain')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('quarantines a mismatched assignment receipt after preserving the private note id', async () => {
  const f = await fixture('Quiero hablar con una persona.')
  try {
    const actions: string[] = []
    const client = clientFor(f.text, actions, {
      assignTeam: async () => { actions.push('assign:1'); return { team_id: '2' } },
    })
    await processSupervisedReviewEvent(f.store, client, f.record, true, true)
    const record = await f.store.get(f.record.event_id)
    assert.deepEqual(actions, ['read', 'private-note', 'label-read', 'label:proptimiza-human-handoff:none', 'assign:1'])
    assert.equal(record?.status, 'uncertain')
    assert.equal(record?.private_note_message_id, '91')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('holds a rejected label merge after preserving the private note and does not assign', async () => {
  const f = await fixture('Quiero hablar con una persona.')
  try {
    const actions: string[] = []
    const client = clientFor(f.text, actions, {
      mergeOwnedLabels: async () => { actions.push('label-write'); throw new ChatwootHttpError(403) },
    })
    await processSupervisedReviewEvent(f.store, client, f.record, true, true)
    assert.deepEqual(actions, ['read', 'private-note', 'label-read', 'label-write'])
    const record = await f.store.get(f.record.event_id)
    assert.equal(record?.status, 'held')
    assert.equal(record?.private_note_message_id, '91')
    assert.equal(record?.stop_code, 'OWNED_LABEL_MERGE_REJECTED_403')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('quarantines one uncertain label write without retrying or assigning', async () => {
  const f = await fixture('Quiero hablar con una persona.')
  try {
    const actions: string[] = []
    const client = clientFor(f.text, actions, {
      mergeOwnedLabels: async () => { actions.push('label-write'); throw new Error('NETWORK_TIMEOUT') },
    })
    await processSupervisedReviewEvent(f.store, client, f.record, true, true)
    assert.deepEqual(actions, ['read', 'private-note', 'label-read', 'label-write'])
    const record = await f.store.get(f.record.event_id)
    assert.equal(record?.status, 'uncertain')
    assert.equal(record?.stop_code, 'OWNED_LABEL_MERGE_RESULT_UNCERTAIN')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('does not write when the exact owned operational label is already present', async () => {
  const f = await fixture()
  try {
    const actions: string[] = []
    const client = clientFor(f.text, actions, {
      ownedLabelState: async () => {
        actions.push('label-read')
        return { owned_labels_sha256: chatwootOwnedLabelsSha256(['proptimiza-supervised-review']) }
      },
      mergeOwnedLabels: async () => { actions.push('unexpected-label-write'); throw new Error('UNREACHABLE') },
    })
    await processSupervisedReviewEvent(f.store, client, f.record, true, true)
    assert.deepEqual(actions, ['read', 'private-note', 'label-read'])
    assert.equal((await f.store.get(f.record.event_id))?.status, 'staged')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('fails a label-state read without attempting a merge', async () => {
  const f = await fixture()
  try {
    const actions: string[] = []
    const client = clientFor(f.text, actions, {
      ownedLabelState: async () => { actions.push('label-read'); throw new Error('NETWORK_TIMEOUT') },
      mergeOwnedLabels: async () => { actions.push('unexpected-label-write'); throw new Error('UNREACHABLE') },
    })
    await processSupervisedReviewEvent(f.store, client, f.record, true, true)
    assert.deepEqual(actions, ['read', 'private-note', 'label-read'])
    const record = await f.store.get(f.record.event_id)
    assert.equal(record?.status, 'failed')
    assert.equal(record?.stop_code, 'OWNED_LABEL_STATE_READ_FAILED')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
