import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { ChatwootIncomingEvent } from './comms/chatwoot-webhook.js'
import type { DeepReadonly } from './platform/types.js'

export type SupervisedReviewStatus =
  | 'pending'
  | 'preparing'
  | 'writing'
  | 'labeling'
  | 'assigning'
  | 'staged'
  | 'held'
  | 'failed'
  | 'uncertain'

export interface SupervisedReviewRecord {
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
  status: SupervisedReviewStatus
  attempts: number
  review_note_sha256: string | null
  private_note_message_id: string | null
  handoff_reason: string | null
  operational_label: 'proptimiza-supervised-review' | 'proptimiza-human-handoff' | null
  owned_labels_sha256: string | null
  team_assigned: boolean | null
  stop_code: string | null
}

interface StoreFile {
  schema: 'proptimiza-supervised-review-store.v2'
  revision: number
  events: Record<string, SupervisedReviewRecord>
}

type TransitionPatch = Partial<Pick<SupervisedReviewRecord,
  'review_note_sha256' | 'private_note_message_id' | 'handoff_reason' | 'operational_label'
  | 'owned_labels_sha256' | 'team_assigned' | 'stop_code'>>

const SHA = /^[0-9a-f]{64}$/
const EVENT = /^cw1_[0-9a-f]{64}$/
const DECIMAL = /^[1-9][0-9]{0,18}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_:-]{1,127}$/
const STORE_FIELDS = ['schema', 'revision', 'events'] as const
const RECORD_FIELDS_V1 = [
  'event_id', 'semantic_sha256', 'content_sha256', 'account_id', 'inbox_id', 'conversation_id', 'message_id',
  'trace_id', 'occurred_at', 'accepted_at', 'updated_at', 'status', 'attempts', 'review_note_sha256',
  'private_note_message_id', 'handoff_reason', 'team_assigned', 'stop_code',
] as const
const RECORD_FIELDS = [...RECORD_FIELDS_V1, 'operational_label', 'owned_labels_sha256'] as const
const STATUS = new Set<SupervisedReviewStatus>([
  'pending', 'preparing', 'writing', 'labeling', 'assigning', 'staged', 'held', 'failed', 'uncertain',
])
const TRANSITIONS: Readonly<Record<SupervisedReviewStatus, ReadonlySet<SupervisedReviewStatus>>> = Object.freeze({
  pending: new Set<SupervisedReviewStatus>(['preparing', 'held']),
  preparing: new Set<SupervisedReviewStatus>(['writing', 'held', 'failed', 'uncertain']),
  writing: new Set<SupervisedReviewStatus>(['labeling', 'failed', 'uncertain']),
  labeling: new Set<SupervisedReviewStatus>(['assigning', 'staged', 'held', 'failed', 'uncertain']),
  assigning: new Set<SupervisedReviewStatus>(['staged', 'held', 'uncertain']),
  staged: new Set<SupervisedReviewStatus>(), held: new Set<SupervisedReviewStatus>(),
  failed: new Set<SupervisedReviewStatus>(), uncertain: new Set<SupervisedReviewStatus>(),
})

export class SupervisedReviewStore {
  private state: StoreFile = { schema: 'proptimiza-supervised-review-store.v2', revision: 0, events: {} }
  private serial = Promise.resolve()

  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {
    if (!isAbsolute(path)) throw new Error('SUPERVISED_REVIEW_STORE_PATH_INVALID')
  }

