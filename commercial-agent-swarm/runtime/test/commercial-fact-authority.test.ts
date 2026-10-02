import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatCommercialFactContext,
  parseCommercialFactCatalog,
  resolveCommercialFacts,
} from '../src/commercial-fact-authority.js'

const now = new Date('2026-10-02T12:00:00.000Z')

function catalog(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 'proptimiza-commercial-fact-catalog.v1',
    status: 'active',
    catalog_id: 'catalog:pilot:1',
    generated_at: '2026-10-02T11:00:00.000Z',
    expires_at: '2026-10-03T11:00:00.000Z',
    facts: [{
      id: 'fact:identity:1',
      category: 'identity',
      statement: 'Proptimiza realiza un diagnóstico antes de recomendar una solución.',
      source_ref: 'policy:commercial:approved:1',
      approved_by_role: 'commercial_owner',
      approved_at: '2026-10-02T10:00:00.000Z',
      expires_at: '2026-10-03T10:00:00.000Z',
    }],
    ...overrides,
  })
}

test('loads a bounded active catalog and resolves only exact approved facts', () => {
  const parsed = parseCommercialFactCatalog(catalog(), now)
  const resolved = resolveCommercialFacts(parsed, ['fact:identity:1'])
  assert.equal(resolved.length, 1)
  assert.match(formatCommercialFactContext(resolved), /^\[fact:identity:1\]/)
  assert.match(parsed.catalog_sha256, /^[a-f0-9]{64}$/)
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.facts) && Object.isFrozen(resolved))
})

test('rejects pending, expired and future catalogs', () => {
  assert.throws(() => parseCommercialFactCatalog(catalog({ status: 'pending_approval' }), now), /CATALOG_INVALID/)
  assert.throws(() => parseCommercialFactCatalog(catalog({ expires_at: '2026-10-02T11:59:59.000Z' }), now), /CATALOG_INVALID/)
  assert.throws(() => parseCommercialFactCatalog(catalog({ generated_at: '2026-10-02T12:00:01.000Z' }), now), /CATALOG_INVALID/)
})

test('rejects unapproved ids instead of returning a partial context', () => {
  const parsed = parseCommercialFactCatalog(catalog(), now)
  assert.throws(() => resolveCommercialFacts(parsed, ['fact:identity:1', 'fact:pricing:missing']), /NOT_AUTHORIZED/)
})

test('rejects duplicate facts, unknown fields and expired facts', () => {
  const baseFact = JSON.parse(catalog()).facts[0]
  assert.throws(() => parseCommercialFactCatalog(catalog({ facts: [baseFact, baseFact] }), now), /FACT_INVALID/)
  assert.throws(() => parseCommercialFactCatalog(catalog({ unexpected: true }), now), /CATALOG_INVALID/)
  assert.throws(() => parseCommercialFactCatalog(catalog({ facts: [{ ...baseFact, expires_at: '2026-10-02T11:00:00.000Z' }] }), now), /FACT_INVALID/)
})

test('rejects oversized input, control bytes and unsafe source references', () => {
  assert.throws(() => parseCommercialFactCatalog(' '.repeat(16385), now), /CATALOG_INVALID/)
  assert.throws(() => parseCommercialFactCatalog(`${catalog()}\0`, now), /CATALOG_INVALID/)
  const baseFact = JSON.parse(catalog()).facts[0]
  assert.throws(() => parseCommercialFactCatalog(catalog({ facts: [{ ...baseFact, source_ref: 'https://source/?token=secret' }] }), now), /FACT_INVALID/)
  assert.throws(() => parseCommercialFactCatalog(catalog({ facts: [{ ...baseFact, statement: 'Línea uno\nLínea dos' }] }), now), /FACT_INVALID/)
})
