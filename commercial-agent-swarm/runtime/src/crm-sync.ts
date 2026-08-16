import { isAbsolute } from 'node:path'

export type CrmOperation = 'upsert_account' | 'upsert_contact' | 'append_note'
export type CrmStream = 'accounts' | 'contacts' | 'notes'
export type CrmRecordType = 'account' | 'contact' | 'note'

export interface CrmOutboxItem {
  outboxId: string
  connectorId: 'twenty'
  operation: CrmOperation
  payload: Record<string, unknown>
  sourceVersion: number
}

export interface CrmInboxEvent {
  remoteEventId: string
  recordType: CrmRecordType
  remoteRecordId: string
  remoteVersion: string
  payload: Record<string, unknown>
}

export interface CrmSyncStorePort {
  claim(workerId: string, leaseSeconds: number): Promise<CrmOutboxItem | null>
  complete(
    outboxId: string,
    workerId: string,
    remoteRecordId: string,
    remoteVersion: string,
  ): Promise<void>
  markOutcomeUnknown(
    outboxId: string,
    workerId: string,
    errorCode: 'TWENTY_OUTCOME_UNKNOWN',
  ): Promise<void>
  storeInbox(event: CrmInboxEvent): Promise<boolean>
  advanceCursor(
    connectorId: 'twenty',
    stream: CrmStream,
    expectedVersion: number,
    nextCursor: string,
  ): Promise<number>
}

export interface TwentyApplyRequest {
  idempotencyKey: string
  operation: CrmOperation
  payload: Record<string, unknown>
  sourceVersion: number
}

export interface TwentyClientPort {
  apply(
    request: TwentyApplyRequest,
  ): Promise<{ remoteRecordId: string; remoteVersion: string }>
  readChanges(request: {
    stream: CrmStream
    cursor: string | null
    limit: 10
  }): Promise<{ events: CrmInboxEvent[]; nextCursor: string }>
}

export interface TwentyClientConfig {
  apiBaseUrl: string
  tokenFile: string
}

export class TwentyOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TwentyOutcomeUnknownError'
  }
}

export function loadTwentyClientConfig(
  environment: Record<string, string | undefined>,
): TwentyClientConfig {
  const forbidden = Object.entries(environment).find(
    ([name, value]) =>
      value?.trim() &&
      (name === 'TWENTY_API_TOKEN' ||
        name === 'CUSTOM_API_KEY' ||
        /^(?:OPENAI|ANTHROPIC|HERMES|LLM)_/i.test(name)),
  )
  if (forbidden) throw new Error('CRM_SYNC_CREDENTIAL_BOUNDARY_INVALID')
  if (
    environment.NODE_ENV !== 'production' ||
    environment.CRM_SYNC_MODE !== 'simulation'
  )
    throw new Error('CRM_SYNC_MODE_INVALID')
  const base = environment.TWENTY_API_BASE_URL?.trim()
  const tokenFile = environment.TWENTY_API_TOKEN_FILE?.trim()
  let parsed: URL
  try {
    parsed = new URL(base ?? '')
  } catch {
    throw new Error('TWENTY_API_BASE_URL_INVALID')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  )
    throw new Error('TWENTY_API_BASE_URL_INVALID')
  if (
    !tokenFile ||
    !isAbsolute(tokenFile) ||
    !tokenFile.startsWith('/run/secrets/')
  )
    throw new Error('TWENTY_API_TOKEN_FILE_INVALID')
  return { apiBaseUrl: parsed.origin, tokenFile }
}

export async function runCrmSyncOnce(options: {
  workerId: string
  leaseSeconds: number
  store: CrmSyncStorePort
  client: TwentyClientPort
}): Promise<
  | { status: 'idle' }
  | { status: 'confirmed'; outboxId: string }
> {
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(options.workerId) ||
    !Number.isSafeInteger(options.leaseSeconds) ||
    options.leaseSeconds < 5 ||
    options.leaseSeconds > 300
  )
    throw new Error('INVALID_CRM_SYNC_WORKER')
  const item = await options.store.claim(options.workerId, options.leaseSeconds)
  if (!item) return { status: 'idle' }
  validateOutboxItem(item)
  try {
    const receipt = await options.client.apply({
      idempotencyKey: item.outboxId,
      operation: item.operation,
      payload: item.payload,
      sourceVersion: item.sourceVersion,
    })
    if (!bounded(receipt.remoteRecordId, 256) || !bounded(receipt.remoteVersion, 256))
      throw new TwentyOutcomeUnknownError('invalid Twenty receipt')
    await options.store.complete(
      item.outboxId,
      options.workerId,
      receipt.remoteRecordId,
      receipt.remoteVersion,
    )
    return { status: 'confirmed', outboxId: item.outboxId }
  } catch (error) {
    await options.store.markOutcomeUnknown(
      item.outboxId,
      options.workerId,
      'TWENTY_OUTCOME_UNKNOWN',
    )
    if (error instanceof TwentyOutcomeUnknownError)
      throw new Error('TWENTY_OUTCOME_UNKNOWN', { cause: error })
    throw new Error('TWENTY_OUTCOME_UNKNOWN', { cause: error })
  }
}

export async function syncTwentyInboundOnce(options: {
  stream: CrmStream
  cursor: { value: string | null; version: number }
  store: CrmSyncStorePort
  client: TwentyClientPort
}): Promise<{ stored: number; cursorVersion: number }> {
  if (
    !['accounts', 'contacts', 'notes'].includes(options.stream) ||
    !Number.isSafeInteger(options.cursor.version) ||
    options.cursor.version < 0 ||
    (options.cursor.value !== null && !bounded(options.cursor.value, 2048))
  )
    throw new Error('INVALID_CRM_CURSOR')
  const page = await options.client.readChanges({
    stream: options.stream,
    cursor: options.cursor.value,
    limit: 10,
  })
  validateChangePage(options.stream, page)
  let stored = 0
  for (const event of page.events)
    if (await options.store.storeInbox(event)) stored += 1
  const cursorVersion = await options.store.advanceCursor(
    'twenty',
    options.stream,
    options.cursor.version,
    page.nextCursor,
  )
  return { stored, cursorVersion }
}

function validateOutboxItem(item: CrmOutboxItem): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      item.outboxId,
    ) ||
    item.connectorId !== 'twenty' ||
    !['upsert_account', 'upsert_contact', 'append_note'].includes(item.operation) ||
    !isRecord(item.payload) ||
    !Number.isSafeInteger(item.sourceVersion) ||
    item.sourceVersion < 1
  )
    throw new Error('INVALID_CRM_OUTBOX_ITEM')
}

function validateChangePage(
  stream: CrmStream,
  page: { events: CrmInboxEvent[]; nextCursor: string },
): void {
  const expectedType: Record<CrmStream, CrmRecordType> = {
    accounts: 'account',
    contacts: 'contact',
    notes: 'note',
  }
  if (
    !Array.isArray(page.events) ||
    page.events.length > 10 ||
    !bounded(page.nextCursor, 2048) ||
    new Set(page.events.map((event) => event.remoteEventId)).size !==
      page.events.length ||
    page.events.some(
      (event) =>
        !isRecord(event) ||
        !bounded(event.remoteEventId, 256) ||
        event.recordType !== expectedType[stream] ||
        !bounded(event.remoteRecordId, 256) ||
        !bounded(event.remoteVersion, 256) ||
        !isRecord(event.payload),
    )
  )
    throw new Error('INVALID_TWENTY_CHANGE_PAGE')
}

function bounded(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= maximum
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
