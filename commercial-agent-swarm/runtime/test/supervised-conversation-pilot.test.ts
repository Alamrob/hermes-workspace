import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { ChatwootConversationSnapshot } from '../src/comms/chatwoot-outbound.js'
import { chatwootOwnedLabelsSha256 } from '../src/comms/chatwoot-outbound.js'
import {
  runSupervisedConversationPilot,
  stageSupervisedReview,
  type SupervisedConversationReader,
  type SupervisedReviewWriter,
} from '../src/supervised-conversation-pilot.js'

const content = 'Hola, quiero conocer sus servicios.'
const digest = createHash('sha256').update(content, 'utf8').digest('hex')
const capabilities = Object.freeze({
  internal_notes: false,
  labels: false,
  assignments: true,
  saved_drafts: false,
  hermes_dispatch: false,
  hermes_profiles: [] as string[],
})
const input = Object.freeze({
  conversation_id: '25',
  message_id: '42',
  content_sha256: digest,
  authorized_facts: [],
  capabilities,
})

function snapshot(overrides: Partial<ChatwootConversationSnapshot> = {}): ChatwootConversationSnapshot {
  return {
    target: { message_id: '42', sequence: 42, kind: 'incoming', content },
    transcript: [{ message_id: '42', sequence: 42, kind: 'incoming', content }],
    latest_message_id: '42',
    current: true,
    human_replied: false,
    ...overrides,
  }
}

test('compiles a review-only case through a read-only port', async () => {
  let reads = 0
  const reader: SupervisedConversationReader = { snapshot: async () => { reads += 1; return snapshot() } }
  const result = await runSupervisedConversationPilot(reader, input)
  assert.equal(reads, 1)
  assert.equal(result.status, 'draft_ready')
  if (result.status !== 'draft_ready') return
  assert.equal(result.case_file.send_permitted, false)
  assert.equal(result.case_file.human_review_required, true)
  assert.doesNotMatch(JSON.stringify(result.case_file), /quiero conocer sus servicios/i)
  assert.match(result.review_note, /REVISIÓN HUMANA OBLIGATORIA/)
  assert.match(result.review_note, /Borrador no enviado/)
  assert.doesNotMatch(result.review_note, /quiero conocer sus servicios/i)
  assert.ok(Buffer.byteLength(result.review_note, 'utf8') <= 2000)
})

test('holds a case when a human has already replied', async () => {
  const reader: SupervisedConversationReader = { snapshot: async () => snapshot({ current: false, human_replied: true }) }
  assert.deepEqual(await runSupervisedConversationPilot(reader, input), {
    status: 'held', case_ref: 'cw:25:42', reason: 'human_already_replied',
  })
})

test('holds a stale target without compiling a draft', async () => {
  const reader: SupervisedConversationReader = { snapshot: async () => snapshot({ current: false }) }
  assert.deepEqual(await runSupervisedConversationPilot(reader, input), {
    status: 'held', case_ref: 'cw:25:42', reason: 'target_not_current',
  })
})

test('does not retry an uncertain reader failure', async () => {
  let reads = 0
  const reader: SupervisedConversationReader = { snapshot: async () => { reads += 1; throw new Error('READ_UNCERTAIN') } }
  await assert.rejects(() => runSupervisedConversationPilot(reader, input), /READ_UNCERTAIN/)
  assert.equal(reads, 1)
})

test('stages one private review note without assigning an ordinary diagnostic case', async () => {
  const reader: SupervisedConversationReader = { snapshot: async () => snapshot() }
  const result = await runSupervisedConversationPilot(reader, input)
  assert.equal(result.status, 'draft_ready')
  if (result.status !== 'draft_ready') return
  const actions: string[] = []
  const writer: SupervisedReviewWriter = {
    createPrivateNote: async (_conversation, note) => { actions.push(`note:${note.length}`); return { message_id: '91' } },
    ownedLabelState: async () => { actions.push('label-read'); return { owned_labels_sha256: chatwootOwnedLabelsSha256([]) } },
    mergeOwnedLabels: async (_conversation, add) => {
      actions.push(`label:${add.join('+')}`)
      return { owned_labels_sha256: chatwootOwnedLabelsSha256(add) }
    },
    assignTeam: async () => { actions.push('assign'); return { team_id: '1' } },
  }
  assert.deepEqual(await stageSupervisedReview(writer, '25', result), { note_message_id: '91', team_assigned: false })
  assert.equal(actions.length, 3)
  assert.match(actions[0]!, /^note:/)
  assert.deepEqual(actions.slice(1), ['label-read', 'label:proptimiza-supervised-review'])
})

test('stages a private note then assigns an explicit human handoff to team 1', async () => {
  const handoffContent = 'Quiero hablar con una persona.'
  const reader: SupervisedConversationReader = { snapshot: async () => snapshot({
    target: { message_id: '42', sequence: 42, kind: 'incoming', content: handoffContent },
    transcript: [{ message_id: '42', sequence: 42, kind: 'incoming', content: handoffContent }],
  }) }
  const result = await runSupervisedConversationPilot(reader, {
    ...input, content_sha256: createHash('sha256').update(handoffContent, 'utf8').digest('hex'),
  })
  assert.equal(result.status, 'draft_ready')
  if (result.status !== 'draft_ready') return
  const actions: string[] = []
  const writer: SupervisedReviewWriter = {
    createPrivateNote: async () => { actions.push('note'); return { message_id: '92' } },
    ownedLabelState: async () => { actions.push('label-read'); return { owned_labels_sha256: chatwootOwnedLabelsSha256([]) } },
    mergeOwnedLabels: async (_conversation, add) => {
      actions.push(`label:${add.join('+')}`)
      return { owned_labels_sha256: chatwootOwnedLabelsSha256(add) }
    },
    assignTeam: async (_conversation, team) => { actions.push(`assign:${team}`); return { team_id: team } },
  }
  assert.deepEqual(await stageSupervisedReview(writer, '25', result), { note_message_id: '92', team_assigned: true })
  assert.deepEqual(actions, ['note', 'label-read', 'label:proptimiza-human-handoff', 'assign:1'])
})

test('does not retry or continue after an uncertain private-note failure', async () => {
  const reader: SupervisedConversationReader = { snapshot: async () => snapshot() }
  const result = await runSupervisedConversationPilot(reader, input)
  assert.equal(result.status, 'draft_ready')
  if (result.status !== 'draft_ready') return
  let notes = 0, assignments = 0
  const writer: SupervisedReviewWriter = {
    createPrivateNote: async () => { notes += 1; throw new Error('NOTE_UNCERTAIN') },
    ownedLabelState: async () => { throw new Error('UNREACHABLE') },
    mergeOwnedLabels: async () => { throw new Error('UNREACHABLE') },
    assignTeam: async () => { assignments += 1; return { team_id: '1' } },
  }
  await assert.rejects(() => stageSupervisedReview(writer, '25', result), /NOTE_UNCERTAIN/)
  assert.equal(notes, 1)
  assert.equal(assignments, 0)
})
