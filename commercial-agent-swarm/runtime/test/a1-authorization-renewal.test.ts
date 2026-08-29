import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('migration 029 append-only A1 authorization renewal', () => {
  it('removes one-per-review dead ends while serializing and preserving authorization history', async () => {
    const sql = await readFile(new URL('../migrations/029_a1_authorization_renewal.sql', import.meta.url), 'utf8')
    assert.match(sql, /DROP CONSTRAINT a1_research_authorizations_review_id_key/)
    assert.match(sql, /DROP CONSTRAINT a1_research_order_authorizations_review_id_key/)
    assert.match(sql, /supersedes_authorization_id uuid NULL/)
    assert.match(sql, /a1_research_authorizations_supersedes_key UNIQUE/)
    assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('a1-research-auth:review:'\|\|\$2::text,0\)\)/)
    assert.match(sql, /latest\.expires_at>now_at OR \$7<latest\.expires_at/)
    assert.match(sql, /A1_RESEARCH_AUTHORIZATION_ACTIVE_CONFLICT/)
    assert.match(sql, /WHEN authorization_row\.expires_at<=observed_at THEN 'authorization_expired'/)
    assert.match(sql, /ORDER BY reviewed_at DESC,created_at DESC,authorization_id DESC/)
    assert.match(sql, /mission\.payload#>>'\{metadata,a1_research_review_id\}'=\$2::text/)
    assert.doesNotMatch(sql, /INSERT INTO\s+control\.missions|enqueue_dispatch|mail\.send|request_approval/i)
  })

  it('allows rollback only before any renewal history exists', async () => {
    const rollback = await readFile(new URL('../migrations/029_a1_authorization_renewal.rollback.sql', import.meta.url), 'utf8')
    assert.match(rollback, /ROLLBACK_BLOCKED_A1_AUTHORIZATION_RENEWALS_EXIST/)
    assert.match(rollback, /supersedes_authorization_id IS NOT NULL/)
    assert.match(rollback, /GROUP BY review_id HAVING count\(\*\)>1/)
    assert.match(rollback, /ADD CONSTRAINT a1_research_authorizations_review_id_key UNIQUE/)
    assert.match(rollback, /ADD CONSTRAINT a1_research_order_authorizations_review_id_key UNIQUE/)
    assert.match(rollback, /DELETE FROM control\.schema_migrations WHERE version='029_a1_authorization_renewal'/)
  })
})
