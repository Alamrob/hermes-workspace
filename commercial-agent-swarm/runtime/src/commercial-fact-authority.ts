import { createHash } from 'node:crypto'

const FACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/
const MAX_CATALOG_BYTES = 65536

export type CommercialFactCategory =
  | 'identity'
  | 'offer'
  | 'capability'
  | 'integration'
  | 'policy'
  | 'hours'
  | 'pricing'
  | 'result'

export interface CommercialFact {
  id: string
  category: CommercialFactCategory
  statement: string
  source_ref: string
  approved_by_role: 'commercial_owner' | 'operations' | 'security' | 'legal'
  approved_at: string
  expires_at: string
}

export interface CommercialFactCatalog {
  schema: 'proptimiza-commercial-fact-catalog.v1'
  status: 'active'
  catalog_id: string
  generated_at: string
  expires_at: string
  facts: readonly Readonly<CommercialFact>[]
  catalog_sha256: string
}

/**
 * Loads an explicitly approved, time-bounded fact catalog. The caller must
 * provide the bytes from an authorized read-only source; this module performs
 * no filesystem, network, model or secret access.
 */
export function parseCommercialFactCatalog(raw: string, now = new Date()): Readonly<CommercialFactCatalog> {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_CATALOG_BYTES || raw.includes('\0'))
    throw new Error('COMMERCIAL_FACT_CATALOG_INVALID')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('COMMERCIAL_FACT_CATALOG_INVALID') }
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'status', 'catalog_id', 'generated_at', 'expires_at', 'facts'])
    || value.schema !== 'proptimiza-commercial-fact-catalog.v1' || value.status !== 'active'
    || typeof value.catalog_id !== 'string' || !FACT_ID.test(value.catalog_id)
    || !isIsoInstant(value.generated_at) || !isIsoInstant(value.expires_at)
    || Date.parse(value.generated_at) > now.getTime() || Date.parse(value.expires_at) <= now.getTime()
    || !Array.isArray(value.facts) || value.facts.length < 1 || value.facts.length > 64)
    throw new Error('COMMERCIAL_FACT_CATALOG_INVALID')

  const ids = new Set<string>()
  const facts = value.facts.map(item => parseFact(item, now, ids))
  const catalog: CommercialFactCatalog = {
    schema: 'proptimiza-commercial-fact-catalog.v1',
    status: 'active',
    catalog_id: value.catalog_id,
    generated_at: value.generated_at,
    expires_at: value.expires_at,
    facts: Object.freeze(facts),
    catalog_sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
  }
  return deepFreeze(catalog)
}

/** Resolves every requested fact or fails closed; partial resolution is forbidden. */
export function resolveCommercialFacts(
  catalog: Readonly<CommercialFactCatalog>,
  requestedIds: readonly string[],
): readonly Readonly<CommercialFact>[] {
  if (!catalog || catalog.schema !== 'proptimiza-commercial-fact-catalog.v1' || catalog.status !== 'active'
    || !Array.isArray(requestedIds) || requestedIds.length > 24
    || new Set(requestedIds).size !== requestedIds.length || requestedIds.some(id => !FACT_ID.test(id)))
    throw new Error('COMMERCIAL_FACT_REQUEST_INVALID')
  const byId = new Map(catalog.facts.map(fact => [fact.id, fact]))
  const resolved = requestedIds.map(id => byId.get(id))
  if (resolved.some(fact => fact === undefined)) throw new Error('COMMERCIAL_FACT_NOT_AUTHORIZED')
  return Object.freeze(resolved as Readonly<CommercialFact>[])
}

/** Bounded context for a supervised model prompt; never includes approver identity or credentials. */
export function formatCommercialFactContext(facts: readonly Readonly<CommercialFact>[]): string {
  if (!Array.isArray(facts) || facts.length > 24) throw new Error('COMMERCIAL_FACT_REQUEST_INVALID')
  const lines = facts.map(fact => `[${fact.id}] (${fact.category}) ${fact.statement}`)
  const context = lines.join('\n')
  if (Buffer.byteLength(context, 'utf8') > 12000 || context.includes('\0'))
    throw new Error('COMMERCIAL_FACT_CONTEXT_TOO_LARGE')
  return context
}

function parseFact(value: unknown, now: Date, ids: Set<string>): Readonly<CommercialFact> {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'category', 'statement', 'source_ref', 'approved_by_role', 'approved_at', 'expires_at',
  ]) || typeof value.id !== 'string' || !FACT_ID.test(value.id) || ids.has(value.id)
    || !['identity', 'offer', 'capability', 'integration', 'policy', 'hours', 'pricing', 'result'].includes(String(value.category))
    || typeof value.statement !== 'string' || !value.statement.trim() || value.statement.length > 400 || value.statement.includes('\0')
    || typeof value.source_ref !== 'string' || !SOURCE_REF.test(value.source_ref)
    || !['commercial_owner', 'operations', 'security', 'legal'].includes(String(value.approved_by_role))
    || !isIsoInstant(value.approved_at) || !isIsoInstant(value.expires_at)
    || Date.parse(value.approved_at) > now.getTime() || Date.parse(value.expires_at) <= now.getTime())
    throw new Error('COMMERCIAL_FACT_INVALID')
  ids.add(value.id)
  return Object.freeze({
    id: value.id,
    category: value.category as CommercialFactCategory,
    statement: value.statement.trim(),
    source_ref: value.source_ref,
    approved_by_role: value.approved_by_role as CommercialFact['approved_by_role'],
    approved_at: value.approved_at,
    expires_at: value.expires_at,
  })
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const timestamp = Date.parse(value)
  const canonical = value.includes('.') ? value : value.replace(/Z$/, '.000Z')
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === canonical
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key)
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}
