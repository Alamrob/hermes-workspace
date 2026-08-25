import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { validatePolicyActivationDossierState } from '../src/policy-activation-dossier.js'

const state = () => ({
  projectId: 'proptimiza', policyVersion: 'policy-v2', policyDigest: 'a'.repeat(64),
  reviewCompleted: true, authorizationRecorded: false, internalMailAttested: false,
  activePolicyVersion: 'policy-v1', policyEffective: false, externalContact: false,
  versionActivationCreated: false, deliveryPolicyCreated: false, deliveryPolicyActivationCreated: false,
  globalKillSwitchActive: true, emailKillSwitchActive: true, databaseGateSatisfied: false,
  activationAllowed: false, nextRequiredGate: 'internal_mail_attestation',
  provenance: { source: 'control-broker', sourceId: 'policy-activation-dossier:proptimiza:policy-v2', observedAt: '2026-08-25T20:00:00.000Z', synthetic: false },
})

describe('policy activation dossier', () => {
  it('accepts an inert, internally consistent dossier', () => {
    assert.equal(validatePolicyActivationDossierState(state()).activationAllowed, false)
  })

  it('rejects activation permission and inconsistent gates', () => {
    assert.throws(() => validatePolicyActivationDossierState({ ...state(), activationAllowed: true }), /POLICY_ACTIVATION_DOSSIER_INVALID/)
    assert.throws(() => validatePolicyActivationDossierState({ ...state(), databaseGateSatisfied: true }), /POLICY_ACTIVATION_DOSSIER_INVALID/)
    assert.throws(() => validatePolicyActivationDossierState({ ...state(), nextRequiredGate: 'explicit_activation_authorization' }), /POLICY_ACTIVATION_DOSSIER_INVALID/)
  })

  it('creates no activation, delivery policy, authorization command or insert grant', async () => {
    const migration = await readFile(new URL('../migrations/023_policy_activation_dossier.sql', import.meta.url), 'utf8')
    assert.doesNotMatch(migration, /INSERT INTO\s+(?:control\.policy_activation_authorizations|mail\.delivery_policies|mail\.delivery_policy_activations|catalog\.version_activations)/i)
    assert.doesNotMatch(migration, /record_policy_activation|activate_policy|GRANT\s+(?:INSERT|UPDATE|DELETE).*policy_activation_authorizations/is)
    assert.match(migration, /GRANT EXECUTE ON FUNCTION control\.build_policy_activation_dossier_state\(\) TO commercial_runtime/i)
  })
})
