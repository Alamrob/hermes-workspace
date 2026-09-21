import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Pool } from 'pg'
import { loadMigrationSources } from '../src/migrate-main.js'
import { runVersionedMigrations } from '../src/migration-runner.js'
import { dropTestDatabase } from './database-cleanup.js'

const ADMIN = process.env.TEST_DATABASE_URL
const integration = ADMIN ? describe : describe.skip
const scope = {
  channel: 'email', offer_id: 'operacion-sin-planillas', tracking: false,
  a3_enabled: false, project_id: 'proptimiza', icp_version: 'icp-v1',
  offer_version: 'offer-v1', policy_version: 'policy-v2', preparation_only: true,
  maximum_companies: 10, kill_switch_active: true, automatic_follow_up: false,
  external_actions_authorized: false, maximum_initial_messages_per_company: 1,
}

integration('PostgreSQL 17 policy-v2 bounded recipient contract', () => {
  it('records only an immutable evidence set while every activation and send route stays closed', async () => {
    const admin = new Pool({ connectionString: ADMIN })
    const database = `policy_v2_recipients_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    const pool = new Pool({ connectionString: url.toString() })
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())
      const authorizationId = randomUUID()
      await pool.query(
        `INSERT INTO control.policy_activation_authorizations(
          authorization_id,project_id,policy_version,decision,rationale,
          authorized_by,authorized_email,authorized_at,policy_digest,
          authorization_scope,idempotency_key,request_sha256
        ) VALUES($1,'proptimiza','policy-v2','approved',$2,$3,
          'proptimizaspa@gmail.com',clock_timestamp(),$4,$5::jsonb,$6,$7)`,
        [authorizationId,
          'Preparation only for a bounded email pilot; no activation or external action.',
          'human:test-operator',
          '888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19',
          JSON.stringify(scope), `policy-activation:test-${authorizationId}`,
          'fc14a614af12611fc287fc4581cce819f05eaedab13d2882505034616e210954'],
      )

      await assert.rejects(pool.query(
        `INSERT INTO mail.policy_v2_delivery_contracts(
          contract_id,preparation_authorization_id,project_id,policy_version,sender,channel,
          expected_recipient_count,maximum_initial_messages_per_company,tracking,
          automatic_follow_up,human_approval_per_action,suppression_check_required,
          recipient_binding_required,source_evidence_required,recipient_set_sha256,contract_sha256
        ) VALUES($1,$2,'proptimiza','policy-v2','ventas@proptimiza.com','email',2,1,
          false,false,true,true,true,true,$3,$4)`,
        [randomUUID(), randomUUID(), 'a'.repeat(64), 'b'.repeat(64)],
      ), /POLICY_V2_PREPARATION_GATE_REQUIRED/)

      const contractId = randomUUID()
      await pool.query(
        `INSERT INTO mail.policy_v2_delivery_contracts(
          contract_id,preparation_authorization_id,project_id,policy_version,sender,channel,
          expected_recipient_count,maximum_initial_messages_per_company,tracking,
          automatic_follow_up,human_approval_per_action,suppression_check_required,
          recipient_binding_required,source_evidence_required,recipient_set_sha256,contract_sha256
        ) VALUES($1,$2,'proptimiza','policy-v2','ventas@proptimiza.com','email',2,1,
          false,false,true,true,true,true,$3,$4)`,
        [contractId, authorizationId, 'c'.repeat(64), 'd'.repeat(64)],
      )

      await pool.query(
        `INSERT INTO control.pilot_suppressions(control_ref,reason,evidence_ref)
         VALUES('company:suppressed','opt_out','evidence:test-suppressed')`,
      )
      await assert.rejects(pool.query(
        `INSERT INTO mail.policy_v2_delivery_recipients(
          contract_id,company_control_ref,recipient,recipient_role,contact_type,evidence_sha256,
          source_url_sha256,source_confidence,purpose,source_observed_at,source_reverified_at,expires_at
        ) VALUES($1,'company:suppressed','sales@example.test','sales',
          'role_based_corporate_email_published_by_the_account',$2,$3,'high',
          'commercial_pilot_policy_v2',clock_timestamp()-interval '1 minute',
          clock_timestamp(),clock_timestamp()+interval '1 day')`,
        [contractId, 'e'.repeat(64), 'f'.repeat(64)],
      ), /POLICY_V2_RECIPIENT_SUPPRESSED/)

      for (const slot of [1, 2])
        await pool.query(
          `INSERT INTO mail.policy_v2_delivery_recipients(
            contract_id,company_control_ref,recipient,recipient_role,contact_type,evidence_sha256,
            source_url_sha256,source_confidence,purpose,source_observed_at,source_reverified_at,expires_at
          ) VALUES($1,$2,$3,$4,'role_based_corporate_email_published_by_the_account',$5,$6,'high',
            'commercial_pilot_policy_v2',clock_timestamp()-interval '1 minute',
            clock_timestamp(),clock_timestamp()+interval '1 day')`,
          [contractId, `company:${slot}`, `${slot === 1 ? 'sales' : 'info'}@example.test`,
            slot === 1 ? 'sales' : 'info', String(slot).repeat(64), String(slot + 2).repeat(64)],
        )

      await assert.rejects(pool.query(
        `INSERT INTO mail.policy_v2_delivery_recipients(
          contract_id,company_control_ref,recipient,recipient_role,contact_type,evidence_sha256,
          source_url_sha256,source_confidence,purpose,source_observed_at,source_reverified_at,expires_at
        ) VALUES($1,'company:3','ventas@example.test','ventas',
          'role_based_corporate_email_published_by_the_account',$2,$3,'high',
          'commercial_pilot_policy_v2',clock_timestamp()-interval '1 minute',
          clock_timestamp(),clock_timestamp()+interval '1 day')`,
        [contractId, '7'.repeat(64), '8'.repeat(64)],
      ), /POLICY_V2_RECIPIENT_LIMIT_EXCEEDED/)

      const waiting = (await pool.query(
        'SELECT control.build_policy_v2_delivery_contract_state($1) AS state', [contractId],
      )).rows[0].state
      assert.equal(waiting.recipientCountExact, true)
      assert.equal(waiting.externalTransportReady, false)
      assert.equal(waiting.contractComplete, false)
      assert.equal(waiting.nextRequiredGate, 'external_transport_readiness')
      assert.equal(waiting.activationAllowed, false)
      assert.equal(waiting.targetCreationAllowed, false)
      assert.equal(waiting.sendAllowed, false)

      await pool.query(
        `INSERT INTO control.policy_v2_external_transport_readiness(
          attestation_id,preparation_authorization_id,project_id,policy_version,
          evidence_sha256,dns_ready,smtp_configuration_present,imap_configuration_present,
          webhook_configuration_present,credential_separation_verified,provider_calls,
          secret_values_disclosed,observed_at,expires_at
        ) VALUES($1,$2,'proptimiza','policy-v2',$3,true,true,true,true,true,0,false,
          clock_timestamp(),clock_timestamp()+interval '1 hour')`,
        [randomUUID(), authorizationId, '9'.repeat(64)],
      )
      const complete = (await pool.query(
        'SELECT control.build_policy_v2_delivery_contract_state($1) AS state', [contractId],
      )).rows[0].state
      assert.equal(complete.contractComplete, true)
      assert.equal(complete.nextRequiredGate, 'explicit_policy_activation_authorization')
      assert.equal(complete.activationAllowed, false)
      assert.equal(complete.targetCreationAllowed, false)
      assert.equal(complete.sendAllowed, false)

      await assert.rejects(
        pool.query(`UPDATE mail.policy_v2_delivery_recipients SET expires_at=clock_timestamp()+interval '2 days' WHERE contract_id=$1`, [contractId]),
        /POLICY_V2_DELIVERY_CONTRACT_IMMUTABLE/,
      )
      await assert.rejects(
        pool.query('DELETE FROM mail.policy_v2_delivery_contracts WHERE contract_id=$1', [contractId]),
        /POLICY_V2_DELIVERY_CONTRACT_IMMUTABLE/,
      )
      const counts = (await pool.query(`SELECT
        (SELECT count(*)::int FROM control.pilot_targets WHERE project_id='proptimiza') AS targets,
        (SELECT count(*)::int FROM mail.delivery_policies WHERE project_id='proptimiza' AND policy_version='policy-v2') AS policies,
        (SELECT count(*)::int FROM mail.delivery_policy_activations WHERE project_id='proptimiza' AND policy_version='policy-v2') AS activations,
        (SELECT count(*)::int FROM mail.external_actions) AS external_actions`)).rows[0]
      assert.deepEqual(counts, { targets: 0, policies: 0, activations: 0, external_actions: 0 })
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        assert.equal((await pool.query(
          `SELECT has_table_privilege('commercial_runtime','mail.policy_v2_delivery_recipients',$1) AS allowed`,
          [privilege],
        )).rows[0].allowed, false)
      assert.equal((await pool.query(
        `SELECT has_function_privilege('commercial_runtime',
          'control.build_policy_v2_delivery_contract_state(uuid)','EXECUTE') AS allowed`,
      )).rows[0].allowed, true)
      await assert.rejects(pool.query(await readFile(
        new URL('../migrations/041_policy_v2_recipient_contract.rollback.sql', import.meta.url), 'utf8',
      )), /POLICY_V2_DELIVERY_CONTRACT_HISTORY_PRESENT/)
    } finally {
      await pool.end()
      await dropTestDatabase(admin, database)
      await admin.end()
    }
  })
})
