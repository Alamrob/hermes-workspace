import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { dropTestDatabase } from './database-cleanup.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip

integration('PostgreSQL 17 CRM integration control plane', () => {
  it('owns bounded non-secret pilots in control and preserves durable CRM state on rollback', async () => {
    const admin = new Pool({ connectionString: ADMIN })
    const database = `crm_integration_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    const pool = new Pool({ connectionString: url.toString() })
    try {
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
      ]
      await runVersionedMigrations(
        pool,
        await Promise.all(
          versions.map(async (version) => ({
            version,
            sql: await readFile(
              new URL(`../migrations/${version}.sql`, import.meta.url),
              'utf8',
            ),
          })),
        ),
      )
      for (const relation of [
        'control.pilot_cohorts',
        'control.pilot_targets',
        'control.approval_channel_evidence',
        'integration.crm_entity_links',
        'integration.crm_outbox',
        'integration.crm_inbox',
        'integration.crm_sync_cursors',
      ])
        assert.equal(
          (await pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [relation]))
            .rows[0].present,
          true,
          relation,
        )

      const crmRoles = (await pool.query(`
        SELECT role.rolname,role.rolinherit,
          EXISTS(SELECT 1 FROM pg_auth_members membership WHERE membership.member=role.oid) AS outbound_membership
        FROM pg_roles role
        WHERE role.rolname IN('commercial_crm_sync','commercial_crm_observer','commercial_approval_evidence')
        ORDER BY role.rolname
      `)).rows
      assert.equal(crmRoles.length, 3)
      assert.equal(crmRoles.every((role) => role.rolinherit === false), true)
      assert.equal(crmRoles.every((role) => role.outbound_membership === false), true)

      assert.equal(
        (await pool.query(`SELECT count(*)::int AS count FROM catalog.project_inventory`)).rows[0].count,
        26,
      )
      assert.equal(
        (await pool.query(`SELECT activatable FROM catalog.project_inventory WHERE project_id='xg-systems'`)).rows[0].activatable,
        false,
      )
      await assert.rejects(
        pool.query(`UPDATE catalog.project_inventory SET activatable=true WHERE project_id='xg-systems'`),
        /project_inventory_check/,
      )
      await pool.query(`SET ROLE commercial_runtime`)
      const portfolio = (await pool.query(`SELECT control.get_portfolio_read_model() AS model`)).rows[0].model
      assert.equal(portfolio.portfolio.length, 26)
      assert.equal(portfolio.projects.length, 1)
      assert.equal(portfolio.projects[0].id, 'operacion-sin-planillas')
      assert.deepEqual(portfolio.costs, [])
      assert.equal(portfolio.portfolio.find((item: any) => item.id === 'wspro').name, 'WSPro')
      assert.equal(portfolio.control.killSwitch, true)
      await pool.query(`RESET ROLE`)
      await pool.query(`SET ROLE commercial_crm_sync`)
      const crmSummary = (await pool.query(`SELECT integration.get_crm_summary() AS model`)).rows[0].model
      assert.equal(crmSummary.availability, 'unavailable')
      assert.equal(crmSummary.accounts, null)
      assert.equal(crmSummary.pipelineUsd, null)
      assert.equal(crmSummary.provenance.source, 'twenty')
      await pool.query(`RESET ROLE`)

      const cohortId = randomUUID()
      await pool.query(`SET ROLE commercial_runtime`)
      await pool.query(
        `SELECT control.create_pilot_cohort($1,'proptimiza','shadow-pilot')`,
        [cohortId],
      )
      const targetIds: string[] = []
      for (let index = 0; index < 10; index += 1) {
        const targetId = randomUUID()
        targetIds.push(targetId)
        await pool.query(
          `SELECT control.add_pilot_target($1,$2,$3,$4,NULL,NULL,'operacion-sin-planillas','offer-v1','email','admitted','draft',$5,$6)`,
          [
            targetId,
            cohortId,
            `control-${index}`,
            `company-${index}`,
            '2026-09-01T00:00:00Z',
            `evidence-${index}`,
          ],
        )
      }
      await assert.rejects(
        pool.query(
          `SELECT control.add_pilot_target($1,$2,'control-10','company-10',NULL,NULL,'operacion-sin-planillas','offer-v1','email','admitted','draft','2026-09-01T00:00:00Z','evidence-10')`,
          [randomUUID(), cohortId],
        ),
        /PILOT_TARGET_LIMIT_EXCEEDED/,
      )
      await assert.rejects(
        pool.query(
          `SELECT control.add_pilot_target($1,$2,'control-0','company-duplicate',NULL,NULL,'operacion-sin-planillas','offer-v1','email','admitted','draft','2026-09-01T00:00:00Z','evidence-duplicate')`,
          [randomUUID(), cohortId],
        ),
        /PILOT_TARGET_IDEMPOTENCY_CONFLICT/,
      )
      await pool.query(`RESET ROLE`)
      await pool.query(`SET ROLE commercial_safety_operator`)
      await pool.query(
        `SELECT control.add_pilot_suppression('blocked-control','policy','evidence-block')`,
      )
      await pool.query(`RESET ROLE`)
      await pool.query(`SET ROLE commercial_runtime`)
      await assert.rejects(
        pool.query(
          `SELECT control.add_pilot_target($1,$2,'blocked-control','company-blocked',NULL,NULL,'operacion-sin-planillas','offer-v1','email','admitted','draft','2026-09-01T00:00:00Z','evidence-block')`,
          [randomUUID(), cohortId],
        ),
        /PILOT_TARGET_SUPPRESSED/,
      )

      const outboxId = randomUUID()
      await pool.query(
        `SELECT integration.enqueue_crm_change($1,$2,$3,'mirror_pilot_target',$4,1)`,
        [outboxId, cohortId, targetIds[0], { control_ref: 'control-0' }],
      )
      await assert.rejects(
        pool.query(
          `SELECT integration.enqueue_crm_change($1,$2,$3,'mirror_pilot_target',$4,1)`,
          [randomUUID(), cohortId, targetIds[0], { control_ref: 'changed' }],
        ),
        /CRM_IDEMPOTENCY_CONFLICT/,
      )
      const uncertainOutboxId = randomUUID()
      await pool.query(
        `SELECT integration.enqueue_crm_change($1,$2,$3,'upsert_account',$4,2)`,
        [uncertainOutboxId, cohortId, targetIds[0], { name: 'Company 0' }],
      )
      await pool.query(`RESET ROLE`)
      await pool.query(`SET ROLE commercial_safety_operator`)
      await pool.query(`SELECT integration.set_crm_sync_enabled(true)`)
      await pool.query(`RESET ROLE`)
      await pool.query(`SET ROLE commercial_crm_sync`)
      assert.equal(
        (
          await pool.query(
            `SELECT outbox_id FROM integration.claim_crm_outbox('worker-1',60)`,
          )
        ).rows[0].outbox_id,
        outboxId,
      )
      await pool.query(
        `SELECT integration.complete_crm_outbox($1,'worker-1','remote-1','v1')`,
        [outboxId],
      )
      assert.equal((await pool.query(`SELECT integration.crm_sync_ready() AS ready`)).rows[0].ready, false)
      await pool.query(`RESET ROLE`)
      const crmLogin = `crm_sync_login_${randomUUID().replaceAll('-', '')}`
      const unsafeParent = `crm_unsafe_parent_${randomUUID().replaceAll('-', '')}`
      await pool.query(`CREATE ROLE "${crmLogin}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
      await pool.query(`GRANT commercial_crm_sync TO "${crmLogin}"`)
      await pool.query(`SET SESSION AUTHORIZATION "${crmLogin}"`)
      assert.equal((await pool.query(`SELECT integration.crm_sync_ready() AS ready`)).rows[0].ready, true)
      await pool.query(`RESET SESSION AUTHORIZATION`)
      await pool.query(`CREATE ROLE "${unsafeParent}" NOLOGIN NOINHERIT`)
      await pool.query(`GRANT "${unsafeParent}" TO commercial_crm_sync`)
      await pool.query(`SET SESSION AUTHORIZATION "${crmLogin}"`)
      assert.equal((await pool.query(`SELECT integration.crm_sync_ready() AS ready`)).rows[0].ready, false)
      await pool.query(`RESET SESSION AUTHORIZATION`)
      await pool.query(`REVOKE "${unsafeParent}" FROM commercial_crm_sync`)
      await pool.query(`REVOKE commercial_crm_sync FROM "${crmLogin}"`)
      await pool.query(`DROP ROLE "${unsafeParent}","${crmLogin}"`)
      await pool.query(`SET ROLE commercial_crm_sync`)
      assert.equal(
        (
          await pool.query(
            `SELECT integration.advance_crm_cursor('twenty','accounts',0,'2026-08-16T00:00:00.000Z') AS version`,
          )
        ).rows[0].version,
        '1',
      )
      assert.equal(
        (
          await pool.query(
            `SELECT cursor_value FROM integration.get_crm_cursor('twenty','accounts')`,
          )
        ).rows[0].cursor_value,
        '2026-08-16T00:00:00.000Z',
      )
      assert.equal(
        (
          await pool.query(
            `SELECT outbox_id FROM integration.claim_crm_outbox('worker-1',60)`,
          )
        ).rows[0].outbox_id,
        uncertainOutboxId,
      )
      await pool.query(
        `SELECT integration.mark_crm_outbox_outcome_unknown($1,'worker-1','TWENTY_OUTCOME_UNKNOWN')`,
        [uncertainOutboxId],
      )
      assert.equal(
        (
          await pool.query(
            `SELECT outbox_id FROM integration.list_crm_outcome_unknown(10)`,
          )
        ).rows[0].outbox_id,
        uncertainOutboxId,
      )
      await pool.query(`RESET ROLE`)
      assert.equal(
        (
          await pool.query(
            `SELECT target_id FROM integration.crm_entity_links WHERE connector_id='twenty' AND remote_record_id='remote-1'`,
          )
        ).rows[0].target_id,
        targetIds[0],
      )

      const approvalId = randomUUID()
      const actionHash = 'b'.repeat(64)
      await pool.query(`SET ROLE commercial_runtime`)
      await pool.query(
        `SELECT control.request_approval($1,$2,$3,clock_timestamp())`,
        [approvalId, { mission_id: randomUUID() }, actionHash],
      )
      await pool.query(`RESET ROLE`)
      await pool.query(`SET ROLE commercial_approval_evidence`)
      assert.equal(
        (
          await pool.query(
            `SELECT control.record_approval_channel_evidence($1,$2,'sales','approved','sales-director','2026-08-16T12:00:00Z') AS recorded`,
            [approvalId, actionHash],
          )
        ).rows[0].recorded,
        true,
      )
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS count FROM control.list_approval_channel_evidence($1)`,
            [approvalId],
          )
        ).rows[0].count,
        1,
      )
      await assert.rejects(
        pool.query(
          `SELECT control.record_approval_channel_evidence($1,$2,'sales','denied','sales-director','2026-08-16T12:00:00Z')`,
          [approvalId, actionHash],
        ),
        /APPROVAL_EVIDENCE_CONFLICT/,
      )
      await pool.query(`RESET ROLE`)

      await pool.query(`SET ROLE commercial_runtime`)
      await pool.query(
        `SELECT mail.store_webhook_event('contacto',$1,clock_timestamp(),'untrusted_external',false,$2)`,
        [
          'c'.repeat(64),
          {
            payload_sha256: 'c'.repeat(64),
            byte_length: 1024,
            preview: 'bounded evidence',
          },
        ],
      )
      await pool.query(`RESET ROLE`)
      await pool.query(
        `UPDATE mail.webhook_events SET preview_expires_at=clock_timestamp()-interval '1 second' WHERE provider_event_id=$1`,
        ['c'.repeat(64)],
      )
      assert.equal(
        (
          await pool.query(
            `SELECT mail.purge_expired_webhook_previews(10) AS purged`,
          )
        ).rows[0].purged,
        1,
      )
      const retainedWebhook = (
        await pool.query(
          `SELECT untrusted_payload FROM mail.webhook_events WHERE provider_event_id=$1`,
          ['c'.repeat(64)],
        )
      ).rows[0].untrusted_payload
      assert.equal('preview' in retainedWebhook, false)
      assert.equal(retainedWebhook.payload_sha256, 'c'.repeat(64))

      const rollback = await readFile(
        new URL('../migrations/004_crm_integration.rollback.sql', import.meta.url),
        'utf8',
      )
      await pool.query(rollback)
      assert.equal(
        (await pool.query(`SELECT count(*)::int AS count FROM control.pilot_targets`))
          .rows[0].count,
        10,
      )
      assert.equal(
        (await pool.query(`SELECT enabled FROM integration.sync_control WHERE control_id=1`))
          .rows[0].enabled,
        false,
      )
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS count FROM control.approval_channel_evidence`,
          )
        ).rows[0].count,
        1,
      )
    } finally {
      await pool.end()
      await dropTestDatabase(admin, database)
      await admin.end()
    }
  })
})
