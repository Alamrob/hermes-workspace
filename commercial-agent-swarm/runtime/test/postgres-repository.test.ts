import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PostgresRuntimeRepository } from '../src/postgres-repository.js'
import type { MissionRecord } from '../src/repository.js'

describe('PostgreSQL repository capability routing', () => {
  it('uses only the dedicated work-order ingestor pool to persist a mission', async () => {
    const calls: Array<Array<unknown>> = []
    const runtime = {
      query: async () => {
        throw new Error('RUNTIME_MUST_NOT_SAVE_MISSIONS')
      },
    }
    const ingestor = {
      query: async (...args: Array<unknown>) => {
        calls.push(args)
        return { rows: [] }
      },
    }
    const repository = new PostgresRuntimeRepository(runtime as never, {
      ingestorPool: ingestor as never,
    })
    await repository.saveMission({
      mission_id: '123e4567-e89b-42d3-a456-426614174000',
      idempotency_key: 'mission-ingestor-1',
      autonomy_level: 'A1',
      a3_enabled: false,
    } as MissionRecord)
    assert.equal(calls.length, 1)
    assert.match(String(calls[0][0]), /control\.save_mission/)
  })

  it('reads only aggregate policy-v2 state through the two fixed database functions', async () => {
    const contractId = '123e4567-e89b-42d3-a456-426614174000'
    const calls: Array<Array<unknown>> = []
    const states = [
      {
        projectId: 'proptimiza', policyVersion: 'policy-v2', policyDigest: 'a'.repeat(64),
        preparationGateRecorded: true, preparationSatisfied: true, externalTransportReady: false,
        activationAuthorizationRecorded: false, activePolicyVersion: 'policy-v1', policyEffective: false,
        externalContact: false, pilotCohortCount: 0, pilotTargetCount: 0, deliveryPolicyCount: 0,
        deliveryPolicyActivationCount: 0, versionActivationCount: 0, pendingExternalActionCount: 0,
        globalKillSwitchActive: true, emailKillSwitchActive: true, maximumCompanies: 10,
        channel: 'email', tracking: false, automaticFollowUp: false, a3Enabled: false,
        targetCreationAllowed: false, sendAllowed: false, activationAllowed: false,
        nextRequiredGate: 'external_transport_readiness',
        provenance: { source: 'control-broker', sourceId: 'policy-v2-pilot-preparation:proptimiza', observedAt: '2026-09-21T12:00:00.000Z', synthetic: false },
      },
      {
        contractId, projectId: 'proptimiza', policyVersion: 'policy-v2', contractSha256: 'b'.repeat(64),
        recipientSetSha256: 'c'.repeat(64), expectedRecipientCount: 2, recipientCount: 2,
        recipientCountExact: true, suppressionClear: true, evidenceCurrent: true,
        globalKillSwitchActive: true, emailKillSwitchActive: true, activePolicyVersion: 'policy-v1',
        policyEffective: false, externalContact: false, deliveryPolicyCount: 0,
        deliveryPolicyActivationCount: 0, versionActivationCount: 0, externalTransportReady: false,
        activationAuthorizationRecorded: false, activationAllowed: false, targetCreationAllowed: false,
        sendAllowed: false, contractComplete: false, nextRequiredGate: 'external_transport_readiness',
        provenance: { source: 'control-broker', sourceId: `policy-v2-delivery-contract:${contractId}`, observedAt: '2026-09-21T12:00:00.000Z', synthetic: false },
      },
    ]
    const runtime = {
      query: async (...args: Array<unknown>) => {
        calls.push(args)
        return { rows: [{ state: states.shift() }] }
      },
    }
    const repository = new PostgresRuntimeRepository(runtime as never)
    assert.equal((await repository.getPolicyV2PilotPreparationState()).sendAllowed, false)
    assert.equal((await repository.getPolicyV2DeliveryContractState(contractId))?.targetCreationAllowed, false)
    assert.equal(calls.length, 2)
    assert.match(String(calls[0][0]), /control\.build_policy_v2_pilot_preparation_state\(\)/)
    assert.match(String(calls[1][0]), /control\.build_policy_v2_delivery_contract_state\(\$1::uuid\)/)
    assert.deepEqual(calls[1][1], [contractId])
  })
})
