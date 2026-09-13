import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto'
import { canonicalJson } from './canonical.js'
import type { A0BatchAuthorization } from './a0-behavior-batch-admission.js'

const KEY_ID = /^[A-Za-z0-9._:-]{8,128}$/
const SHA256 = /^[a-f0-9]{64}$/
const SIGNATURE = /^[a-f0-9]{128}$/
const MAX_WINDOW_MS = 30 * 60_000
const MAX_FUTURE_SKEW_MS = 30_000

export interface A0BatchAuthorizationAuthority {
  issuer: string
  audience: string
  key_id: string
  algorithm: 'Ed25519'
  signed_at: string
  signature: string
}

export interface Ed25519A0BatchAuthorizationVerifierOptions {
  issuer: string
  audience: string
  keyId: string
  publicKeyPem: string
  expectedPublicKeySha256: string
  now?: () => Date
}

/**
 * Public-key-only verifier for a single exact A0 batch authorization.
 * It has no signer, secret, persistence, network, provider, or retry capability.
 */
export class Ed25519A0BatchAuthorizationVerifier {
  private readonly issuer: string
  private readonly audience: string
  private readonly keyId: string
  private readonly publicKey: ReturnType<typeof createPublicKey>
  private readonly now: () => Date

  constructor(options: Ed25519A0BatchAuthorizationVerifierOptions) {
    if (
      !options ||
      typeof options.issuer !== 'string' ||
      options.issuer.length < 3 ||
      options.issuer.length > 128 ||
      typeof options.audience !== 'string' ||
      options.audience.length < 3 ||
      options.audience.length > 128 ||
      !KEY_ID.test(options.keyId) ||
      !SHA256.test(options.expectedPublicKeySha256) ||
      typeof options.publicKeyPem !== 'string'
    )
      throw new Error('A0_AUTHORIZATION_VERIFIER_CONFIGURATION_INVALID')
    try {
      const key = createPublicKey(options.publicKeyPem)
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('key type')
      const fingerprint = createHash('sha256')
        .update(key.export({ type: 'spki', format: 'der' }))
        .digest('hex')
      if (fingerprint !== options.expectedPublicKeySha256)
        throw new Error('key fingerprint')
      this.publicKey = key
    } catch {
      throw new Error('A0_AUTHORIZATION_VERIFIER_CONFIGURATION_INVALID')
    }
    this.issuer = options.issuer
    this.audience = options.audience
    this.keyId = options.keyId
    this.now = options.now ?? (() => new Date())
  }

  async verify(input: A0BatchAuthorization): Promise<boolean> {
    try {
      const authority = input.authority
      const signedAt = Date.parse(authority.signed_at)
      const expiresAt = Date.parse(input.expires_at)
      const now = this.now().getTime()
      if (
        authority.issuer !== this.issuer ||
        authority.audience !== this.audience ||
        authority.key_id !== this.keyId ||
        authority.algorithm !== 'Ed25519' ||
        !SIGNATURE.test(authority.signature) ||
        !Number.isFinite(signedAt) ||
        !Number.isFinite(expiresAt) ||
        new Date(signedAt).toISOString() !== authority.signed_at ||
        new Date(expiresAt).toISOString() !== input.expires_at ||
        signedAt > now + MAX_FUTURE_SKEW_MS ||
        expiresAt <= now ||
        expiresAt <= signedAt ||
        expiresAt - signedAt > MAX_WINDOW_MS
      )
        return false
      return verifySignature(
        null,
        canonicalA0BatchAuthorizationBytes(input),
        this.publicKey,
        Buffer.from(authority.signature, 'hex'),
      )
    } catch {
      return false
    }
  }
}

export function canonicalA0BatchAuthorizationBytes(
  input: A0BatchAuthorization,
): Buffer {
  const authority = input.authority
  const { signature: _signature, ...unsignedAuthority } = authority
  return Buffer.from(
    canonicalJson({ ...input, authority: unsignedAuthority }),
    'utf8',
  )
}
