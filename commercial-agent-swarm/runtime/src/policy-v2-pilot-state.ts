export type PolicyV2PreparationNextGate =
  | 'explicit_preparation_gate'
  | 'closed_baseline_recovery'
  | 'external_transport_readiness'
  | 'explicit_policy_activation_authorization'

export interface PolicyV2PilotPreparationState {
  projectId: 'proptimiza'
  policyVersion: 'policy-v2'
  policyDigest: string
  preparationGateRecorded: boolean
  preparationSatisfied: boolean
  externalTransportReady: boolean
  activationAuthorizationRecorded: false
  activePolicyVersion: string
  policyEffective: boolean
  externalContact: boolean
  pilotCohortCount: number
  pilotTargetCount: number
  deliveryPolicyCount: number
  deliveryPolicyActivationCount: number
  versionActivationCount: number
  pendingExternalActionCount: number
  globalKillSwitchActive: boolean
  emailKillSwitchActive: boolean
  maximumCompanies: 10
  channel: 'email'
  tracking: false
  automaticFollowUp: false
  a3Enabled: false
  targetCreationAllowed: false
  sendAllowed: false
  activationAllowed: false
  nextRequiredGate: PolicyV2PreparationNextGate
  provenance: Provenance
}

export type PolicyV2ContractNextGate =
  | 'recipient_contract_population'
  | 'recipient_contract_correction'
  | 'closed_baseline_recovery'
  | 'external_transport_readiness'
  | 'explicit_policy_activation_authorization'

export interface PolicyV2DeliveryContractState {
  contractId: string
  projectId: 'proptimiza'
  policyVersion: 'policy-v2'
  contractSha256: string
  recipientSetSha256: string
  expectedRecipientCount: number
  recipientCount: number
  recipientCountExact: boolean
  suppressionClear: boolean
  evidenceCurrent: boolean
  globalKillSwitchActive: boolean
  emailKillSwitchActive: boolean
  activePolicyVersion: string
  policyEffective: boolean
  externalContact: boolean
  deliveryPolicyCount: number
  deliveryPolicyActivationCount: number
  versionActivationCount: number
  externalTransportReady: boolean
  activationAuthorizationRecorded: false
  activationAllowed: false
  targetCreationAllowed: false
  sendAllowed: false
  contractComplete: boolean
  nextRequiredGate: PolicyV2ContractNextGate
  provenance: Provenance
}

interface Provenance {
  source: 'control-broker'
  sourceId: string
  observedAt: string
  synthetic: false
}

const sha256 = /^[0-9a-f]{64}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function validatePolicyV2PilotPreparationState(value: unknown): PolicyV2PilotPreparationState {
  try {
    const state = object(value)
    exactKeys(state, [
      'projectId','policyVersion','policyDigest','preparationGateRecorded','preparationSatisfied',
      'externalTransportReady','activationAuthorizationRecorded','activePolicyVersion','policyEffective',
      'externalContact','pilotCohortCount','pilotTargetCount','deliveryPolicyCount',
      'deliveryPolicyActivationCount','versionActivationCount','pendingExternalActionCount',
      'globalKillSwitchActive','emailKillSwitchActive','maximumCompanies','channel','tracking',
      'automaticFollowUp','a3Enabled','targetCreationAllowed','sendAllowed','activationAllowed',
      'nextRequiredGate','provenance',
    ])
    if (state.projectId !== 'proptimiza' || state.policyVersion !== 'policy-v2' ||
        !sha256.test(string(state.policyDigest)) || state.maximumCompanies !== 10 ||
        state.channel !== 'email' || !string(state.activePolicyVersion)) throw new Error('identity')
    booleanFields(state, [
      'preparationGateRecorded','preparationSatisfied','externalTransportReady','policyEffective',
      'externalContact','globalKillSwitchActive','emailKillSwitchActive',
    ])
    falseFields(state, [
      'activationAuthorizationRecorded','tracking','automaticFollowUp','a3Enabled',
      'targetCreationAllowed','sendAllowed','activationAllowed',
    ])
    integerFields(state, [
      'pilotCohortCount','pilotTargetCount','deliveryPolicyCount','deliveryPolicyActivationCount',
      'versionActivationCount','pendingExternalActionCount',
    ])
    const satisfied = state.preparationGateRecorded === true &&
      state.pilotCohortCount === 0 && state.pilotTargetCount === 0 &&
      state.deliveryPolicyCount === 0 && state.deliveryPolicyActivationCount === 0 &&
      state.versionActivationCount === 0 && state.pendingExternalActionCount === 0 &&
      state.globalKillSwitchActive === true && state.emailKillSwitchActive === true &&
      state.activePolicyVersion === 'policy-v1' && state.policyEffective === false &&
      state.externalContact === false
    if (state.preparationSatisfied !== satisfied) throw new Error('preparation')
    const expectedGate = state.preparationGateRecorded !== true ? 'explicit_preparation_gate'
      : state.preparationSatisfied !== true ? 'closed_baseline_recovery'
      : state.externalTransportReady !== true ? 'external_transport_readiness'
      : 'explicit_policy_activation_authorization'
    if (state.nextRequiredGate !== expectedGate) throw new Error('next gate')
    validateProvenance(state.provenance, 'policy-v2-pilot-preparation:proptimiza')
    return value as PolicyV2PilotPreparationState
  } catch {
    throw new Error('POLICY_V2_PILOT_PREPARATION_STATE_INVALID')
  }
}

