import { createHash } from 'node:crypto'
import type {
  CrmOperation,
  CrmRecordType,
  CrmStream,
  TwentyApplyRequest,
  TwentyClientPort,
} from './crm-sync.js'

const MAX_BODY_BYTES = 1_048_576
const OBJECT_KEYS = [
  'PilotTarget',
  'companies',
  'people',
  'opportunities',
  'notes',
] as const
type ObjectKey = (typeof OBJECT_KEYS)[number]

interface ObjectMapping {
  path: string
  recordsField: string
  idField: string
  updatedAtField: string
  initialCursor: string
  cursorQueryParameter: string
  limitQueryParameter: string
  sortQueryParameter: string
  sortQueryValue: string
  fields: Record<string, string>
}

export interface TwentyRestMapping {
  version: string
  objects: Record<ObjectKey, ObjectMapping>
}

export function parseTwentyRestMapping(document: string): TwentyRestMapping {
  if (Buffer.byteLength(document) > MAX_BODY_BYTES)
    throw new Error('TWENTY_MAPPING_INVALID')
  let parsed: unknown
  try {
    parsed = JSON.parse(document)
  } catch {
    throw new Error('TWENTY_MAPPING_INVALID')
  }
  if (!isRecord(parsed) || !exactKeys(parsed, ['version', 'objects']))
    throw new Error('TWENTY_MAPPING_INVALID')
  if (!safeName(parsed.version, 128) || !isRecord(parsed.objects))
    throw new Error('TWENTY_MAPPING_INVALID')
  const objectDocument = parsed.objects as Record<string, unknown>
  if (!exactKeys(objectDocument, [...OBJECT_KEYS]))
    throw new Error('TWENTY_MAPPING_INVALID')
  const objects = Object.fromEntries(
    OBJECT_KEYS.map((key) => [key, parseObjectMapping(objectDocument[key])]),
  ) as Record<ObjectKey, ObjectMapping>
  return { version: parsed.version, objects }
}

