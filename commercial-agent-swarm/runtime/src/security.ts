import {
  createHash,
  createHmac,
  sign as createSignature,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import { canonicalJson } from './canonical.js'
import type { WorkOrder } from './work-orders.js'

export class AuthenticationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AuthenticationError' }
}

export interface WorkOrderAuthConfig {
  issuer: string
  audience: string
  /** Legacy symmetric keys retained for internal A0/A2 and the archived mail test. */
  keys: Record<string, string>
  /** Public verification material only. Private Ed25519 keys must never reach Hermes or the VPS. */
  ed25519PublicKeys?: Record<string, string>
}

export function signWorkOrder(workOrder: WorkOrder, secret: string): string {
  const authority = workOrder.authority as Record<string, unknown>
  const { signature: _signature, ...unsignedAuthority } = authority
  return createHmac('sha256', secret).update(canonicalJson({ ...workOrder, authority: unsignedAuthority })).digest('hex')
}

export function signWorkOrderEd25519(workOrder: WorkOrder, privateKeyPem: string): string {
  return createSignature(null, canonicalWorkOrderBytes(workOrder), privateKeyPem).toString('hex')
}

export function verifyWorkOrder(workOrder: WorkOrder, config: WorkOrderAuthConfig, now: Date): void {
  const authority = workOrder.authority
  if (!isRecord(authority)) throw new AuthenticationError('INVALID_AUTHORITY')
  const { issuer, audience, key_id: keyId, algorithm, signature } = authority
  if (issuer !== config.issuer || audience !== config.audience) throw new AuthenticationError('INVALID_AUTHORITY')
  if (workOrder.project_id !== 'proptimiza') throw new AuthenticationError('INVALID_PROJECT')
  if (typeof keyId !== 'string' || typeof signature !== 'string') throw new AuthenticationError('INVALID_AUTHORITY')
  if (Date.parse(workOrder.created_at as string) > now.getTime()) throw new AuthenticationError('AUTHORITY_NOT_YET_VALID')
  if (Date.parse(workOrder.expires_at as string) <= now.getTime()) throw new AuthenticationError('EXPIRED_AUTHORITY')
  if (algorithm === 'HMAC-SHA256') {
    if (!/^[0-9a-f]{64}$/.test(signature)) throw new AuthenticationError('INVALID_AUTHORITY')
    const secret = config.keys[keyId]
    if (!secret) throw new AuthenticationError('INVALID_AUTHORITY')
    if (!constantTimeSecretEqual(signature, signWorkOrder(workOrder, secret))) throw new AuthenticationError('INVALID_SIGNATURE')
    return
  }
  if (algorithm === 'Ed25519') {
    if (!/^[0-9a-f]{128}$/.test(signature)) throw new AuthenticationError('INVALID_AUTHORITY')
    const publicKey = config.ed25519PublicKeys?.[keyId]
    if (!publicKey) throw new AuthenticationError('INVALID_AUTHORITY')
    try {
      if (!verifySignature(null, canonicalWorkOrderBytes(workOrder), publicKey, Buffer.from(signature, 'hex')))
        throw new AuthenticationError('INVALID_SIGNATURE')
    } catch (error) {
      if (error instanceof AuthenticationError) throw error
      throw new AuthenticationError('INVALID_AUTHORITY')
    }
    return
  }
  throw new AuthenticationError('INVALID_AUTHORITY')
}

function canonicalWorkOrderBytes(workOrder: WorkOrder): Buffer {
  const authority = workOrder.authority as Record<string, unknown>
  const { signature: _signature, ...unsignedAuthority } = authority
  return Buffer.from(canonicalJson({ ...workOrder, authority: unsignedAuthority }), 'utf8')
}

export function requireBearer(value: string | undefined, expected: string): void {
  const token = value?.match(/^Bearer ([^\s]+)$/)?.[1]
  if (!token || !constantTimeSecretEqual(token, expected)) throw new AuthenticationError('UNAUTHORIZED')
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export function digestSecretForComparison(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function constantTimeSecretEqual(left: string, right: string): boolean {
  return timingSafeEqual(digestSecretForComparison(left), digestSecretForComparison(right))
}
