import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

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
