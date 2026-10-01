import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { DeepReadonly } from './platform/types.js'
import type { ChatwootIncomingEvent } from './comms/chatwoot-webhook.js'

export type ReplyEventStatus =
  | 'pending'
  | 'model_running'
  | 'ready'
  | 'sending'
  | 'sent'
  | 'held'
  | 'failed'
  | 'uncertain'

export interface ReplyEventRecord {
  event_id: string
  semantic_sha256: string
  content_sha256: string
  account_id: string
  inbox_id: string
  conversation_id: string
  message_id: string
  trace_id: string
  occurred_at: string
  accepted_at: string
  updated_at: string
  status: ReplyEventStatus
  attempts: number
  response_sha256: string | null
  outbound_message_id: string | null
  handoff_reason: string | null
  stop_code: string | null
}
interface StoreFile {
  schema: 'proptimiza-whatsapp-reply-store.v1'
  revision: number
  events: Record<string, ReplyEventRecord>
}

const SHA = /^[0-9a-f]{64}$/
const EVENT = /^cw1_[0-9a-f]{64}$/
const DECIMAL = /^[1-9][0-9]{0,18}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STATUS = new Set<ReplyEventStatus>(['pending', 'model_running', 'ready', 'sending', 'sent', 'held', 'failed', 'uncertain'])

export class WhatsAppReplyStore {
  private state: StoreFile = { schema: 'proptimiza-whatsapp-reply-store.v1', revision: 0, events: {} }
  private serial = Promise.resolve()

  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {
    if (!isAbsolute(path)) throw new Error('WHATSAPP_STORE_PATH_INVALID')
  }

