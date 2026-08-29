import { hashAction } from './canonical.js'
import type { A1DispatchExecutionArmState } from './a1-dispatch-execution-arm.js'

export interface A1DispatchExecutionWindowAttestations {
  exactArmConfirmed: true
  exactMissionConfirmed: true
  singleMissionWindowConfirmed: true
  providerCreditSpendAuthorized: true
  automaticRecontainmentRequired: true
  globalKillSwitchMayOpenOnlyForWindow: true
  externalChannelsBlocked: true
  maximumExternalActionsZero: true
  noContact: true
  noCrmWrite: true
  a3Blocked: true
  mailBlocked: true
  telegramBlocked: true
  timerDisabledConfirmed: true
}

export interface A1DispatchExecutionWindowRequest {
  decision: 'approved'
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  opensAt: string
  expiresAt: string
  expectedArmId: string
  expectedArmAuthorizationId: string
  expectedExecutionAuthorizationId: string
  expectedMissionSha256: string
  expectedAssignmentPlanSha256: string
  expectedJobSetSha256: string
  workerId: 'broker-dispatcher-1'
  maximumClaims: number
  maximumProviderCreditSpendUsd: number
  userAuthorizationSha256: string
  attestations: A1DispatchExecutionWindowAttestations
  idempotencyKey: string
}

export interface ActivateA1DispatchExecutionWindowInput extends A1DispatchExecutionWindowRequest {
  windowAuthorizationId: string
  missionId: string
  requestSha256: string
}

export interface A1DispatchExecutionWindowState
  extends Omit<ActivateA1DispatchExecutionWindowInput, 'requestSha256'> {
  executionWindowAuthorizationRecorded: true
  executionWindowEnabled: true
  dispatchClaimingPermitted: true
  claimsUsed: number
  jobsClaimed: boolean
  executionStarted: boolean
  providerCreditSpendAllowed: true
  contactPermitted: false
  crmWriteAllowed: false
  maximumExternalActions: 0
  globalKillSwitchActive: false
  externalChannelsBlocked: true
  automaticRecontainmentArmed: true
  productionGate: 'single_mission_internal_execution'
  nextRequiredGate: 'automatic_recontainment_after_terminal_or_expiry'
  provenance: { source: 'control-broker'; sourceId: string; observedAt: string; synthetic: false }
}

