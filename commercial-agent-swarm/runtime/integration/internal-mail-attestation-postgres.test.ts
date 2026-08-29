import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { dropTestDatabase } from './database-cleanup.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip
const versions = [
  '001_runtime',
  '002_commercial_control_plane',
  '003_dispatch_queue',
  '004_crm_integration',
  '005_portfolio_read_models',
  '006_sales_read_models',
  '007_usage_budget_ledger',
  '008_simulation_safety_seed',
  '009_internal_automation',
  '010_instruction_inbox',
  '011_go_native_usage_ledger',
  '012_dependency_terminalization',
  '013_variable_usage_reservations',
  '014_variable_usage_constraint',
  '015_shadow_human_review',
  '016_usage_source_not_null',
  '017_external_action_kill_switch_projection',
  '018_sales_mission_draft_projection',
  '019_codex_instruction_review',
  '020_internal_mail_attestation',
  '021_commercial_policy_v2_draft',
  '022_policy_human_review',
  '023_policy_activation_dossier',
  '024_draft_internal_review',
  '025_a1_research_dossier',
  '026_a1_research_authorization',
  '027_a1_research_order_authorization',
  '028_ed25519_a1_work_orders',
  '029_a1_authorization_renewal',
  '030_a1_dispatch_authorization',
  '031_a1_assignment_enqueue_authorization',
  '032_a1_assignment_execution_authorization',
]