  async initialize(): Promise<void> {
    const root = dirname(this.path)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || (process.platform !== 'win32' && (rootStat.mode & 0o077) !== 0))
      throw new Error('WHATSAPP_STORE_ROOT_UNSAFE')
    try {
      const file = await lstat(this.path)
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 8_388_608
        || (process.platform !== 'win32' && (file.mode & 0o077) !== 0)) throw new Error('WHATSAPP_STORE_FILE_UNSAFE')
      this.state = validateStore(JSON.parse(await readFile(this.path, 'utf8')))
      let changed = false
      for (const record of Object.values(this.state.events)) {
        if (record.status === 'model_running') {
          record.status = 'uncertain'; record.stop_code = 'MODEL_RESULT_UNCERTAIN_AFTER_RESTART'; changed = true
        } else if (record.status === 'sending') {
          record.status = 'uncertain'; record.stop_code = 'SEND_RESULT_UNCERTAIN_AFTER_RESTART'; changed = true
        }
      }
      if (changed) await this.persist()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.persist()
    }
  }

  commit(event: DeepReadonly<ChatwootIncomingEvent>): Promise<{ event_id: string; outcome: 'inserted' | 'duplicate' }> {
    return this.exclusive(async () => {
      const existing = this.state.events[event.event_id]
      if (existing) {
        if (existing.semantic_sha256 !== event.semantic_sha256) throw new Error('WHATSAPP_EVENT_CONFLICT')
        return { event_id: event.event_id, outcome: 'duplicate' as const }
      }
      if (Object.keys(this.state.events).length >= 10_000) throw new Error('WHATSAPP_STORE_CAPACITY')
      const at = iso(this.now())
      this.state.events[event.event_id] = {
        event_id: event.event_id,
        semantic_sha256: event.semantic_sha256,
        content_sha256: digest(event.content.text),
        account_id: event.account_id,
        inbox_id: event.inbox_id,
        conversation_id: event.conversation_id,
        message_id: event.message_id,
        trace_id: event.trace_id,
        occurred_at: event.occurred_at,
        accepted_at: at,
        updated_at: at,
        status: 'pending',
        attempts: 0,
        response_sha256: null,
        outbound_message_id: null,
        handoff_reason: null,
        stop_code: null,
      }
      await this.persist()
      return { event_id: event.event_id, outcome: 'inserted' as const }
    })
  }

  async nextPending(): Promise<Readonly<ReplyEventRecord> | null> {
    return this.exclusive(async () => {
      const item = Object.values(this.state.events)
        .filter((entry) => entry.status === 'pending')
        .sort((a, b) => a.accepted_at.localeCompare(b.accepted_at) || a.event_id.localeCompare(b.event_id))[0]
      return item ? Object.freeze(structuredClone(item)) : null
    })
  }

  async get(eventId: string): Promise<Readonly<ReplyEventRecord> | null> {
    return this.exclusive(async () => {
      const item = this.state.events[eventId]
      return item ? Object.freeze(structuredClone(item)) : null
    })
  }

  async conversationHoldReason(conversationId: string): Promise<string | null> {
    return this.exclusive(async () => {
      if (!DECIMAL.test(conversationId)) throw new Error('WHATSAPP_CONVERSATION_ID_INVALID')
      const held = Object.values(this.state.events)
        .filter((entry) => entry.conversation_id === conversationId)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .find((entry) => (['sent', 'held'].includes(entry.status)
          && entry.handoff_reason !== null && entry.handoff_reason !== 'none')
          || (entry.status === 'held' && entry.stop_code === 'HUMAN_REPLY_OBSERVED'))
      return held ? (held.handoff_reason ?? held.stop_code ?? 'CONVERSATION_HELD') : null
    })
  }

  transition(eventId: string, expected: ReplyEventStatus, next: ReplyEventStatus, patch: Partial<Pick<ReplyEventRecord,
    'response_sha256' | 'outbound_message_id' | 'handoff_reason' | 'stop_code'>> = {}): Promise<Readonly<ReplyEventRecord>> {
    return this.exclusive(async () => {
      const record = this.state.events[eventId]
      if (!record || record.status !== expected || !STATUS.has(next)) throw new Error('WHATSAPP_STORE_TRANSITION_INVALID')
      if (patch.response_sha256 !== undefined && patch.response_sha256 !== null && !SHA.test(patch.response_sha256))
        throw new Error('WHATSAPP_STORE_TRANSITION_INVALID')
      if (patch.outbound_message_id !== undefined && patch.outbound_message_id !== null && !DECIMAL.test(patch.outbound_message_id))
        throw new Error('WHATSAPP_STORE_TRANSITION_INVALID')
      record.status = next
      record.updated_at = iso(this.now())
      record.attempts += next === 'model_running' || next === 'sending' ? 1 : 0
      Object.assign(record, patch)
      await this.persist()
      return Object.freeze(structuredClone(record))
    })
  }

  snapshot(): Readonly<{ revision: number; counts: Record<ReplyEventStatus, number>; pending: number }> {
    const counts = Object.fromEntries([...STATUS].map((status) => [status, 0])) as Record<ReplyEventStatus, number>
    for (const event of Object.values(this.state.events)) counts[event.status]++
    return Object.freeze({ revision: this.state.revision, counts: Object.freeze(counts), pending: counts.pending })
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const run = this.serial.then(action, action)
    this.serial = run.then(() => undefined, () => undefined)
    return run
  }

  private async persist(): Promise<void> {
    this.state.revision++
    const target = resolve(this.path)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(this.state), 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    try {
      await rename(temporary, target)
      await chmod(target, 0o600)
      // Windows does not permit fsync on directory handles. Production is
      // Linux, where syncing the containing directory completes the durable
      // rename protocol.
      if (process.platform !== 'win32') {
        const directory = await open(dirname(target), 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}

function validateStore(value: unknown): StoreFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WHATSAPP_STORE_INVALID')
  const input = value as Record<string, unknown>
  if (input.schema !== 'proptimiza-whatsapp-reply-store.v1' || !Number.isSafeInteger(input.revision)
    || Number(input.revision) < 0 || !input.events || typeof input.events !== 'object' || Array.isArray(input.events))
    throw new Error('WHATSAPP_STORE_INVALID')
  const events: Record<string, ReplyEventRecord> = {}
  for (const [key, raw] of Object.entries(input.events as Record<string, unknown>)) {
    if (!EVENT.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('WHATSAPP_STORE_INVALID')
    const event = raw as ReplyEventRecord
    if (event.event_id !== key || !SHA.test(event.semantic_sha256) || !SHA.test(event.content_sha256)
      || ![event.account_id, event.inbox_id, event.conversation_id, event.message_id].every((id) => DECIMAL.test(id))
      || !UUID.test(event.trace_id) || ![event.occurred_at, event.accepted_at, event.updated_at].every((at) => Number.isFinite(Date.parse(at)))
      || !STATUS.has(event.status) || !Number.isSafeInteger(event.attempts) || event.attempts < 0 || event.attempts > 8
      || (event.response_sha256 !== null && !SHA.test(event.response_sha256))
      || (event.outbound_message_id !== null && !DECIMAL.test(event.outbound_message_id))) throw new Error('WHATSAPP_STORE_INVALID')
    events[key] = structuredClone(event)
  }
  return { schema: 'proptimiza-whatsapp-reply-store.v1', revision: Number(input.revision), events }
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function iso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('WHATSAPP_STORE_CLOCK_INVALID')
  return value.toISOString()
}