export class A1DispatchExecutionWindowError extends Error {
  constructor(readonly code: string) { super(code) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const ACTOR = /^[A-Za-z0-9._:@+-]{3,254}$/
const IDEMPOTENCY = /^a1-execution-window:[A-Za-z0-9._:-]{8,100}$/
const FORBIDDEN_TEXT = /(https?:\/\/|www\.|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{20,})/i

export function hashA1DispatchExecutionWindow(input: {
  missionId: string
  armId: string
  armAuthorizationId: string
  workerId: string
  opensAt: string
  expiresAt: string
  maximumClaims: number
  maximumProviderCreditSpendUsd: number
}): string {
  return hashAction({
    mission_id: input.missionId,
    arm_id: input.armId,
    arm_authorization_id: input.armAuthorizationId,
    worker_id: input.workerId,
    opens_at: input.opensAt,
    expires_at: input.expiresAt,
    maximum_claims: input.maximumClaims,
    maximum_provider_credit_spend_usd: input.maximumProviderCreditSpendUsd,
  })
}

export function validateA1DispatchExecutionWindowRequest(value: unknown, now: Date): A1DispatchExecutionWindowRequest {
  try {
    const input = object(value)
    exactKeys(input, ['decision','rationale','reviewer_id','reviewer_email','reviewed_at','opens_at','expires_at','expected_arm_id','expected_arm_authorization_id','expected_execution_authorization_id','expected_mission_sha256','expected_assignment_plan_sha256','expected_job_set_sha256','worker_id','maximum_claims','maximum_provider_credit_spend_usd','user_authorization_sha256','attestations','idempotency_key'])
    const rationale=text(input.rationale).trim(),reviewedAt=text(input.reviewed_at),opensAt=text(input.opens_at),expiresAt=text(input.expires_at),reviewedMs=Date.parse(reviewedAt),opensMs=Date.parse(opensAt),expiresMs=Date.parse(expiresAt),maximumClaims=Number(input.maximum_claims),maximum=Number(input.maximum_provider_credit_spend_usd)
    if(input.decision!=='approved'||rationale.length<20||rationale.length>1000||/[\u0000-\u001f\u007f]/.test(rationale)||FORBIDDEN_TEXT.test(rationale)||!ACTOR.test(text(input.reviewer_id))||input.reviewer_email!=='proptimizaspa@gmail.com'||!Number.isFinite(reviewedMs)||!Number.isFinite(opensMs)||!Number.isFinite(expiresMs)||Math.abs(reviewedMs-now.getTime())>300_000||opensMs<reviewedMs||opensMs>reviewedMs+300_000||expiresMs<=opensMs||expiresMs>opensMs+600_000||expiresMs>reviewedMs+600_000||expiresMs<=now.getTime()||![input.expected_arm_id,input.expected_arm_authorization_id,input.expected_execution_authorization_id].every(value=>UUID.test(text(value)))||![input.expected_mission_sha256,input.expected_assignment_plan_sha256,input.expected_job_set_sha256,input.user_authorization_sha256].every(value=>SHA256.test(text(value)))||input.worker_id!=='broker-dispatcher-1'||!Number.isSafeInteger(maximumClaims)||maximumClaims<1||maximumClaims>6||!Number.isFinite(maximum)||maximum<0.01||maximum>0.5||!IDEMPOTENCY.test(text(input.idempotency_key)))throw new Error('fields')
    return {decision:'approved',rationale,reviewerId:text(input.reviewer_id),reviewerEmail:'proptimizaspa@gmail.com',reviewedAt:new Date(reviewedMs).toISOString(),opensAt:new Date(opensMs).toISOString(),expiresAt:new Date(expiresMs).toISOString(),expectedArmId:text(input.expected_arm_id),expectedArmAuthorizationId:text(input.expected_arm_authorization_id),expectedExecutionAuthorizationId:text(input.expected_execution_authorization_id),expectedMissionSha256:text(input.expected_mission_sha256),expectedAssignmentPlanSha256:text(input.expected_assignment_plan_sha256),expectedJobSetSha256:text(input.expected_job_set_sha256),workerId:'broker-dispatcher-1',maximumClaims,maximumProviderCreditSpendUsd:maximum,userAuthorizationSha256:text(input.user_authorization_sha256),attestations:validateRequestAttestations(input.attestations),idempotencyKey:text(input.idempotency_key)}
  } catch { throw new A1DispatchExecutionWindowError('A1_DISPATCH_EXECUTION_WINDOW_INVALID') }
}

export function assertA1DispatchExecutionWindowAdmission(arm:A1DispatchExecutionArmState|null,input:A1DispatchExecutionWindowRequest,now:Date):void {
  if(!arm||arm.armId!==input.expectedArmId||arm.authorizationId!==input.expectedArmAuthorizationId||arm.executionAuthorizationId!==input.expectedExecutionAuthorizationId||arm.missionSha256!==input.expectedMissionSha256||arm.assignmentPlanSha256!==input.expectedAssignmentPlanSha256||arm.jobSetSha256!==input.expectedJobSetSha256||arm.workerId!==input.workerId||arm.maximumClaims!==input.maximumClaims||Math.round(arm.maximumProviderCreditSpendUsd*1_000_000)!==Math.round(input.maximumProviderCreditSpendUsd*1_000_000)||arm.claimsUsed!==0||arm.executionWindowEnabled!==false||arm.dispatchClaimingPermitted!==false||Date.parse(arm.expiresAt)<=now.getTime()||Date.parse(input.expiresAt)>Date.parse(arm.expiresAt))throw new A1DispatchExecutionWindowError('A1_DISPATCH_EXECUTION_WINDOW_GATE_CLOSED')
}

export function validateA1DispatchExecutionWindowState(value:unknown):A1DispatchExecutionWindowState {
  try {
    const state=object(value)
    exactKeys(state,['windowAuthorizationId','missionId','decision','rationale','reviewerId','reviewerEmail','reviewedAt','opensAt','expiresAt','expectedArmId','expectedArmAuthorizationId','expectedExecutionAuthorizationId','expectedMissionSha256','expectedAssignmentPlanSha256','expectedJobSetSha256','workerId','maximumClaims','maximumProviderCreditSpendUsd','userAuthorizationSha256','attestations','idempotencyKey','executionWindowAuthorizationRecorded','executionWindowEnabled','dispatchClaimingPermitted','claimsUsed','jobsClaimed','executionStarted','providerCreditSpendAllowed','contactPermitted','crmWriteAllowed','maximumExternalActions','globalKillSwitchActive','externalChannelsBlocked','automaticRecontainmentArmed','productionGate','nextRequiredGate','provenance'])
    const claimsUsed=Number(state.claimsUsed),jobsClaimed=claimsUsed>0
    if(![state.windowAuthorizationId,state.missionId,state.expectedArmId,state.expectedArmAuthorizationId,state.expectedExecutionAuthorizationId].every(value=>UUID.test(text(value)))||state.decision!=='approved'||text(state.rationale).length<20||!ACTOR.test(text(state.reviewerId))||state.reviewerEmail!=='proptimizaspa@gmail.com'||![state.reviewedAt,state.opensAt,state.expiresAt].every(validDate)||![state.expectedMissionSha256,state.expectedAssignmentPlanSha256,state.expectedJobSetSha256,state.userAuthorizationSha256].every(value=>SHA256.test(text(value)))||state.workerId!=='broker-dispatcher-1'||!Number.isSafeInteger(state.maximumClaims)||Number(state.maximumClaims)<1||Number(state.maximumClaims)>6||typeof state.maximumProviderCreditSpendUsd!=='number'||state.maximumProviderCreditSpendUsd<0.01||state.maximumProviderCreditSpendUsd>0.5||!IDEMPOTENCY.test(text(state.idempotencyKey))||state.executionWindowAuthorizationRecorded!==true||state.executionWindowEnabled!==true||state.dispatchClaimingPermitted!==true||!Number.isSafeInteger(claimsUsed)||claimsUsed<0||claimsUsed>Number(state.maximumClaims)||state.jobsClaimed!==jobsClaimed||state.executionStarted!==jobsClaimed||state.providerCreditSpendAllowed!==true||state.contactPermitted!==false||state.crmWriteAllowed!==false||state.maximumExternalActions!==0||state.globalKillSwitchActive!==false||state.externalChannelsBlocked!==true||state.automaticRecontainmentArmed!==true||state.productionGate!=='single_mission_internal_execution'||state.nextRequiredGate!=='automatic_recontainment_after_terminal_or_expiry')throw new Error('state')
    validateStateAttestations(state.attestations)
    const provenance=object(state.provenance);exactKeys(provenance,['source','sourceId','observedAt','synthetic']);if(provenance.source!=='control-broker'||provenance.sourceId!==`a1-dispatch-execution-window:${state.windowAuthorizationId}`||!validDate(provenance.observedAt)||provenance.synthetic!==false)throw new Error('provenance')
    return value as A1DispatchExecutionWindowState
  } catch { throw new A1DispatchExecutionWindowError('A1_DISPATCH_EXECUTION_WINDOW_STATE_INVALID') }
}

function validateRequestAttestations(value:unknown):A1DispatchExecutionWindowAttestations{const input=object(value);exactKeys(input,['exact_arm_confirmed','exact_mission_confirmed','single_mission_window_confirmed','provider_credit_spend_authorized','automatic_recontainment_required','global_kill_switch_may_open_only_for_window','external_channels_blocked','maximum_external_actions_zero','no_contact','no_crm_write','a3_blocked','mail_blocked','telegram_blocked','timer_disabled_confirmed']);if(Object.values(input).some(entry=>entry!==true))throw new Error('attestations');return{exactArmConfirmed:true,exactMissionConfirmed:true,singleMissionWindowConfirmed:true,providerCreditSpendAuthorized:true,automaticRecontainmentRequired:true,globalKillSwitchMayOpenOnlyForWindow:true,externalChannelsBlocked:true,maximumExternalActionsZero:true,noContact:true,noCrmWrite:true,a3Blocked:true,mailBlocked:true,telegramBlocked:true,timerDisabledConfirmed:true}}
function validateStateAttestations(value:unknown):A1DispatchExecutionWindowAttestations{const input=object(value);exactKeys(input,['exactArmConfirmed','exactMissionConfirmed','singleMissionWindowConfirmed','providerCreditSpendAuthorized','automaticRecontainmentRequired','globalKillSwitchMayOpenOnlyForWindow','externalChannelsBlocked','maximumExternalActionsZero','noContact','noCrmWrite','a3Blocked','mailBlocked','telegramBlocked','timerDisabledConfirmed']);if(Object.values(input).some(entry=>entry!==true))throw new Error('attestations');return input as unknown as A1DispatchExecutionWindowAttestations}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('object');return value as Record<string,unknown>}
function text(value:unknown):string{return typeof value==='string'?value:''}
function validDate(value:unknown):boolean{return typeof value==='string'&&Number.isFinite(Date.parse(value))}
function exactKeys(value:Record<string,unknown>,expected:readonly string[]):void{const actual=Object.keys(value).sort(),wanted=[...expected].sort();if(actual.length!==wanted.length||actual.some((key,index)=>key!==wanted[index]))throw new Error('keys')}
