import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { it } from 'node:test'
import { createA0BehaviorAuthorityAdapters } from '../src/runtime-entrypoints.js'

it('constructs the A0 authority adapters without database or filesystem I/O', () => {
  let calls = 0
  const { publicKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const expectedPublicKeySha256 = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
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
    authorization: {
      issuer: 'codex-auditor',
      audience: 'proptimiza-a0-batch-admission',
      keyId: 'codex-a0-ed25519-v1',
      publicKeyPem,
      expectedPublicKeySha256,
    },
  })
  assert.equal(calls, 0)
  assert.equal(typeof adapters.ledger.reserve, 'function')
  assert.equal(typeof adapters.ledger.acquireExecutionPermit, 'function')
  assert.equal(typeof adapters.authorizationVerifier.verify, 'function')
  assert.equal(typeof adapters.artifactSnapshotVerifier.verify, 'function')
})
