import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('sales mission draft projection migration', () => {
  it('projects only current Proptimiza Sales drafts for the approved offer', async () => {
    const sql = await readFile(
      new URL('../migrations/018_sales_mission_draft_projection.sql', import.meta.url),
      'utf8',
    )
    assert.match(sql, /source='sales'/)
    assert.match(sql, /project_id='proptimiza'/)
    assert.match(sql, /metadata->>'offer_id'='operacion-sin-planillas'/)
    assert.match(sql, /expires_at>statement_timestamp\(\)/)
  })

  it('restores the preceding projection on rollback', async () => {
    const rollback = await readFile(
      new URL('../migrations/018_sales_mission_draft_projection.rollback.sql', import.meta.url),
      'utf8',
    )
    const previous = await readFile(
      new URL('../migrations/017_external_action_kill_switch_projection.sql', import.meta.url),
      'utf8',
    )
    assert.equal(rollback, previous)
  })
})
