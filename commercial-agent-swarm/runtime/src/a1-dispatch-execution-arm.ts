import { hashAction } from './canonical.js'
import type { AssignmentPlan } from './assignment-plan.js'
import { validateAssignmentPlan } from './assignment-plan.js'
import { hashA1AssignmentPlan, hashA1Mission } from './a1-dispatch-authorization.js'
import {
  hashA1JobSet,
  sumA1PlanReservations,
  type A1AssignmentExecutionAuthorizationState,
} from './a1-assignment-execution-authorization.js'
import type { MissionRecord } from './repository.js'

export interface A1DispatchExecutionArmAttestations {
  exactJobSetConfirmed: true
  singleUseArmConfirmed: true
  armCreationOnly: true
  noJobsClaimedByArmCreation: true
  noExecution: true
  noInternet: true
  noContact: true
  noCrmWrite: true
  noExternalActions: true
  noProviderCreditSpend: true
  globalKillSwitchMustRemainActive: true
  dispatcherWindowRequiresSeparateGate: true
  externalChannelsBlocked: true
  timerDisabledConfirmed: true
}

export interface RecordA1DispatchExecutionArmInput {
  armId: string
  authorizationId: string
  missionId: string
  traceId: string
  planVersion: string
  executionAuthorizationId: string
  decision: 'approved'
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  startsAt: string
  expiresAt: string
  missionSha256: string
  assignmentPlanSha256: string
  jobSetSha256: string
  assignmentIds: string[]
  workerId: string
  maximumClaims: number
  maximumProviderCreditSpendUsd: number
  userAuthorizationSha256: string
  attestations: A1DispatchExecutionArmAttestations
  idempotencyKey: string
  requestSha256: string
}

export interface A1DispatchExecutionArmState
  extends Omit<RecordA1DispatchExecutionArmInput, 'requestSha256'> {
  armAuthorizationRecorded: true
  executionArmCreated: true
  claimsUsed: 0
  executionWindowEnabled: false
  dispatchClaimingPermitted: false
  jobsClaimed: false
  executionStarted: false
  internetAccessAllowed: false
  providerCreditSpendAllowed: false
  contactPermitted: false
  crmWriteAllowed: false
  maximumExternalActions: 0
  globalKillSwitchActive: true
  externalChannelsBlocked: true
  dispatcherTimerDisabled: true
  productionGate: 'blocked'
  nextRequiredGate: 'open_single_mission_execution_window_separately'
  provenance: { source: 'control-broker'; sourceId: string; observedAt: string; synthetic: false }
}

export interface A1DispatchExecutionArmRequest {
  decision: 'approved'
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  startsAt: string
  expiresAt: string
  expectedMissionSha256: string
  expectedAssignmentPlanSha256: string
  expectedJobSetSha256: string
  expectedExecutionAuthorizationId: string
  workerId: string
  maximumClaims: number
  maximumProviderCreditSpendUsd: number
  userAuthorizationSha256: string
  attestations: A1DispatchExecutionArmAttestations
  idempotencyKey: string
  assignmentPlan: AssignmentPlan
}

