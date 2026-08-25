export type PolicyActivationNextGate =
  | 'human_reviews'
  | 'internal_mail_attestation'
  | 'explicit_activation_authorization'
  | 'external_transport_readiness'

export interface PolicyActivationDossierState {
  projectId: 'proptimiza'
  policyVersion: 'policy-v2'
  policyDigest: string
  reviewCompleted: boolean
  authorizationRecorded: boolean
  internalMailAttested: boolean
  activePolicyVersion: string
  policyEffective: boolean
  externalContact: boolean
  versionActivationCreated: boolean
  deliveryPolicyCreated: boolean
  deliveryPolicyActivationCreated: boolean
  globalKillSwitchActive: boolean
  emailKillSwitchActive: boolean
  databaseGateSatisfied: boolean
  activationAllowed: false
  nextRequiredGate: PolicyActivationNextGate
  provenance: {
    source: 'control-broker'
    sourceId: 'policy-activation-dossier:proptimiza:policy-v2'
    observedAt: string
    synthetic: false
  }
}

const sha256 = /^[0-9a-f]{64}$/

export function validatePolicyActivationDossierState(value: unknown): PolicyActivationDossierState {
  try {
    const state = object(value)
    exactKeys(state, [
      'projectId','policyVersion','policyDigest','reviewCompleted','authorizationRecorded','internalMailAttested',
      'activePolicyVersion','policyEffective','externalContact','versionActivationCreated','deliveryPolicyCreated',
      'deliveryPolicyActivationCreated','globalKillSwitchActive','emailKillSwitchActive','databaseGateSatisfied',
      'activationAllowed','nextRequiredGate','provenance',
    ])
    if (state.projectId !== 'proptimiza' || state.policyVersion !== 'policy-v2' || !sha256.test(string(state.policyDigest)) ||
        !string(state.activePolicyVersion) || state.activationAllowed !== false ||
        !['human_reviews','internal_mail_attestation','explicit_activation_authorization','external_transport_readiness'].includes(string(state.nextRequiredGate))) throw new Error('identity')
    const booleans = ['reviewCompleted','authorizationRecorded','internalMailAttested','policyEffective','externalContact','versionActivationCreated','deliveryPolicyCreated','deliveryPolicyActivationCreated','globalKillSwitchActive','emailKillSwitchActive','databaseGateSatisfied']
    if (booleans.some((key) => typeof state[key] !== 'boolean')) throw new Error('booleans')
    const expectedGate = state.reviewCompleted !== true ? 'human_reviews'
      : state.internalMailAttested !== true ? 'internal_mail_attestation'
      : state.authorizationRecorded !== true ? 'explicit_activation_authorization'
      : 'external_transport_readiness'
    if (state.nextRequiredGate !== expectedGate) throw new Error('next gate')
    const databaseGate = state.reviewCompleted === true && state.authorizationRecorded === true && state.internalMailAttested === true &&
      state.activePolicyVersion === 'policy-v1' && state.policyEffective === false && state.externalContact === false &&
      state.versionActivationCreated === false && state.deliveryPolicyCreated === false && state.deliveryPolicyActivationCreated === false &&
      state.globalKillSwitchActive === true && state.emailKillSwitchActive === true
    if (state.databaseGateSatisfied !== databaseGate) throw new Error('database gate')
    const provenance = object(state.provenance)
    exactKeys(provenance, ['source','sourceId','observedAt','synthetic'])
    if (provenance.source !== 'control-broker' || provenance.sourceId !== 'policy-activation-dossier:proptimiza:policy-v2' ||
        typeof provenance.observedAt !== 'string' || !Number.isFinite(Date.parse(provenance.observedAt)) || provenance.synthetic !== false) throw new Error('provenance')
    return value as PolicyActivationDossierState
  } catch {
    throw new Error('POLICY_ACTIVATION_DOSSIER_INVALID')
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
  return value as Record<string, unknown>
}
function string(value: unknown): string { return typeof value === 'string' ? value : '' }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key,index) => key !== wanted[index])) throw new Error('keys')
}
