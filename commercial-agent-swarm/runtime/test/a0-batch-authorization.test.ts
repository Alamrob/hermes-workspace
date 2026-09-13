import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import type { A0BatchAuthorization } from '../src/a0-behavior-batch-admission.js'
import {
  canonicalA0BatchAuthorizationBytes,
  Ed25519A0BatchAuthorizationVerifier,
} from '../src/a0-batch-authorization.js'

const NOW = new Date('2026-09-12T12:10:00.000Z')

function fixture() {
  const pair = generateKeyPairSync('ed25519')
  const publicKeyPem = pair.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString()
  const expectedPublicKeySha256 = createHash('sha256')
    .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
  const unsigned: A0BatchAuthorization = {
    type: 'commercial_swarm_a0_batch_authorization/v1',
    run_id: '123e4567-e89b-42d3-a456-426614174000',
    plan_sha256: 'a'.repeat(64),
    batch_id: 'a0:123e4567-e89b-42d3-a456-426614174000:t01',
    batch_sha256: 'b'.repeat(64),
    expires_at: '2026-09-12T12:25:00.000Z',
    authorization_granted: true,
    execution_authorized: true,
    provider_credit_spend_authorized: true,
    authority: {
      issuer: 'codex-auditor',
      audience: 'proptimiza-a0-batch-admission',
      key_id: 'codex-a0-ed25519-v1',
      algorithm: 'Ed25519',
      signed_at: '2026-09-12T12:05:00.000Z',
      signature: '0'.repeat(128),
    },
  }
  const signature = signBytes(
    null,
    canonicalA0BatchAuthorizationBytes(unsigned),
    pair.privateKey,
  ).toString('hex')
  const authorization = {
    ...unsigned,
    authority: { ...unsigned.authority, signature },
  }
  return {
    authorization,
    verifier: new Ed25519A0BatchAuthorizationVerifier({
      issuer: 'codex-auditor',
      audience: 'proptimiza-a0-batch-admission',
      keyId: 'codex-a0-ed25519-v1',
      publicKeyPem,
      expectedPublicKeySha256,
      now: () => NOW,
    }),
    publicKeyPem,
    expectedPublicKeySha256,
  }
}

describe('Ed25519 A0 batch authorization', () => {
  it('accepts only the exact signed batch authorization', async () => {
    const { authorization, verifier } = fixture()
    assert.equal(await verifier.verify(authorization), true)
    assert.equal(
      await verifier.verify({ ...authorization, batch_sha256: 'c'.repeat(64) }),
      false,
    )
    assert.equal(
      await verifier.verify({
        ...authorization,
        authority: { ...authorization.authority, key_id: 'unknown-key-v1' },
      }),
      false,
    )
  })

  it('rejects expired, overlong, future, or malformed signatures', async () => {
    const { authorization, verifier } = fixture()
    for (const candidate of [
      { ...authorization, expires_at: '2026-09-12T12:09:59.000Z' },
      {
        ...authorization,
        expires_at: '2026-09-12T12:45:00.001Z',
      },
      {
        ...authorization,
        authority: {
          ...authorization.authority,
          signed_at: '2026-09-12T12:10:31.000Z',
        },
      },
      {
        ...authorization,
        authority: { ...authorization.authority, signature: '00' },
      },
    ])
      assert.equal(await verifier.verify(candidate as A0BatchAuthorization), false)
  })

  it('pins the exact Ed25519 public key fingerprint', () => {
    const { publicKeyPem } = fixture()
    assert.throws(
      () =>
        new Ed25519A0BatchAuthorizationVerifier({
          issuer: 'codex-auditor',
          audience: 'proptimiza-a0-batch-admission',
          keyId: 'codex-a0-ed25519-v1',
          publicKeyPem,
          expectedPublicKeySha256: 'f'.repeat(64),
        }),
      /A0_AUTHORIZATION_VERIFIER_CONFIGURATION_INVALID/,
    )
  })

  it('publishes a closed JSON Schema matching the signed authority envelope', async () => {
    const schema = JSON.parse(
      await readFile(
        new URL(
          '../../contracts/commercial-swarm-a0-batch-authorization.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.properties.authority.required, [
      'issuer',
      'audience',
      'key_id',
      'algorithm',
      'signed_at',
      'signature',
    ])
    assert.equal(schema.properties.authority.properties.algorithm.const, 'Ed25519')
    assert.equal(schema.properties.authority.properties.signature.pattern, '^[a-f0-9]{128}$')
  })
})