export class A1DispatchExecutionArmError extends Error {
  constructor(readonly code: string) { super(code) }
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256=/^[0-9a-f]{64}$/
const ACTOR=/^[A-Za-z0-9._:@+-]{3,254}$/
const WORKER=/^[A-Za-z0-9._:-]{3,128}$/
const IDEMPOTENCY=/^a1-execution-arm:[A-Za-z0-9._:-]{8,103}$/
const FORBIDDEN_TEXT=/(https?:\/\/|www\.|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{20,})/i

export function hashA1DispatchExecutionArm(input: {
  missionId: string
  executionAuthorizationId: string
  jobSetSha256: string
  workerId: string
  startsAt: string
  expiresAt: string
  maximumClaims: number
  maximumProviderCreditSpendUsd: number
}): string {
  return hashAction({
    mission_id: input.missionId,
    execution_authorization_id: input.executionAuthorizationId,
    job_set_sha256: input.jobSetSha256,
    worker_id: input.workerId,
    starts_at: input.startsAt,
    expires_at: input.expiresAt,
    maximum_claims: input.maximumClaims,
    maximum_provider_credit_spend_usd: input.maximumProviderCreditSpendUsd,
  })
}

export function validateA1DispatchExecutionArmRequest(value: unknown, now: Date): A1DispatchExecutionArmRequest {
  try {
    const input=object(value)
    exactKeys(input,['decision','rationale','reviewer_id','reviewer_email','reviewed_at','starts_at','expires_at','expected_mission_sha256','expected_assignment_plan_sha256','expected_job_set_sha256','expected_execution_authorization_id','worker_id','maximum_claims','maximum_provider_credit_spend_usd','user_authorization_sha256','attestations','idempotency_key','assignment_plan'])
    const decision=text(input.decision),rationale=text(input.rationale).trim(),reviewedAt=text(input.reviewed_at),startsAt=text(input.starts_at),expiresAt=text(input.expires_at),reviewedMs=Date.parse(reviewedAt),startsMs=Date.parse(startsAt),expiresMs=Date.parse(expiresAt),workerId=text(input.worker_id),maximumClaims=Number(input.maximum_claims),maximum=Number(input.maximum_provider_credit_spend_usd),plan=validateAssignmentPlan(input.assignment_plan)
    if(decision!=='approved'||rationale.length<20||rationale.length>1000||/[\u0000-\u001f\u007f]/.test(rationale)||FORBIDDEN_TEXT.test(rationale)||!ACTOR.test(text(input.reviewer_id))||input.reviewer_email!=='proptimizaspa@gmail.com'||!Number.isFinite(reviewedMs)||!Number.isFinite(startsMs)||!Number.isFinite(expiresMs)||Math.abs(reviewedMs-now.getTime())>300000||startsMs<reviewedMs||startsMs>reviewedMs+300000||expiresMs<=startsMs||expiresMs>startsMs+1800000||expiresMs>reviewedMs+1800000||!SHA256.test(text(input.expected_mission_sha256))||!SHA256.test(text(input.expected_assignment_plan_sha256))||!SHA256.test(text(input.expected_job_set_sha256))||!UUID.test(text(input.expected_execution_authorization_id))||!WORKER.test(workerId)||!Number.isSafeInteger(maximumClaims)||maximumClaims!==plan.assignments.length||!Number.isFinite(maximum)||maximum<0.01||maximum>0.5||Math.round(maximum*1_000_000)!==Math.round(sumA1PlanReservations(plan)*1_000_000)||!SHA256.test(text(input.user_authorization_sha256))||!IDEMPOTENCY.test(text(input.idempotency_key)))throw new Error('fields')
    return {decision:'approved',rationale,reviewerId:text(input.reviewer_id),reviewerEmail:'proptimizaspa@gmail.com',reviewedAt:new Date(reviewedMs).toISOString(),startsAt:new Date(startsMs).toISOString(),expiresAt:new Date(expiresMs).toISOString(),expectedMissionSha256:text(input.expected_mission_sha256),expectedAssignmentPlanSha256:text(input.expected_assignment_plan_sha256),expectedJobSetSha256:text(input.expected_job_set_sha256),expectedExecutionAuthorizationId:text(input.expected_execution_authorization_id),workerId,maximumClaims,maximumProviderCreditSpendUsd:maximum,userAuthorizationSha256:text(input.user_authorization_sha256),attestations:validateRequestAttestations(input.attestations),idempotencyKey:text(input.idempotency_key),assignmentPlan:plan}
  } catch { throw new A1DispatchExecutionArmError('A1_DISPATCH_EXECUTION_ARM_INVALID') }
}

export function validateA1DispatchExecutionArmState(value: unknown): A1DispatchExecutionArmState {
  try {
    const state=object(value)
    exactKeys(state,['armId','authorizationId','missionId','traceId','planVersion','executionAuthorizationId','decision','rationale','reviewerId','reviewerEmail','reviewedAt','startsAt','expiresAt','missionSha256','assignmentPlanSha256','jobSetSha256','assignmentIds','workerId','maximumClaims','maximumProviderCreditSpendUsd','userAuthorizationSha256','attestations','idempotencyKey','armAuthorizationRecorded','executionArmCreated','claimsUsed','executionWindowEnabled','dispatchClaimingPermitted','jobsClaimed','executionStarted','internetAccessAllowed','providerCreditSpendAllowed','contactPermitted','crmWriteAllowed','maximumExternalActions','globalKillSwitchActive','externalChannelsBlocked','dispatcherTimerDisabled','productionGate','nextRequiredGate','provenance'])
    const ids=state.assignmentIds
    if(!UUID.test(text(state.armId))||!UUID.test(text(state.authorizationId))||!UUID.test(text(state.missionId))||!UUID.test(text(state.traceId))||!UUID.test(text(state.executionAuthorizationId))||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(text(state.planVersion))||state.decision!=='approved'||text(state.rationale).length<20||!ACTOR.test(text(state.reviewerId))||state.reviewerEmail!=='proptimizaspa@gmail.com'||!validDate(state.reviewedAt)||!validDate(state.startsAt)||!validDate(state.expiresAt)||!SHA256.test(text(state.missionSha256))||!SHA256.test(text(state.assignmentPlanSha256))||!SHA256.test(text(state.jobSetSha256))||!Array.isArray(ids)||ids.length<1||ids.length>6||new Set(ids).size!==ids.length||ids.some(id=>!UUID.test(text(id)))||!WORKER.test(text(state.workerId))||!Number.isSafeInteger(state.maximumClaims)||state.maximumClaims!==ids.length||typeof state.maximumProviderCreditSpendUsd!=='number'||state.maximumProviderCreditSpendUsd<0.01||state.maximumProviderCreditSpendUsd>0.5||!SHA256.test(text(state.userAuthorizationSha256))||!IDEMPOTENCY.test(text(state.idempotencyKey))||state.armAuthorizationRecorded!==true||state.executionArmCreated!==true||state.claimsUsed!==0||state.executionWindowEnabled!==false||state.dispatchClaimingPermitted!==false||state.jobsClaimed!==false||state.executionStarted!==false||state.internetAccessAllowed!==false||state.providerCreditSpendAllowed!==false||state.contactPermitted!==false||state.crmWriteAllowed!==false||state.maximumExternalActions!==0||state.globalKillSwitchActive!==true||state.externalChannelsBlocked!==true||state.dispatcherTimerDisabled!==true||state.productionGate!=='blocked'||state.nextRequiredGate!=='open_single_mission_execution_window_separately')throw new Error('state')
    validateStateAttestations(state.attestations)
    const provenance=object(state.provenance);exactKeys(provenance,['source','sourceId','observedAt','synthetic']);if(provenance.source!=='control-broker'||provenance.sourceId!==`a1-dispatch-execution-arm:${state.armId}`||!validDate(provenance.observedAt)||provenance.synthetic!==false)throw new Error('provenance')
    return value as A1DispatchExecutionArmState
  } catch { throw new A1DispatchExecutionArmError('A1_DISPATCH_EXECUTION_ARM_STATE_INVALID') }
}

export function assertA1DispatchExecutionArmAdmission(mission:MissionRecord,plan:AssignmentPlan,executionAuthorization:A1AssignmentExecutionAuthorizationState|null,input:A1DispatchExecutionArmRequest,now:Date):void {
  if(!executionAuthorization)throw new A1DispatchExecutionArmError('A1_DISPATCH_EXECUTION_ARM_GATE_CLOSED')
  if(executionAuthorization.decision!=='approved'||Date.parse(executionAuthorization.expiresAt)<=now.getTime()||input.expiresAt>executionAuthorization.expiresAt||executionAuthorization.executionAuthorizationRecorded!==true||executionAuthorization.executionArmCreated!==false||executionAuthorization.dispatchClaimingPermitted!==false||executionAuthorization.missionId!==mission.mission_id||executionAuthorization.traceId!==plan.trace_id||executionAuthorization.planVersion!==plan.plan_version||executionAuthorization.authorizationId!==input.expectedExecutionAuthorizationId||input.expectedMissionSha256!==hashA1Mission(mission)||input.expectedAssignmentPlanSha256!==hashA1AssignmentPlan(plan)||input.expectedJobSetSha256!==hashA1JobSet(plan)||executionAuthorization.missionSha256!==input.expectedMissionSha256||executionAuthorization.assignmentPlanSha256!==input.expectedAssignmentPlanSha256||executionAuthorization.jobSetSha256!==input.expectedJobSetSha256||executionAuthorization.assignmentIds.join('\0')!==plan.assignments.map(item=>item.assignment_id).join('\0')||input.maximumClaims!==plan.assignments.length||Math.round(input.maximumProviderCreditSpendUsd*1_000_000)!==Math.round(sumA1PlanReservations(plan)*1_000_000))throw new A1DispatchExecutionArmError('A1_DISPATCH_EXECUTION_ARM_GATE_CLOSED')
}

function validateRequestAttestations(value:unknown):A1DispatchExecutionArmAttestations{const input=object(value);exactKeys(input,['exact_job_set_confirmed','single_use_arm_confirmed','arm_creation_only','no_jobs_claimed_by_arm_creation','no_execution','no_internet','no_contact','no_crm_write','no_external_actions','no_provider_credit_spend','global_kill_switch_must_remain_active','dispatcher_window_requires_separate_gate','external_channels_blocked','timer_disabled_confirmed']);if(Object.values(input).some(entry=>entry!==true))throw new Error('attestations');return{exactJobSetConfirmed:true,singleUseArmConfirmed:true,armCreationOnly:true,noJobsClaimedByArmCreation:true,noExecution:true,noInternet:true,noContact:true,noCrmWrite:true,noExternalActions:true,noProviderCreditSpend:true,globalKillSwitchMustRemainActive:true,dispatcherWindowRequiresSeparateGate:true,externalChannelsBlocked:true,timerDisabledConfirmed:true}}
function validateStateAttestations(value:unknown):A1DispatchExecutionArmAttestations{const input=object(value);exactKeys(input,['exactJobSetConfirmed','singleUseArmConfirmed','armCreationOnly','noJobsClaimedByArmCreation','noExecution','noInternet','noContact','noCrmWrite','noExternalActions','noProviderCreditSpend','globalKillSwitchMustRemainActive','dispatcherWindowRequiresSeparateGate','externalChannelsBlocked','timerDisabledConfirmed']);if(Object.values(input).some(entry=>entry!==true))throw new Error('attestations');return input as unknown as A1DispatchExecutionArmAttestations}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('object');return value as Record<string,unknown>}function text(value:unknown):string{return typeof value==='string'?value:''}function validDate(value:unknown):boolean{return typeof value==='string'&&Number.isFinite(Date.parse(value))}function exactKeys(value:Record<string,unknown>,expected:readonly string[]):void{const actual=Object.keys(value).sort(),wanted=[...expected].sort();if(actual.length!==wanted.length||actual.some((key,index)=>key!==wanted[index]))throw new Error('keys')}