integration('PostgreSQL 17 internal-mail attestation ledger', () => {
  it('attests one evidence-bound internal round trip only after external actions are reblocked', async () => {
    const admin = new Pool({ connectionString: ADMIN })
    const database = `internal_mail_attestation_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    const pool = new Pool({ connectionString: url.toString() })
    try {
      await runVersionedMigrations(pool, await Promise.all(versions.map(async (version) => ({
        version,
        sql: await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8'),
      }))))

      const missionId = randomUUID()
      const approvalId = randomUUID()
      const attestationId = randomUUID()
      const actionHash = 'b'.repeat(64)
      const evidenceHash = 'a'.repeat(64)
      const idempotencyKey = 'internal-mail-0001'
      const action = {
        mission_id: missionId,
        project_id: 'proptimiza',
        project_version: 'v1',
        action_type: 'mail.send',
        channel: 'email',
        sender: 'ventas@proptimiza.com',
        recipients: ['contacto@proptimiza.com'],
        subject: 'Prueba interna',
        content: 'Mensaje controlado',
        content_version: 'v1',
        volume: 1,
        offer_version: 'offer-v1',
        policy_version: 'policy-v1',
        idempotency_key: idempotencyKey,
      }
      await pool.query(
        `INSERT INTO control.missions(mission_id,idempotency_key,payload)
         VALUES($1,'internal-mail-mission',jsonb_build_object(
           'project_id','proptimiza','autonomy_level','A3','a3_enabled',true
         ))`,
        [missionId],
      )
      await pool.query(
        `INSERT INTO control.approvals(
           approval_id,action,action_hash,requested_at,status,approved_by,
           expires_at,nonce,token,consumed_at
         ) VALUES($1,$2,$3,clock_timestamp()-interval '3 minutes','approved',
           'director@example.test',clock_timestamp()+interval '20 minutes',
           'nonce-internal-mail','APPROVAL::internal-mail',clock_timestamp()-interval '2 minutes')`,
        [approvalId, action, actionHash],
      )
      await pool.query(
        `INSERT INTO control.approval_channel_evidence(
           approval_id,action_hash,channel,decision,actor_id,decided_at
         ) VALUES($1,$2,'sales','approved','director@example.test',
           clock_timestamp()-interval '2 minutes')`,
        [approvalId, actionHash],
      )
      await pool.query(
        `INSERT INTO mail.external_actions(
           mission_id,idempotency_key,action_hash,channel,claimed_at,
           receipt_id,approval_id,completed_at
         ) VALUES($1,$2,$3,'email',clock_timestamp()-interval '2 minutes',
           'hostinger:test-receipt',$4,clock_timestamp()-interval '90 seconds')`,
        [missionId, idempotencyKey, actionHash, approvalId],
      )
      await pool.query(
        `INSERT INTO mail.webhook_events(
           mailbox_key,provider_event_id,received_at,trust_classification,
           instruction_eligible,untrusted_payload
         ) VALUES('contacto','event-internal-reply',clock_timestamp()-interval '30 seconds',
           'untrusted_external',false,'{"payload_sha256":"test"}'::jsonb)`,
      )

      assert.equal((await pool.query(
        `SELECT has_function_privilege(
           'commercial_safety_operator',
           'mail.attest_internal_mail_test(uuid,text,uuid,text,uuid,text,text,text)',
           'EXECUTE'
         ) AS allowed`,
      )).rows[0].allowed, true)
      assert.equal((await pool.query(
        `SELECT has_function_privilege(
           'commercial_runtime',
           'mail.attest_internal_mail_test(uuid,text,uuid,text,uuid,text,text,text)',
           'EXECUTE'
         ) AS allowed`,
      )).rows[0].allowed, false)

      await pool.query(`UPDATE control.kill_switches SET active=false WHERE (scope='global' AND scope_id='*') OR (scope='channel' AND scope_id='email')`)
      await pool.query(`SET ROLE commercial_safety_operator`)
      await assert.rejects(
        pool.query(
          `SELECT mail.attest_internal_mail_test($1,'proptimiza',$2,$3,$4,
             'contacto','event-internal-reply',$5)`,
          [attestationId, missionId, idempotencyKey, approvalId, evidenceHash],
        ),
        /EXTERNAL_ACTIONS_NOT_BLOCKED/,
      )
      await pool.query(`RESET ROLE`)
      await pool.query(`UPDATE control.kill_switches SET active=true WHERE (scope='global' AND scope_id='*') OR (scope='channel' AND scope_id='email')`)

      await pool.query(`SET ROLE commercial_safety_operator`)
      const first = await pool.query(
        `SELECT mail.attest_internal_mail_test($1,'proptimiza',$2,$3,$4,
           'contacto','event-internal-reply',$5) AS attestation_id`,
        [attestationId, missionId, idempotencyKey, approvalId, evidenceHash],
      )
      const replay = await pool.query(
        `SELECT mail.attest_internal_mail_test($1,'proptimiza',$2,$3,$4,
           'contacto','event-internal-reply',$5) AS attestation_id`,
        [attestationId, missionId, idempotencyKey, approvalId, evidenceHash],
      )
      assert.equal(first.rows[0].attestation_id, attestationId)
      assert.equal(replay.rows[0].attestation_id, attestationId)
      await pool.query(`RESET ROLE`)

      await pool.query(`SET ROLE commercial_observer`)
      const summary = await pool.query(
        `SELECT project_id,mission_id,verification_status
         FROM mail.internal_mail_attestation_summaries`,
      )
      assert.deepEqual(summary.rows, [{
        project_id: 'proptimiza', mission_id: missionId, verification_status: 'verified',
      }])
      await assert.rejects(
        pool.query(`SELECT evidence_sha256 FROM mail.internal_mail_attestations`),
        /permission denied/,
      )
      await pool.query(`RESET ROLE`)

      await assert.rejects(
        pool.query(`UPDATE mail.internal_mail_attestations SET verification_status='verified'`),
        /INTERNAL_MAIL_ATTESTATION_IMMUTABLE/,
      )
      const rollback = await readFile(
        new URL('../migrations/020_internal_mail_attestation.rollback.sql', import.meta.url),
        'utf8',
      )
      await assert.rejects(
        pool.query(rollback),
        /INTERNAL_MAIL_ATTESTATION_ROLLBACK_REQUIRES_EMPTY_LEDGER/,
      )
    } finally {
      await pool.end()
      await dropTestDatabase(admin, database)
      await admin.end()
    }
  })
})
