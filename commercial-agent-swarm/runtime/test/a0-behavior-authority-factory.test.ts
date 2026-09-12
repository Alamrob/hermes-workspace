import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createA0BehaviorAuthorityAdapters } from '../src/runtime-entrypoints.js'

it('constructs the A0 authority adapters without database or filesystem I/O', () => {
  let calls = 0
  const adapters = createA0BehaviorAuthorityAdapters({
    database: {
      query: async () => {
        calls += 1
        throw new Error('unexpected')
      },
    },
    expectedPrincipal: 'proptimiza_a0_behavior_ledger_login',
    expectedSealedInputGid: 10001,
    readSealed: async () => {
      calls += 1
      throw new Error('unexpected')
    },
  })
  assert.equal(calls, 0)
  assert.equal(typeof adapters.ledger.reserve, 'function')
  assert.equal(typeof adapters.artifactSnapshotVerifier.verify, 'function')
})
