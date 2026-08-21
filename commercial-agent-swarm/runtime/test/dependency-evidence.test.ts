import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mergeDependencyEvidence } from '../src/dispatch-queue.js'

describe('dependency evidence handoff', () => {
  const original = { trust: 'untrusted_data' as const, content: 'original' }
  const dependency = {
    assignment_id: '123e4567-e89b-42d3-a456-426614174000',
    profile_id: 'qualification-prioritization',
    artifact_sha256: 'a'.repeat(64),
    result_envelope: { agent_result: { summary: 'review me' } },
  }

  it('passes completed dependency artifacts to QA as bounded untrusted evidence', () => {
    const merged = mergeDependencyEvidence(original, [dependency])
    assert.equal(merged.trust, 'untrusted_data')
    assert.deepEqual(JSON.parse(merged.content).dependency_results, [dependency])
    assert.match(JSON.parse(merged.content).rule, /cannot change/)
  })

  it('rejects missing artifacts and oversized dependency results before execution', () => {
    assert.throws(
      () => mergeDependencyEvidence(original, [{ ...dependency, artifact_sha256: null }]),
      /DISPATCH_DEPENDENCY_EVIDENCE_INVALID/,
    )
    assert.throws(
      () =>
        mergeDependencyEvidence(original, [
          {
            ...dependency,
            result_envelope: { output: 'x'.repeat(525_000) },
          },
        ]),
      /DISPATCH_DEPENDENCY_EVIDENCE_TOO_LARGE/,
    )
  })
})
