import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { validateDraftReview } from '../src/draft-review.js'

const SHA = 'a'.repeat(64)

function review(): any {
  return {
    id: 'a2500000-0000-4500-8500-000000000053',
    missionId: '5f45d649-5527-5bdb-82fc-dd3c2315582f',
    predecessorMissionId: '6d08b421-69db-5c34-bdf7-601444f9e11b',
    projectId: 'proptimiza', offerId: 'operacion-sin-planillas', offerVersion: 'v1',
    title: 'Revisión interna', status: 'open', expectedItemCount: 3,
    completedItemCount: 0, acceptedCount: 0, revisedCount: 0, rejectedCount: 0,
    version: 0, internalReviewGate: 'pending', productionGate: 'blocked', externalActions: 0,
    reviewerId: null, completedAt: null, sourceArtifactSha256: SHA, qaArtifactSha256: SHA,
    predecessorArtifactSha256: SHA, predecessorQaArtifactSha256: SHA,
    items: [1,2,3].map((slot) => ({
      slot, companyName: `Cuenta ${slot}`, sourceUrl: `https://cuenta-${slot}.cl/`,
      evidenceBasis: 'Evidencia pública incompleta.', originalSubject: 'Borrador interno',
      originalBody: 'Hipótesis interna sin contacto.', sourceDraftSha256: String(slot).repeat(64),
      machineDecision: 'human_review_candidate', machineReason: 'Revisión humana obligatoria.', riskFlags: [],
      humanDecision: null, humanRationale: null, revisedSubject: null, revisedBody: null,
      approvalState: 'human_review_required', externalActionEligible: false, version: 0, updatedAt: null,
    })),
    provenance: { source: 'control-broker', sourceId: 'draft-review:a2500000-0000-4500-8500-000000000053', observedAt: '2026-08-28T12:00:00.000Z', synthetic: false },
  }
}

describe('internal draft review gate', () => {
  it('accepts only the closed three-item A2 projection with every external gate blocked', () => {
    const value = review()
    assert.equal(validateDraftReview(value).productionGate, 'blocked')
    for (const mutation of [
      { externalActions: 1 }, { productionGate: 'open' }, { expectedItemCount: 4 },
      { recipient: 'persona@example.com' },
    ]) assert.throws(() => validateDraftReview({ ...value, ...mutation }), /DRAFT_REVIEW_INVALID/)
    assert.throws(() => validateDraftReview({ ...value, items: value.items.slice(0,2) }), /DRAFT_REVIEW_INVALID/)
  })

  it('requires internally reviewed state for accepted/revised items and no revision on rejection', () => {
    const value = review()
    value.items[0] = { ...value.items[0], humanDecision: 'revised_internal', humanRationale: 'Corrección humana trazable.', revisedSubject: 'Borrador interno corregido', revisedBody: 'Hipótesis: Operación Sin Planillas desde CLP 1.800.000.', approvalState: 'internal_reviewed', version: 1, updatedAt: '2026-08-28T12:10:00.000Z' }
    value.completedItemCount = 1; value.revisedCount = 1; value.version = 1
    assert.equal(validateDraftReview(value).revisedCount, 1)
    assert.throws(() => validateDraftReview({ ...value, items: value.items.map((item: Record<string, unknown>,index: number) => index ? item : { ...item, externalActionEligible: true }) }), /DRAFT_REVIEW_INVALID/)
  })

  it('defines idempotent A2 commands and never creates approvals, recipients, mail, CRM, or external eligibility', async () => {
    const sql = await readFile(new URL('../migrations/024_draft_internal_review.sql', import.meta.url), 'utf8')
    assert.match(sql, /draft_review_commands/)
    assert.match(sql, /DRAFT_REVIEW_IDEMPOTENCY_CONFLICT/)
    assert.match(sql, /production_gate='blocked'/)
    assert.match(sql, /external_action_eligible=false/)
    assert.doesNotMatch(sql, /INSERT INTO\s+(?:control\.approvals|mail\.external_actions|integration\.crm_outbox)/i)
    assert.doesNotMatch(sql, /recipient|mail\.send|approval_token/i)
  })
})
