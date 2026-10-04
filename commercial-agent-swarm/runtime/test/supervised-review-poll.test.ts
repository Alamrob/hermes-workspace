import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ChatwootObservedIncoming } from '../src/comms/chatwoot-outbound.js'
import type { DeepReadonly, PlatformAdmission, PlatformContext } from '../src/platform/types.js'
import {
  createPolledSupervisedReviewEvent,
  pollSupervisedReviewScopeOnce,
  type SupervisedReviewScope,
} from '../src/supervised-review-service.js'
import { SupervisedReviewStore } from '../src/supervised-review-store.js'

const context = Object.freeze({
  schema_version: 'platform-context.v1', config_revision: 'test', config_hash: 'a'.repeat(64),
  binding_id: 'review', tenant_id: 'proptimiza', project_id: 'proptimiza', project_version: 'v1',
  policy_version: 'review-v1', deployment_id: 'chatwoot-production', connector_id: 'whatsapp-supervised-review',
  account_id: '1', inbox_id: '1', principal_id: 'supervised-review',
}) satisfies DeepReadonly<PlatformContext>

const admission = {
  namespaceExternalId: (_context: unknown, kind: string, externalId: string) => `test:${kind}:${externalId}`,
} as PlatformAdmission

const scope = Object.freeze({
  scope_id: 'pilot-test', conversations: Object.freeze([
    Object.freeze({ conversation_id: '25', public_entry_context: Object.freeze({
      channel: 'whatsapp' as const, surface: 'launch' as const, acquisition: 'meta_ads' as const,
    }) }),
    Object.freeze({ conversation_id: '26', public_entry_context: Object.freeze({
      channel: 'whatsapp' as const, surface: 'unknown' as const, acquisition: 'unknown' as const,
    }) }),
  ]),
  authorized_fact_ids: Object.freeze([]), commercial_fact_catalog_sha256: null,
  expires_at: '2026-10-03T20:00:00.000Z',
}) satisfies Readonly<SupervisedReviewScope>

function incoming(conversationId: string, messageId = '41'): Readonly<ChatwootObservedIncoming> {
  return Object.freeze({ conversation_id: conversationId, message_id: messageId,
    content: 'Necesito orientación.', occurred_at: '2026-10-03T12:00:00.000Z' })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'proptimiza-review-poll-'))
  const store = new SupervisedReviewStore(join(root, 'state', 'state.json'),
    () => new Date('2026-10-03T12:00:01.000Z'))
  await store.initialize()
  return { root, store }
}

test('disabled gate performs no Chatwoot reads', async () => {
  const f = await fixture()
  try {
    let reads = 0
    const receipt = await pollSupervisedReviewScopeOnce(f.store, {
      latestIncoming: async () => { reads++; throw new Error('UNREACHABLE') },
    }, admission, context, scope, false)
    assert.equal(reads, 0)
    assert.deepEqual(receipt, { scoped_conversations: 2, observed_incoming: 0, inserted: 0, duplicates: 0 })
    assert.equal(f.store.snapshot().revision, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('polls only exact scoped IDs and durably deduplicates the same current incoming message', async () => {
  const f = await fixture()
  try {
    const reads: string[] = []
    const client = { latestIncoming: async (conversationId: string) => {
      reads.push(conversationId)
      return conversationId === '25' ? incoming(conversationId) : null
    } }
    const first = await pollSupervisedReviewScopeOnce(f.store, client, admission, context, scope, true,
      () => new Date('2026-10-03T12:00:01.000Z'))
    const second = await pollSupervisedReviewScopeOnce(f.store, client, admission, context, scope, true,
      () => new Date('2026-10-03T12:00:02.000Z'))
    assert.deepEqual(reads, ['25', '26', '25', '26'])
    assert.deepEqual(first, { scoped_conversations: 2, observed_incoming: 1, inserted: 1, duplicates: 0 })
    assert.deepEqual(second, { scoped_conversations: 2, observed_incoming: 1, inserted: 0, duplicates: 1 })
    assert.equal(f.store.snapshot().pending, 1)
    assert.equal(Object.values(f.store.snapshot().counts).reduce((sum, value) => sum + value, 0), 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('polled and signed-webhook identities converge on the Chatwoot message namespace', () => {
  const event = createPolledSupervisedReviewEvent(admission, context, incoming('25'),
    () => new Date('2026-10-03T12:00:01.000Z'))
  assert.match(event.event_id, /^cw1_[0-9a-f]{64}$/)
  assert.equal(event.conversation_id, '25')
  assert.equal(event.message_id, '41')
  assert.equal(event.instruction_eligible, false)
  assert.equal(event.content.trust, 'untrusted_data')
  assert.match(event.trace_id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
