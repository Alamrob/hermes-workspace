import { createHash } from 'node:crypto'

function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    )
  }
  throw new TypeError('canonical JSON accepts only finite JSON values')
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function hashAction(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
