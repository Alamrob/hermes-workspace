import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { applyMigrationPrefix } from './migration-prefix.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip
const versions = Array.from({ length: 22 }, (_, index) => {
  const names = [
    'runtime','commercial_control_plane','dispatch_queue','crm_integration','portfolio_read_models','sales_read_models','usage_budget_ledger','simulation_safety_seed','internal_automation','instruction_inbox','go_native_usage_ledger','dependency_terminalization','variable_usage_reservations','variable_usage_constraint','shadow_human_review','usage_source_not_null','external_action_kill_switch_projection','sales_mission_draft_projection','codex_instruction_review','internal_mail_attestation','commercial_policy_v2_draft','policy_human_review',
  ]
  return `${String(index + 1).padStart(3,'0')}_${names[index]}`
})

integration('PostgreSQL 17 policy human review ledger', () => {
  it('records independent immutable reviews while policy-v2 remains inactive', async () => {
    const admin = new Pool({ connectionString: ADMIN })
    const database = `policy_review_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!); url.pathname = `/${database}`
    const pool = new Pool({ connectionString: url.toString() })
    const digest = '888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19'
    const attestations = (competent: boolean) => ({ policy_digest_confirmed: true, no_activation_requested: true, review_scope_confirmed: true, control_set_confirmed: true, competent_human_confirmed: competent })
    const record = async (kind: string, key: string, competent: boolean) => {
      const rationale = kind === 'commercial' ? 'Confirmo oferta, precio, alcance, límites y promesas prohibidas.' : 'Confirmo revisión humana competente del alcance de privacidad y controles exigidos.'
      const requestHash = createHash('sha256').update(`${kind}:${key}`).digest('hex')
      return pool.query(`SELECT control.record_policy_human_review($1,'approved',$2,$3,$4,clock_timestamp(),$5,$6::jsonb,$7,$8) AS state`, [kind,rationale,'cloudflare-director-subject','proptimizaspa@gmail.com',digest,JSON.stringify(attestations(competent)),key,requestHash])
    }
    try {
      await applyMigrationPrefix(pool, versions)
      const initial = (await pool.query('SELECT control.build_policy_review_state() AS state')).rows[0].state
      assert.equal(initial.reviewCompleted, false)
      assert.equal(initial.activationCreated, false)
      assert.equal(initial.activePolicyVersion, 'policy-v1')
      assert.equal(initial.commercialReview, null)
      assert.equal(initial.privacyLegalReview, null)
      await assert.rejects(
        pool.query(`SELECT control.record_policy_human_review('commercial','approved',$1,$2,$3,clock_timestamp(),$4,$5::jsonb,$6,$7)`, ['Rationale with at least twenty characters.','subject','lamrobcompany@gmail.com',digest,JSON.stringify(attestations(false)),'policy-review:recovery-0001','a'.repeat(64)]),
        /POLICY_REVIEW_INVALID/,
      )
      const commercial = (await record('commercial','policy-review:commercial-0001',false)).rows[0].state
      assert.equal(commercial.commercialReview.decision, 'approved')
      assert.equal(commercial.reviewCompleted, false)
      assert.equal((await record('commercial','policy-review:commercial-0001',false)).rows[0].state.commercialReview.decision, 'approved')
      await assert.rejects(record('commercial','policy-review:commercial-0002',false), /POLICY_REVIEW_IMMUTABLE_CONFLICT/)
      await assert.rejects(pool.query(`UPDATE control.policy_human_reviews SET rationale='Changed rationale that is sufficiently long.' WHERE review_kind='commercial'`), /POLICY_HUMAN_REVIEW_IMMUTABLE/)
      const complete = (await record('privacy_legal','policy-review:privacy-0001',true)).rows[0].state
      assert.equal(complete.reviewCompleted, true)
      assert.equal(complete.effective, false)
      assert.equal(complete.externalContact, false)
      assert.equal(complete.activationCreated, false)
      assert.equal(complete.activePolicyVersion, 'policy-v1')
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM catalog.version_activations WHERE project_id='proptimiza' AND policy_version='policy-v2'`)).rows[0].count, 0)
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM mail.delivery_policies WHERE project_id='proptimiza' AND policy_version='policy-v2'`)).rows[0].count, 0)
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM mail.external_actions`)).rows[0].count, 0)
      await assert.rejects(pool.query(await readFile(new URL('../migrations/022_policy_human_review.rollback.sql', import.meta.url), 'utf8')), /POLICY_HUMAN_REVIEW_ROLLBACK_REQUIRES_EMPTY_LEDGER/)
    } finally {
      await pool.end()
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [database])
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      await admin.end()
    }
  })
})
