import { createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalJson } from './canonical.js'
import type { WorkOrder } from './work-orders.js'

export class AuthenticationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AuthenticationError' }
}

export interface WorkOrderAuthConfig { issuer: string; audience: string; keys: Record<string, string> }

export function signWorkOrder(workOrder: WorkOrder, secret: string): string {
  const authority = workOrder.authority as Record<string, unknown>
  const { signature: _signature, ...unsignedAuthority } = authority
  return createHmac('sha256', secret).update(canonicalJson({ ...workOrder, authority: unsignedAuthority })).digest('hex')
}

export function verifyWorkOrder(workOrder: WorkOrder, config: WorkOrderAuthConfig, now: Date): void {
  const authority = workOrder.authority
  if (!isRecord(authority)) throw new AuthenticationError('INVALID_AUTHORITY')
  const { issuer, audience, key_id: keyId, algorithm, signature } = authority
  if (issuer !== config.issuer || audience !== config.audience || algorithm !== 'HMAC-SHA256') throw new AuthenticationError('INVALID_AUTHORITY')
  if (workOrder.project_id !== 'proptimiza') throw new AuthenticationError('INVALID_PROJECT')
  if (typeof keyId !== 'string' || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) throw new AuthenticationError('INVALID_AUTHORITY')
  const secret = config.keys[keyId]
  if (!secret || Date.parse(workOrder.expires_at as string) <= now.getTime()) throw new AuthenticationError('EXPIRED_AUTHORITY')
  if (!safeEqual(signature, signWorkOrder(workOrder, secret))) throw new AuthenticationError('INVALID_SIGNATURE')
}

export function requireBearer(value: string | undefined, expected: string): void {
  const token = value?.match(/^Bearer ([^\s]+)$/)?.[1]
  if (!token || !safeEqual(token, expected)) throw new AuthenticationError('UNAUTHORIZED')
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
