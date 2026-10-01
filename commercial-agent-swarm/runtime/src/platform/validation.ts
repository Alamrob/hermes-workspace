import { canonicalJson } from '../canonical.js'

export class PlatformAdmissionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PlatformAdmissionError' }
}
export function deny(code: string): never { throw new PlatformAdmissionError(code) }

/** Reject accessors, prototypes, cycles and non-JSON values before snapshotting. */
export function snapshotJson(value: unknown, code: string): unknown {
  const ancestors = new Set<object>()
  function visit(entry: unknown, depth: number): void {
    if (depth > 64) deny(code)
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return
    if (typeof entry === 'number' && Number.isFinite(entry)) return
    if (typeof entry !== 'object' || entry === null || ancestors.has(entry)) deny(code)
    const array = Array.isArray(entry)
    const prototype = Object.getPrototypeOf(entry)
    if (!array && prototype !== Object.prototype && prototype !== null) deny(code)
    if (array && prototype !== Array.prototype) deny(code)
    ancestors.add(entry)
    const keys = Reflect.ownKeys(entry)
    if (array && keys.length !== entry.length + 1) deny(code)
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string') deny(code)
      const descriptor = Object.getOwnPropertyDescriptor(entry, key)!
      if (!descriptor.enumerable || !('value' in descriptor)) deny(code)
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) deny(code)
      visit(descriptor.value, depth + 1)
    }
    ancestors.delete(entry)
  }
  try {
    visit(value, 0)
    return JSON.parse(canonicalJson(value))
  } catch (error) {
    if (error instanceof PlatformAdmissionError) throw error
    deny(code)
  }
}

export function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freezeDeep(entry)
    Object.freeze(value)
  }
  return value
}

export function closed(value: unknown, fields: readonly string[], code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) deny(code)
  const object = value as Record<string, unknown>
  if (Object.keys(object).length !== fields.length || fields.some(field => !Object.hasOwn(object, field))) deny(code)
  return object
}
export const IDENTIFIER = /^[a-z][a-z0-9._-]{0,127}$/
export function string(value: unknown, code: string, pattern?: RegExp, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value || (pattern && !pattern.test(value))) deny(code)
}
export function list(value: unknown, code: string, minimum = 1): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 1024) deny(code)
}
export function strings(value: unknown, code: string, pattern?: RegExp, minimum = 0): asserts value is string[] {
  list(value, code, minimum)
  for (const entry of value) string(entry, code, pattern)
  if (new Set(value).size !== value.length) deny(code)
}
export function unique(value: string, seen: Set<string>, code: string): void {
  if (seen.has(value)) deny(code)
  seen.add(value)
}
