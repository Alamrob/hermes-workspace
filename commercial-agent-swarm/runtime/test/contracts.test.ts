import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hashAction } from '../src/canonical.js'
import { ValidationError, validateWorkOrder } from '../src/work-orders.js'
import { validWorkOrder } from './fixtures.js'

describe('work-order contract', () => {
  it('rejects a payload missing required authority and policy fields', () => {
    assert.throws(
      () => validateWorkOrder({ mission_id: '123e4567-e89b-42d3-a456-426614174000' }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError)
        assert.ok(error.issues.includes('trace_id is required'))
        assert.ok(error.issues.includes('authority is required'))
        assert.ok(error.issues.includes('data_policy is required'))
        return true
      },
    )
  })

  it('accepts a complete schema-compatible work order', () => {
    assert.deepEqual(validateWorkOrder(validWorkOrder()), validWorkOrder())
  })

  it('rejects malformed identifiers, reversed timestamps, and unknown fields', () => {
    const invalid = {
      ...validWorkOrder(),
      mission_id: 'not-a-uuid',
      expires_at: '2026-08-15T18:00:00.000Z',
      unexpected: true,
    }

    assert.throws(
      () => validateWorkOrder(invalid),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError)
        assert.ok(error.issues.includes('mission_id must be a UUID'))
        assert.ok(error.issues.includes('expires_at must be after created_at'))
        assert.ok(error.issues.includes('unexpected is not allowed'))
        return true
      },
    )
  })

  it('rejects a metadata value that is not an object', () => {
    assert.throws(
      () => validateWorkOrder({ ...validWorkOrder(), metadata: ['a3_enabled'] }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError)
        assert.ok(error.issues.includes('metadata must be an object'))
        return true
      },
    )
  })
})

describe('canonical action hash', () => {
  it('produces the hand-checked SHA-256 for recursively sorted canonical JSON', () => {
    const first = { z: 1, nested: { b: true, a: 'x' }, list: [{ d: 4, c: 3 }] }
    const reordered = { list: [{ c: 3, d: 4 }], nested: { a: 'x', b: true }, z: 1 }

    assert.equal(
      hashAction(first),
      '108b2f0ab4a34ecea69221332c9599571ffab3f50eb80bd3453a48e16ee6798c',
    )
    assert.equal(hashAction(reordered), hashAction(first))
  })
})
