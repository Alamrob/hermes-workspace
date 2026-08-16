export type CrmSummaryReadModel = {
  availability: 'available' | 'unavailable'
  accounts: number | null
  contacts: number | null
  opportunities: number | null
  pipelineUsd: number | null
  provenance: {
    source: 'twenty'
    sourceId: string
    observedAt: string
    synthetic: false
  }
  message?: string
}

const SUMMARY_KEYS = [
  'availability', 'accounts', 'contacts', 'opportunities', 'pipelineUsd',
  'provenance',
] as const

export function disabledCrmSummaryReadModel(
  observedAt = new Date().toISOString(),
): CrmSummaryReadModel {
  return {
    availability: 'unavailable',
    accounts: null,
    contacts: null,
    opportunities: null,
    pipelineUsd: null,
    message: 'CRM sync disabled',
    provenance: {
      source: 'twenty',
      sourceId: 'crm:simulation-disabled',
      observedAt,
      synthetic: false,
    },
  }
}

export function validateCrmSummaryReadModel(value: unknown): CrmSummaryReadModel {
  try {
    const summary = object(value)
    const expectedKeys = summary.message === undefined
      ? SUMMARY_KEYS
      : [...SUMMARY_KEYS, 'message']
    exactKeys(summary, expectedKeys)
    if (summary.availability !== 'available' && summary.availability !== 'unavailable')
      throw new Error('availability')
    if (summary.message !== undefined && typeof summary.message !== 'string')
      throw new Error('message')
    for (const key of ['accounts', 'contacts', 'opportunities'] as const)
      if (summary[key] !== null && !nonnegativeInteger(summary[key])) throw new Error(key)
    if (summary.pipelineUsd !== null &&
        (typeof summary.pipelineUsd !== 'number' || !Number.isFinite(summary.pipelineUsd) || summary.pipelineUsd < 0))
      throw new Error('pipeline')
    if (summary.availability === 'unavailable' &&
        (summary.accounts !== null || summary.contacts !== null ||
         summary.opportunities !== null || summary.pipelineUsd !== null))
      throw new Error('unavailable values')
    if (summary.availability === 'available' &&
        (summary.accounts === null || summary.contacts === null || summary.opportunities === null))
      throw new Error('available counts')
    const provenance = object(summary.provenance)
    exactKeys(provenance, ['source', 'sourceId', 'observedAt', 'synthetic'])
    if (provenance.source !== 'twenty' || typeof provenance.sourceId !== 'string' ||
        provenance.sourceId.length === 0 || typeof provenance.observedAt !== 'string' ||
        !Number.isFinite(Date.parse(provenance.observedAt)) || provenance.synthetic !== false)
      throw new Error('provenance')
    return value as CrmSummaryReadModel
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

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