export function validatePolicyV2DeliveryContractState(value: unknown): PolicyV2DeliveryContractState {
  try {
    const state = object(value)
    exactKeys(state, [
      'contractId','projectId','policyVersion','contractSha256','recipientSetSha256',
      'expectedRecipientCount','recipientCount','recipientCountExact','suppressionClear',
      'evidenceCurrent','globalKillSwitchActive','emailKillSwitchActive','activePolicyVersion',
      'policyEffective','externalContact','deliveryPolicyCount','deliveryPolicyActivationCount',
      'versionActivationCount','externalTransportReady','activationAuthorizationRecorded',
      'activationAllowed','targetCreationAllowed','sendAllowed','contractComplete',
      'nextRequiredGate','provenance',
    ])
    if (!uuid.test(string(state.contractId)) || state.projectId !== 'proptimiza' ||
        state.policyVersion !== 'policy-v2' || !sha256.test(string(state.contractSha256)) ||
        !sha256.test(string(state.recipientSetSha256)) || !string(state.activePolicyVersion)) throw new Error('identity')
    booleanFields(state, [
      'recipientCountExact','suppressionClear','evidenceCurrent','globalKillSwitchActive',
      'emailKillSwitchActive','policyEffective','externalContact','externalTransportReady','contractComplete',
    ])
    falseFields(state, [
      'activationAuthorizationRecorded','activationAllowed','targetCreationAllowed','sendAllowed',
    ])
    integerFields(state, [
      'expectedRecipientCount','recipientCount','deliveryPolicyCount','deliveryPolicyActivationCount',
      'versionActivationCount',
    ])
    if (number(state.expectedRecipientCount) < 1 || number(state.expectedRecipientCount) > 10 ||
        state.recipientCountExact !== (state.recipientCount === state.expectedRecipientCount)) throw new Error('count')
    const baselineClosed = state.globalKillSwitchActive === true && state.emailKillSwitchActive === true &&
      state.activePolicyVersion === 'policy-v1' && state.policyEffective === false && state.externalContact === false &&
      state.deliveryPolicyCount === 0 && state.deliveryPolicyActivationCount === 0 && state.versionActivationCount === 0
    const complete = state.recipientCountExact === true && number(state.recipientCount) >= 1 &&
      number(state.recipientCount) <= 10 && state.suppressionClear === true && state.evidenceCurrent === true &&
      baselineClosed && state.externalTransportReady === true
    if (state.contractComplete !== complete) throw new Error('complete')
    const expectedGate = state.recipientCount === 0 ? 'recipient_contract_population'
      : state.recipientCountExact !== true || state.suppressionClear !== true || state.evidenceCurrent !== true
        ? 'recipient_contract_correction'
        : !baselineClosed ? 'closed_baseline_recovery'
          : state.externalTransportReady !== true ? 'external_transport_readiness'
            : 'explicit_policy_activation_authorization'
    if (state.nextRequiredGate !== expectedGate) throw new Error('next gate')
    validateProvenance(state.provenance, `policy-v2-delivery-contract:${state.contractId}`)
    return value as PolicyV2DeliveryContractState
  } catch {
    throw new Error('POLICY_V2_DELIVERY_CONTRACT_STATE_INVALID')
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
  return value as Record<string, unknown>
}
function string(value: unknown): string { return typeof value === 'string' ? value : '' }
function number(value: unknown): number { return typeof value === 'number' ? value : Number.NaN }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key,index) => key !== wanted[index])) throw new Error('keys')
}
function booleanFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (fields.some((field) => typeof value[field] !== 'boolean')) throw new Error('boolean')
}
function falseFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (fields.some((field) => value[field] !== false)) throw new Error('false')
}
function integerFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (fields.some((field) => !Number.isSafeInteger(value[field]) || number(value[field]) < 0)) throw new Error('integer')
}
function validateProvenance(value: unknown, sourceId: string): void {
  const provenance = object(value)
  exactKeys(provenance, ['source','sourceId','observedAt','synthetic'])
  if (provenance.source !== 'control-broker' || provenance.sourceId !== sourceId ||
      !Number.isFinite(Date.parse(string(provenance.observedAt))) || provenance.synthetic !== false) throw new Error('provenance')
}
