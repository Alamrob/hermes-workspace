import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'
import { signWorkOrderEd25519, verifyWorkOrder } from '../src/security.js'
import type { WorkOrder } from '../src/work-orders.js'
import { validWorkOrder } from './fixtures.js'

describe('constant-time secret comparison', () => {
  it('normalizes differently sized Bearer values to fixed-length SHA-256 digests', async () => {
    const security = await import('../src/security.js') as Record<string, unknown>
    const digest = security.digestSecretForComparison
    const compare = security.constantTimeSecretEqual

    assert.equal(typeof digest, 'function')
    assert.equal(typeof compare, 'function')
    const short = (digest as (value: string) => Buffer)('x')
    const long = (digest as (value: string) => Buffer)('x'.repeat(4096))
    assert.equal(short.byteLength, 32)
    assert.equal(long.byteLength, 32)
    assert.equal((compare as (left: string, right: string) => boolean)('short', 'different-length'), false)
    assert.equal((compare as (left: string, right: string) => boolean)('same', 'same'), true)
  })
})

describe('Ed25519 work-order authority', () => {
  it('verifies with a public key while the broker never receives the private key', () => {
    const pair = generateKeyPairSync('ed25519')
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const order = validWorkOrder() as unknown as WorkOrder
    order.authority = {
      issuer: 'codex', audience: 'hermes-commercial-orchestrator', key_id: 'codex-a1-ed25519-v1',
      algorithm: 'Ed25519', signature: '0'.repeat(128),
    }
    const authority = order.authority as Record<string, string>
    authority.signature = signWorkOrderEd25519(order, privateKey)
    assert.equal(authority.signature.length, 128)
    assert.doesNotThrow(() => verifyWorkOrder(order, {
      issuer: 'codex', audience: 'hermes-commercial-orchestrator', keys: {},
      ed25519PublicKeys: { 'codex-a1-ed25519-v1': publicKey },
    }, new Date('2026-08-15T19:00:00.000Z')))
  })

  it('rejects a changed order, unknown key or HMAC-shaped signature', () => {
    const pair = generateKeyPairSync('ed25519')
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const order = validWorkOrder() as unknown as WorkOrder
    order.authority = {
      issuer: 'codex', audience: 'hermes-commercial-orchestrator', key_id: 'codex-a1-ed25519-v1',
      algorithm: 'Ed25519', signature: '0'.repeat(128),
    }
    const authority = order.authority as Record<string, string>
    authority.signature = signWorkOrderEd25519(order, privateKey)
    order.objective = 'changed after signature'
    const config = { issuer: 'codex', audience: 'hermes-commercial-orchestrator', keys: {}, ed25519PublicKeys: { 'codex-a1-ed25519-v1': publicKey } }
    assert.throws(() => verifyWorkOrder(order, config, new Date('2026-08-15T19:00:00.000Z')), /INVALID_SIGNATURE/)
    authority.signature = '0'.repeat(64)
    assert.throws(() => verifyWorkOrder(order, config, new Date('2026-08-15T19:00:00.000Z')), /INVALID_AUTHORITY/)
  })
})