function parseObjectMapping(value: unknown): ObjectMapping {
  const keys = [
    'path', 'records_field', 'id_field', 'updated_at_field', 'initial_cursor',
    'cursor_query_parameter', 'limit_query_parameter', 'sort_query_parameter',
    'sort_query_value', 'fields',
  ]
  if (!isRecord(value) || !exactKeys(value, keys) || !isRecord(value.fields))
    throw new Error('TWENTY_MAPPING_INVALID')
  const path = value.path
  if (
    typeof path !== 'string' ||
    !/^\/rest\/[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(path) ||
    path.toLowerCase().includes('changes') ||
    !safeName(value.records_field, 64) ||
    !safeName(value.id_field, 64) ||
    !safeName(value.updated_at_field, 64) ||
    typeof value.initial_cursor !== 'string' ||
    !Number.isFinite(Date.parse(value.initial_cursor)) ||
    !safeQueryName(value.cursor_query_parameter) ||
    !safeQueryName(value.limit_query_parameter) ||
    !safeQueryName(value.sort_query_parameter) ||
    !safeName(value.sort_query_value, 64)
  )
    throw new Error('TWENTY_MAPPING_INVALID')
  const entries = Object.entries(value.fields)
  if (
    entries.length === 0 ||
    entries.length > 64 ||
    entries.some(([local, remote]) => !safeName(local, 64) || !safeName(remote, 64)) ||
    new Set(entries.map(([, remote]) => remote)).size !== entries.length
  )
    throw new Error('TWENTY_MAPPING_INVALID')
  return {
    path,
    recordsField: value.records_field,
    idField: value.id_field,
    updatedAtField: value.updated_at_field,
    initialCursor: new Date(value.initial_cursor).toISOString(),
    cursorQueryParameter: value.cursor_query_parameter,
    limitQueryParameter: value.limit_query_parameter,
    sortQueryParameter: value.sort_query_parameter,
    sortQueryValue: value.sort_query_value,
    fields: Object.fromEntries(entries) as Record<string, string>,
  }
}

export class TwentyHttpClient implements TwentyClientPort {
  private readonly origin: string
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch

  constructor(
    private readonly options: {
      apiBaseUrl: string
      token: string
      mapping: TwentyRestMapping
      fetch?: typeof fetch
      timeoutMs?: number
    },
  ) {
    let base: URL
    try { base = new URL(options.apiBaseUrl) } catch { throw new Error('TWENTY_ORIGIN_INVALID') }
    if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password)
      throw new Error('TWENTY_ORIGIN_INVALID')
    if (!options.token.trim() || Buffer.byteLength(options.token) > 8192)
      throw new Error('TWENTY_TOKEN_INVALID')
    this.origin = base.origin
    this.timeoutMs = options.timeoutMs ?? 5_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000)
      throw new Error('TWENTY_TIMEOUT_INVALID')
    this.fetcher = options.fetch ?? fetch
  }

  async apply(request: TwentyApplyRequest): Promise<{ remoteRecordId: string; remoteVersion: string }> {
    const mapping = this.mappingForOperation(request.operation)
    if (!isRecord(request.payload) || !safeName(request.idempotencyKey, 256))
      throw new Error('TWENTY_REQUEST_INVALID')
    const body: Record<string, unknown> = {}
    for (const [local, value] of Object.entries(request.payload)) {
      const remote = mapping.fields[local]
      if (!remote) throw new Error('TWENTY_REQUEST_INVALID')
      body[remote] = value
    }
    const response = await this.request(mapping.path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
        'idempotency-key': request.idempotencyKey,
      },
      body: JSON.stringify(body),
    })
    if (!isRecord(response) || !exactKeys(response, ['data']) || !isRecord(response.data))
      throw new Error('TWENTY_RESPONSE_INVALID')
    const data = response.data
    if (!exactKeys(data, [mapping.idField, mapping.updatedAtField]))
      throw new Error('TWENTY_RESPONSE_INVALID')
    const id = data[mapping.idField]
    const version = data[mapping.updatedAtField]
    if (!safeName(id, 256) || typeof version !== 'string' || !Number.isFinite(Date.parse(version)))
      throw new Error('TWENTY_RESPONSE_INVALID')
    return { remoteRecordId: id, remoteVersion: new Date(version).toISOString() }
  }

  async readChanges(request: { stream: CrmStream; cursor: string | null; limit: 10 }) {
    const { key, recordType } = streamObject(request.stream)
    const mapping = this.options.mapping.objects[key]
    const url = new URL(mapping.path, `${this.origin}/`)
    url.searchParams.set(mapping.cursorQueryParameter, request.cursor ?? mapping.initialCursor)
    url.searchParams.set(mapping.limitQueryParameter, '10')
    url.searchParams.set(mapping.sortQueryParameter, mapping.sortQueryValue)
    const response = await this.request(`${url.pathname}${url.search}`, {
      method: 'GET', headers: { authorization: `Bearer ${this.options.token}` },
    })
    if (!isRecord(response) || !exactKeys(response, [mapping.recordsField]) || !Array.isArray(response[mapping.recordsField]))
      throw new Error('TWENTY_RESPONSE_INVALID')
    const records = response[mapping.recordsField] as unknown[]
    if (records.length > 10) throw new Error('TWENTY_RESPONSE_INVALID')
    const allowedRemote = new Set([mapping.idField, mapping.updatedAtField, ...Object.values(mapping.fields)])
    const reverse = new Map(Object.entries(mapping.fields).map(([local, remote]) => [remote, local]))
    const events = records.map((candidate) => {
      if (!isRecord(candidate) || Object.keys(candidate).some((field) => !allowedRemote.has(field)))
        throw new Error('TWENTY_RESPONSE_INVALID')
      const id = candidate[mapping.idField]
      const updatedAt = candidate[mapping.updatedAtField]
      if (!safeName(id, 256) || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt)))
        throw new Error('TWENTY_RESPONSE_INVALID')
      const version = new Date(updatedAt).toISOString()
      const payload: Record<string, unknown> = {}
      for (const [remote, local] of reverse)
        if (remote in candidate) payload[local] = candidate[remote]
      return {
        remoteEventId: createHash('sha256').update(`${request.stream}\0${id}\0${version}`).digest('hex'),
        recordType,
        remoteRecordId: id,
        remoteVersion: version,
        payload,
      }
    })
    const nextCursor = events.reduce(
      (latest, event) => event.remoteVersion > latest ? event.remoteVersion : latest,
      request.cursor ?? mapping.initialCursor,
    )
    return { events, nextCursor }
  }

  private mappingForOperation(operation: CrmOperation): ObjectMapping {
    const key: Record<CrmOperation, ObjectKey> = {
      mirror_pilot_target: 'PilotTarget', upsert_account: 'companies',
      upsert_contact: 'people', append_note: 'notes',
    }
    return this.options.mapping.objects[key[operation]]
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const url = new URL(path, `${this.origin}/`)
    if (url.origin !== this.origin) throw new Error('TWENTY_ORIGIN_INVALID')
    let response: Response
    try {
      response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (error) {
      throw new Error('TWENTY_RESPONSE_INVALID', { cause: error })
    }
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
      throw new Error('TWENTY_RESPONSE_INVALID')
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      throw new Error('TWENTY_BODY_INVALID')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_BODY_BYTES) throw new Error('TWENTY_BODY_INVALID')
    try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error('TWENTY_RESPONSE_INVALID') }
  }
}

function streamObject(stream: CrmStream): { key: ObjectKey; recordType: CrmRecordType } {
  const map: Record<CrmStream, { key: ObjectKey; recordType: CrmRecordType }> = {
    pilot_targets: { key: 'PilotTarget', recordType: 'pilot_target' },
    accounts: { key: 'companies', recordType: 'account' },
    contacts: { key: 'people', recordType: 'contact' },
    opportunities: { key: 'opportunities', recordType: 'opportunity' },
    notes: { key: 'notes', recordType: 'note' },
  }
  return map[stream]
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}
function safeName(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:@-]+$/.test(value) && Buffer.byteLength(value) <= maximum
}
function safeQueryName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.\[\]-]{0,127}$/.test(value)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
