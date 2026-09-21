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
  channel: 'email',
  offer_id: 'operacion-sin-planillas',
  tracking: false,
  a3_enabled: false,
  project_id: 'proptimiza',
  icp_version: 'icp-v1',
  offer_version: 'offer-v1',
  policy_version: 'policy-v2',
  preparation_only: true,
  maximum_companies: 10,
  kill_switch_active: true,
  automatic_follow_up: false,
  external_actions_authorized: false,
  maximum_initial_messages_per_company: 1,
}

integration('PostgreSQL 17 policy-v2 pilot preparation gate', () => {
  it('records preparation and readiness without enabling activation, targets, or sends', async () => {
    const admin = new Pool({ connectionString: ADMIN })
    const database = `policy_v2_preparation_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(ADMIN!)
    url.pathname = `/${database}`
    const pool = new Pool({ connectionString: url.toString() })
    try {
      await runVersionedMigrations(pool, await loadMigrationSources())
      const initial = (await pool.query(
        'SELECT control.build_policy_v2_pilot_preparation_state() AS state',
      )).rows[0].state
      assert.equal(initial.preparationGateRecorded, false)
      assert.equal(initial.activationAllowed, false)
      assert.equal(initial.targetCreationAllowed, false)
      assert.equal(initial.sendAllowed, false)

      const authorizationId = randomUUID()
      await pool.query(
        `INSERT INTO control.policy_activation_authorizations(
          authorization_id,project_id,policy_version,decision,rationale,
          authorized_by,authorized_email,authorized_at,policy_digest,
          authorization_scope,idempotency_key,request_sha256
        ) VALUES($1,'proptimiza','policy-v2','approved',$2,$3,
          'proptimizaspa@gmail.com',clock_timestamp(),$4,$5::jsonb,$6,$7)`,
        [
          authorizationId,
          'Preparation only for a bounded email pilot; no activation or external action.',
          'human:test-operator',
          '888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19',
          JSON.stringify(scope),
          `policy-activation:test-${authorizationId}`,
          'fc14a614af12611fc287fc4581cce819f05eaedab13d2882505034616e210954',
        ],
      )

      const prepared = (await pool.query(
        'SELECT control.build_policy_v2_pilot_preparation_state() AS state',
      )).rows[0].state
      assert.equal(prepared.preparationGateRecorded, true)
      assert.equal(prepared.preparationSatisfied, true)
      assert.equal(prepared.externalTransportReady, false)
      assert.equal(prepared.nextRequiredGate, 'external_transport_readiness')
      assert.equal(prepared.activationAuthorizationRecorded, false)
      assert.equal(prepared.activationAllowed, false)
      assert.equal(prepared.targetCreationAllowed, false)
      assert.equal(prepared.sendAllowed, false)
      assert.equal(prepared.pilotCohortCount, 0)
      assert.equal(prepared.pilotTargetCount, 0)
      assert.equal(prepared.pendingExternalActionCount, 0)

      await assert.rejects(
        pool.query(
          `INSERT INTO control.policy_v2_external_transport_readiness(
            attestation_id,preparation_authorization_id,project_id,policy_version,
            evidence_sha256,dns_ready,smtp_configuration_present,
            imap_configuration_present,webhook_configuration_present,
            credential_separation_verified,provider_calls,secret_values_disclosed,
            observed_at,expires_at
          ) VALUES($1,$2,'proptimiza','policy-v2',$3,true,true,true,true,true,1,false,
            clock_timestamp(),clock_timestamp()+interval '1 hour')`,
          [randomUUID(), authorizationId, 'a'.repeat(64)],
        ),
      )

      await pool.query(
        `INSERT INTO control.policy_v2_external_transport_readiness(
          attestation_id,preparation_authorization_id,project_id,policy_version,
          evidence_sha256,dns_ready,smtp_configuration_present,
          imap_configuration_present,webhook_configuration_present,
          credential_separation_verified,provider_calls,secret_values_disclosed,
          observed_at,expires_at
        ) VALUES($1,$2,'proptimiza','policy-v2',$3,true,true,true,true,true,0,false,
          clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')`,
        [randomUUID(), authorizationId, 'c'.repeat(64)],
      )
      assert.equal((await pool.query(
        'SELECT control.build_policy_v2_pilot_preparation_state() AS state',
      )).rows[0].state.externalTransportReady, false)

      await pool.query(
        `INSERT INTO control.policy_v2_external_transport_readiness(
          attestation_id,preparation_authorization_id,project_id,policy_version,
          evidence_sha256,dns_ready,smtp_configuration_present,
          imap_configuration_present,webhook_configuration_present,
          credential_separation_verified,provider_calls,secret_values_disclosed,
          observed_at,expires_at
        ) VALUES($1,$2,'proptimiza','policy-v2',$3,true,true,true,true,true,0,false,
          clock_timestamp(),clock_timestamp()+interval '1 hour')`,
        [randomUUID(), authorizationId, 'b'.repeat(64)],
      )

      const ready = (await pool.query(
        'SELECT control.build_policy_v2_pilot_preparation_state() AS state',
      )).rows[0].state
      assert.equal(ready.externalTransportReady, true)
      assert.equal(ready.nextRequiredGate, 'explicit_policy_activation_authorization')
      assert.equal(ready.activationAllowed, false)
      assert.equal(ready.targetCreationAllowed, false)
      assert.equal(ready.sendAllowed, false)
      assert.equal((await pool.query(
        `SELECT has_table_privilege('commercial_runtime',
          'control.policy_v2_external_transport_readiness','INSERT') AS allowed`,
      )).rows[0].allowed, false)

      await assert.rejects(
        pool.query(await readFile(
          new URL('../migrations/040_policy_v2_pilot_preparation_gate.rollback.sql', import.meta.url),
          'utf8',
        )),
        /POLICY_V2_TRANSPORT_READINESS_HISTORY_PRESENT/,
      )
    } finally {
      await pool.end()
      await dropTestDatabase(admin, database)
      await admin.end()
    }
  })
})
