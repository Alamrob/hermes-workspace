import assert from 'node:assert/strict'
import test from 'node:test'
import { LAUNCH_CATALOG_SHA256, launchBusinessContext, liveBusinessContext } from '../src/business/proptimiza-live-context.js'
import { readConversationBusinessContext } from '../src/platform/conversation-request.js'

test('emits the canonical, hash-bound, time-bounded launch catalog context', () => {
  const now = new Date('2026-09-30T12:00:00Z')
  const context = liveBusinessContext(now)
  const parsed = readConversationBusinessContext(context.json, context.sha256)
  assert.equal(parsed.revision, 'launch-0.1.0-candidate')
  assert.equal(parsed.facts.length, 16)
  assert.match(parsed.facts.find((fact) => fact.id === 'catalog-identity')?.text ?? '', new RegExp(LAUNCH_CATALOG_SHA256))
  assert.equal(parsed.facts.some((fact) => fact.id === 'offer-purpose'), true)
  assert.match(parsed.facts.find((fact) => fact.id === 'business-purpose')?.text ?? '', /diagnostica y automatiza procesos/)
  assert.match(parsed.facts.find((fact) => fact.id === 'qualification')?.text ?? '', /No menciona WhatsApp ni un plan/)
  assert.equal(parsed.facts.some((fact) => fact.id === 'human-control'), true)
  assert.equal(parsed.facts.some((fact) => fact.id === 'pricing-gate'), true)
  assert.equal(parsed.facts.some((fact) => fact.id === 'identity-boundary'), true)
  assert.equal(parsed.facts.some((fact) => fact.id === 'relationship-handoff'), true)
  assert.equal(parsed.facts.some((fact) => fact.id === 'scope-boundary'), true)
  assert.doesNotMatch(context.json, /Operación Sin Planillas|operacion-sin-planillas|1[.,]800[.,]000/)
  assert.doesNotMatch(context.json, /490000|990000|2490000|350000/)
  assert.ok(parsed.valid_from <= now.getTime() / 1000)
  assert.ok(parsed.valid_until > now.getTime() / 1000)
})
test('rejects invalid launch context windows before serialization', () => {
  assert.throws(() => launchBusinessContext(0, 10), /LAUNCH_CONTEXT_WINDOW_INVALID/)
  assert.throws(() => launchBusinessContext(10, 10), /LAUNCH_CONTEXT_WINDOW_INVALID/)
  assert.throws(() => launchBusinessContext(11, 10), /LAUNCH_CONTEXT_WINDOW_INVALID/)
})