  async initialize(): Promise<void> {
    const root = dirname(this.path)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || (process.platform !== 'win32' && (rootStat.mode & 0o077) !== 0))
      throw new Error('SUPERVISED_REVIEW_STORE_ROOT_UNSAFE')
    try {
      const file = await lstat(this.path)
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 8_388_608
        || (process.platform !== 'win32' && (file.mode & 0o077) !== 0))
        throw new Error('SUPERVISED_REVIEW_STORE_FILE_UNSAFE')
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      const migrated = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (parsed as Record<string, unknown>).schema === 'proptimiza-supervised-review-store.v1')
      this.state = validateStore(parsed)
      let changed = migrated
      for (const record of Object.values(this.state.events)) {
        if (record.status === 'preparing') {
          record.status = 'uncertain'
          record.stop_code = 'PREPARATION_RESULT_UNCERTAIN_AFTER_RESTART'
          changed = true
        } else if (record.status === 'labeling') {
          record.status = 'uncertain'
          record.stop_code = 'CHATWOOT_LABEL_RESULT_UNCERTAIN_AFTER_RESTART'
          changed = true
        } else if (record.status === 'writing' || record.status === 'assigning') {
          record.status = 'uncertain'
          record.stop_code = 'CHATWOOT_REVIEW_RESULT_UNCERTAIN_AFTER_RESTART'
          changed = true
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
        if (existing.semantic_sha256 !== event.semantic_sha256) throw new Error('SUPERVISED_REVIEW_EVENT_CONFLICT')
        return { event_id: event.event_id, outcome: 'duplicate' as const }
      }
      if (Object.keys(this.state.events).length >= 10_000) throw new Error('SUPERVISED_REVIEW_STORE_CAPACITY')
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
        review_note_sha256: null,
        private_note_message_id: null,
        handoff_reason: null,
        operational_label: null,
        owned_labels_sha256: null,
        team_assigned: null,
        stop_code: null,
      }
      await this.persist()
      return { event_id: event.event_id, outcome: 'inserted' as const }
    })
  }

  nextPending(): Promise<Readonly<SupervisedReviewRecord> | null> {
    return this.exclusive(async () => {
      const item = Object.values(this.state.events)
        .filter(entry => entry.status === 'pending')
        .sort((a, b) => a.accepted_at.localeCompare(b.accepted_at) || a.event_id.localeCompare(b.event_id))[0]
      return item ? Object.freeze(structuredClone(item)) : null
    })
  }

  get(eventId: string): Promise<Readonly<SupervisedReviewRecord> | null> {
    return this.exclusive(async () => {
      const item = this.state.events[eventId]
      return item ? Object.freeze(structuredClone(item)) : null
    })
  }

  conversationHoldReason(conversationId: string): Promise<string | null> {
    return this.exclusive(async () => {
      if (!DECIMAL.test(conversationId)) throw new Error('SUPERVISED_REVIEW_CONVERSATION_ID_INVALID')
      const held = Object.values(this.state.events)
        .filter(entry => entry.conversation_id === conversationId)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .find(entry => (entry.status === 'staged' && entry.handoff_reason !== null && entry.handoff_reason !== 'none')
          || (entry.status === 'held' && ['HUMAN_REPLY_OBSERVED', 'HUMAN_HANDOFF_ASSIGNMENT_REJECTED']
            .some(code => entry.stop_code?.startsWith(code))))
      return held ? (held.handoff_reason ?? held.stop_code ?? 'CONVERSATION_REVIEW_HELD') : null
    })
  }

  transition(eventId: string, expected: SupervisedReviewStatus, next: SupervisedReviewStatus,
    patch: TransitionPatch = {}): Promise<Readonly<SupervisedReviewRecord>> {
    return this.exclusive(async () => {
      const record = this.state.events[eventId]
      if (!record || record.status !== expected || !STATUS.has(next) || !TRANSITIONS[expected].has(next))
        throw new Error('SUPERVISED_REVIEW_STORE_TRANSITION_INVALID')
      validatePatch(patch)
      record.status = next
      record.updated_at = iso(this.now())
      record.attempts += ['preparing', 'writing', 'labeling', 'assigning'].includes(next) ? 1 : 0
      Object.assign(record, patch)
      await this.persist()
      return Object.freeze(structuredClone(record))
    })
  }

  snapshot(): Readonly<{ revision: number; counts: Record<SupervisedReviewStatus, number>; pending: number }> {
    const counts = Object.fromEntries([...STATUS].map(status => [status, 0])) as Record<SupervisedReviewStatus, number>
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

function validatePatch(patch: TransitionPatch): void {
  if (patch.review_note_sha256 !== undefined && patch.review_note_sha256 !== null
    && !SHA.test(patch.review_note_sha256)) throw new Error('SUPERVISED_REVIEW_STORE_TRANSITION_INVALID')
  if (patch.private_note_message_id !== undefined && patch.private_note_message_id !== null
    && !DECIMAL.test(patch.private_note_message_id)) throw new Error('SUPERVISED_REVIEW_STORE_TRANSITION_INVALID')
  if (patch.handoff_reason !== undefined && patch.handoff_reason !== null
    && !IDENTIFIER.test(patch.handoff_reason)) throw new Error('SUPERVISED_REVIEW_STORE_TRANSITION_INVALID')
  if (patch.operational_label !== undefined && patch.operational_label !== null
    && !['proptimiza-supervised-review', 'proptimiza-human-handoff'].includes(patch.operational_label))
    throw new Error('SUPERVISED_REVIEW_STORE_TRANSITION_INVALID')
  if (patch.owned_labels_sha256 !== undefined && patch.owned_labels_sha256 !== null
    && !SHA.test(patch.owned_labels_sha256)) throw new Error('SUPERVISED_REVIEW_STORE_TRANSITION_INVALID')
  if (patch.team_assigned !== undefined && patch.team_assigned !== null
    && typeof patch.team_assigned !== 'boolean') throw new Error('SUPERVISED_REVIEW_STORE_TRANSITION_INVALID')
  if (patch.stop_code !== undefined && patch.stop_code !== null
    && !/^[A-Z][A-Z0-9_:-]{2,160}$/.test(patch.stop_code)) throw new Error('SUPERVISED_REVIEW_STORE_TRANSITION_INVALID')
}

function validateStore(value: unknown): StoreFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SUPERVISED_REVIEW_STORE_INVALID')
  const input = value as Record<string, unknown>
  const legacy = input.schema === 'proptimiza-supervised-review-store.v1'
  if (!hasExactKeys(input, STORE_FIELDS) || (!legacy && input.schema !== 'proptimiza-supervised-review-store.v2')
    || !Number.isSafeInteger(input.revision)
    || Number(input.revision) < 0 || !input.events || typeof input.events !== 'object' || Array.isArray(input.events))
    throw new Error('SUPERVISED_REVIEW_STORE_INVALID')
  const events: Record<string, SupervisedReviewRecord> = {}
  for (const [key, raw] of Object.entries(input.events as Record<string, unknown>)) {
    if (!EVENT.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)
      || !hasExactKeys(raw as Record<string, unknown>, legacy ? RECORD_FIELDS_V1 : RECORD_FIELDS))
      throw new Error('SUPERVISED_REVIEW_STORE_INVALID')
    const event = structuredClone(raw) as unknown as SupervisedReviewRecord
    if (legacy) {
      event.operational_label = null
      event.owned_labels_sha256 = null
    }
    if (event.event_id !== key || !SHA.test(event.semantic_sha256) || !SHA.test(event.content_sha256)
      || ![event.account_id, event.inbox_id, event.conversation_id, event.message_id].every(id => DECIMAL.test(id))
      || !UUID.test(event.trace_id) || ![event.occurred_at, event.accepted_at, event.updated_at]
        .every(at => Number.isFinite(Date.parse(at)))
      || !STATUS.has(event.status) || (legacy && event.status === 'labeling')
      || !Number.isSafeInteger(event.attempts) || event.attempts < 0 || event.attempts > (legacy ? 8 : 9)
      || (event.review_note_sha256 !== null && !SHA.test(event.review_note_sha256))
      || (event.private_note_message_id !== null && !DECIMAL.test(event.private_note_message_id))
      || (event.handoff_reason !== null && !IDENTIFIER.test(event.handoff_reason))
      || (event.operational_label !== null
        && !['proptimiza-supervised-review', 'proptimiza-human-handoff'].includes(event.operational_label))
      || (event.owned_labels_sha256 !== null && !SHA.test(event.owned_labels_sha256))
      || (event.team_assigned !== null && typeof event.team_assigned !== 'boolean')
      || (event.stop_code !== null && !/^[A-Z][A-Z0-9_:-]{2,160}$/.test(event.stop_code)))
      throw new Error('SUPERVISED_REVIEW_STORE_INVALID')
    events[key] = structuredClone(event)
  }
  return { schema: 'proptimiza-supervised-review-store.v2', revision: Number(input.revision), events }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function iso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('SUPERVISED_REVIEW_STORE_CLOCK_INVALID')
  return value.toISOString()
}
