import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('migration 028 Ed25519 A1 authority', () => {
  it('allows both signature formats but requires Ed25519 for public A1 work', async () => {
    const sql = await readFile(new URL('../migrations/028_ed25519_a1_work_orders.sql', import.meta.url), 'utf8')
    assert.match(sql, /authority_algorithm='HMAC-SHA256'/)
    assert.match(sql, /authority_algorithm='Ed25519'/)
    assert.match(sql, /authority_signature~'\^\[0-9a-f\]\{128\}\$'/)
    assert.match(sql, /A1_ED25519_SIGNATURE_REQUIRED/)
    assert.match(sql, /research\.public\.read/)
    assert.match(sql, /public_web/)
    assert.doesNotMatch(sql, /INSERT INTO\s+control\.missions\s*\([^)]*\)\s*SELECT/i)
  })

  it('blocks rollback once an Ed25519 mission exists', async () => {
    const sql = await readFile(new URL('../migrations/028_ed25519_a1_work_orders.rollback.sql', import.meta.url), 'utf8')
    assert.match(sql, /ROLLBACK_BLOCKED_ED25519_MISSIONS_EXIST/)
    assert.match(sql, /payload->'authority'->>'algorithm'='Ed25519'/)
  })
})
