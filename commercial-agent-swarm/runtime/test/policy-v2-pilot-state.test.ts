import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  validatePolicyV2DeliveryContractState,
  validatePolicyV2PilotPreparationState,
} from '../src/policy-v2-pilot-state.js'

const preparation = () => ({
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
})

const contract = () => ({
  contractId: '123e4567-e89b-42d3-a456-426614174000', projectId: 'proptimiza', policyVersion: 'policy-v2',
  contractSha256: 'b'.repeat(64), recipientSetSha256: 'c'.repeat(64), expectedRecipientCount: 2,
  recipientCount: 2, recipientCountExact: true, suppressionClear: true, evidenceCurrent: true,
  globalKillSwitchActive: true, emailKillSwitchActive: true, activePolicyVersion: 'policy-v1',
  policyEffective: false, externalContact: false, deliveryPolicyCount: 0,
  deliveryPolicyActivationCount: 0, versionActivationCount: 0, externalTransportReady: true,
  activationAuthorizationRecorded: false, activationAllowed: false, targetCreationAllowed: false,
  sendAllowed: false, contractComplete: true, nextRequiredGate: 'explicit_policy_activation_authorization',
  provenance: { source: 'control-broker', sourceId: 'policy-v2-delivery-contract:123e4567-e89b-42d3-a456-426614174000', observedAt: '2026-09-21T12:00:00.000Z', synthetic: false },
})

describe('policy-v2 pilot state contracts', () => {
  it('accepts only the exact fail-closed preparation projection', () => {
    assert.equal(validatePolicyV2PilotPreparationState(preparation()).sendAllowed, false)
    assert.throws(
      () => validatePolicyV2PilotPreparationState({ ...preparation(), activationAllowed: true }),
      /POLICY_V2_PILOT_PREPARATION_STATE_INVALID/,
    )
    assert.throws(
      () => validatePolicyV2PilotPreparationState({ ...preparation(), recipient: 'hidden@example.test' }),
      /POLICY_V2_PILOT_PREPARATION_STATE_INVALID/,
    )
  })

  it('accepts only aggregate contract state and rejects recipient leakage or inconsistent counts', () => {
    assert.equal(validatePolicyV2DeliveryContractState(contract()).contractComplete, true)
    assert.throws(
      () => validatePolicyV2DeliveryContractState({ ...contract(), recipient: 'hidden@example.test' }),
      /POLICY_V2_DELIVERY_CONTRACT_STATE_INVALID/,
    )
    assert.throws(
      () => validatePolicyV2DeliveryContractState({ ...contract(), recipientCount: 1 }),
      /POLICY_V2_DELIVERY_CONTRACT_STATE_INVALID/,
    )
    assert.throws(
      () => validatePolicyV2DeliveryContractState({ ...contract(), targetCreationAllowed: true }),
      /POLICY_V2_DELIVERY_CONTRACT_STATE_INVALID/,
    )
  })

  it('requires baseline recovery before readiness or activation when containment drifts', () => {
    const drifted = { ...contract(), globalKillSwitchActive: false, contractComplete: false, nextRequiredGate: 'closed_baseline_recovery' }
    assert.equal(validatePolicyV2DeliveryContractState(drifted).nextRequiredGate, 'closed_baseline_recovery')
    assert.throws(
      () => validatePolicyV2DeliveryContractState({ ...drifted, nextRequiredGate: 'explicit_policy_activation_authorization' }),
      /POLICY_V2_DELIVERY_CONTRACT_STATE_INVALID/,
    )
  })
})
