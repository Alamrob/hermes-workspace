export type KnownCrmSummaryReadModel = {
  status: 'known'
  connector: 'twenty'
  outbox: { pending: number; leased: number; confirmed: number; failed: number; outcomeUnknown: number }
  inboxCount: number
  entityLinkCount: number
  cursorCount: number
  lastSuccessfulSyncAt: string | null
  provenance: 'postgres'
}

export type DisabledCrmSummaryReadModel = {
  status: 'disabled'
  connector: 'twenty'
  outbox: null
  inboxCount: null
  entityLinkCount: null
  cursorCount: null
  lastSuccessfulSyncAt: null
  provenance: 'simulation-disabled'
}

export type CrmSummaryReadModel = KnownCrmSummaryReadModel | DisabledCrmSummaryReadModel

const SUMMARY_KEYS = [
  'status', 'connector', 'outbox', 'inboxCount', 'entityLinkCount',
  'cursorCount', 'lastSuccessfulSyncAt', 'provenance',
] as const
const OUTBOX_KEYS = ['pending', 'leased', 'confirmed', 'failed', 'outcomeUnknown'] as const

export function disabledCrmSummaryReadModel(): DisabledCrmSummaryReadModel {
  return {
    status: 'disabled', connector: 'twenty', outbox: null,
    inboxCount: null, entityLinkCount: null, cursorCount: null,
    lastSuccessfulSyncAt: null, provenance: 'simulation-disabled',
  }
}

export function validateCrmSummaryReadModel(value: unknown): CrmSummaryReadModel {
  try {
    const summary = object(value)
    exactKeys(summary, SUMMARY_KEYS)
    if (summary.connector !== 'twenty') throw new Error('connector')
    if (summary.status === 'disabled') {
      if (summary.outbox !== null || summary.inboxCount !== null || summary.entityLinkCount !== null ||
          summary.cursorCount !== null || summary.lastSuccessfulSyncAt !== null ||
          summary.provenance !== 'simulation-disabled') throw new Error('disabled')
      return value as DisabledCrmSummaryReadModel
    }
    if (summary.status !== 'known' || summary.provenance !== 'postgres') throw new Error('status')
    const outbox = object(summary.outbox)
    exactKeys(outbox, OUTBOX_KEYS)
    for (const key of OUTBOX_KEYS) if (!count(outbox[key])) throw new Error('outbox')
    for (const key of ['inboxCount', 'entityLinkCount', 'cursorCount'] as const)
      if (!count(summary[key])) throw new Error('count')
    if (summary.lastSuccessfulSyncAt !== null &&
        (typeof summary.lastSuccessfulSyncAt !== 'string' ||
         !Number.isFinite(Date.parse(summary.lastSuccessfulSyncAt)))) throw new Error('timestamp')
    return value as KnownCrmSummaryReadModel
  } catch {
    throw new Error('CRM_SUMMARY_RESULT_INVALID')
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error('keys')
}

function count(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
