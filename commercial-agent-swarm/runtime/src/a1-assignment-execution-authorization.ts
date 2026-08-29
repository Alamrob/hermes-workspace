import { hashAction } from './canonical.js'
import type { AssignmentPlan } from './assignment-plan.js'
import { validateAssignmentPlan } from './assignment-plan.js'
import { hashA1AssignmentPlan, hashA1Mission } from './a1-dispatch-authorization.js'
import type { A1AssignmentEnqueueAuthorizationState } from './a1-assignment-enqueue-authorization.js'
import type { MissionRecord } from './repository.js'

export interface A1AssignmentExecutionAttestations {
  exactJobSetConfirmed: true
  authorizationRecordOnly: true
  noJobsClaimedByAuthorization: true
  noExecution: true
  noInternet: true
  noContact: true
  noCrmWrite: true
  noExternalActions: true
  noProviderCreditSpend: true
  globalKillSwitchRequired: true
  executionArmRequiresSeparateGate: true
}

export interface RecordA1AssignmentExecutionAuthorizationInput {
  authorizationId: string
  missionId: string
  traceId: string
  planVersion: string
  enqueueAuthorizationId: string
  decision: 'approved' | 'rejected'
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  expiresAt: string
  missionSha256: string
  assignmentPlanSha256: string
  jobSetSha256: string
  assignmentIds: string[]
  maximumProviderCreditSpendUsd: number
  userAuthorizationSha256: string
  attestations: A1AssignmentExecutionAttestations
  idempotencyKey: string
  requestSha256: string
}

export interface A1AssignmentExecutionAuthorizationState
  extends Omit<RecordA1AssignmentExecutionAuthorizationInput, 'requestSha256'> {
  executionAuthorizationRecorded: true
  dispatchExecutionEligible: boolean
  executionArmCreated: false
  dispatchClaimingPermitted: false
  jobsClaimed: false
  executionStarted: false
  internetAccessAllowed: false
  providerCreditSpendAllowed: false
  contactPermitted: false
  crmWriteAllowed: false
  maximumExternalActions: 0
  globalKillSwitchRequired: true
  productionGate: 'blocked'
  nextRequiredGate: 'arm_single_mission_execution_separately'
  provenance: { source: 'control-broker'; sourceId: string; observedAt: string; synthetic: false }
}

export interface A1AssignmentExecutionAuthorizationRequest {
  decision: 'approved' | 'rejected'
  rationale: string
  reviewerId: string
  reviewerEmail: 'proptimizaspa@gmail.com'
  reviewedAt: string
  expiresAt: string
  expectedMissionSha256: string
  expectedAssignmentPlanSha256: string
  expectedJobSetSha256: string
  expectedEnqueueAuthorizationId: string
  maximumProviderCreditSpendUsd: number
  userAuthorizationSha256: string
  attestations: A1AssignmentExecutionAttestations
  idempotencyKey: string
  assignmentPlan: AssignmentPlan
}

export class A1AssignmentExecutionAuthorizationError extends Error {
  constructor(readonly code: string) { super(code) }
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256=/^[0-9a-f]{64}$/
const ACTOR=/^[A-Za-z0-9._:@+-]{3,254}$/
const IDEMPOTENCY=/^a1-execution-auth:[A-Za-z0-9._:-]{8,103}$/
const FORBIDDEN_TEXT=/(https?:\/\/|www\.|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{20,})/i

export function hashA1JobSet(plan: AssignmentPlan): string {
  return hashAction({ mission_id: plan.mission_id, assignment_ids: plan.assignments.map(item => item.assignment_id) })
}

export function sumA1PlanReservations(plan: AssignmentPlan): number {
  return plan.assignments.reduce((total,item)=>total+Math.round(item.usage_value_reservation_usd*1_000_000),0)/1_000_000
}

export function validateA1AssignmentExecutionAuthorizationRequest(value: unknown, now: Date): A1AssignmentExecutionAuthorizationRequest {
  try {
    const input=object(value);exactKeys(input,['decision','rationale','reviewer_id','reviewer_email','reviewed_at','expires_at','expected_mission_sha256','expected_assignment_plan_sha256','expected_job_set_sha256','expected_enqueue_authorization_id','maximum_provider_credit_spend_usd','user_authorization_sha256','attestations','idempotency_key','assignment_plan'])
    const decision=text(input.decision),rationale=text(input.rationale).trim(),reviewedAt=text(input.reviewed_at),expiresAt=text(input.expires_at),reviewedMs=Date.parse(reviewedAt),expiresMs=Date.parse(expiresAt),maximum=Number(input.maximum_provider_credit_spend_usd),plan=validateAssignmentPlan(input.assignment_plan)
    if(!['approved','rejected'].includes(decision)||rationale.length<20||rationale.length>1000||/[\u0000-\u001f\u007f]/.test(rationale)||FORBIDDEN_TEXT.test(rationale)||!ACTOR.test(text(input.reviewer_id))||input.reviewer_email!=='proptimizaspa@gmail.com'||!Number.isFinite(reviewedMs)||!Number.isFinite(expiresMs)||Math.abs(reviewedMs-now.getTime())>300000||expiresMs<=reviewedMs||expiresMs>reviewedMs+1800000||!SHA256.test(text(input.expected_mission_sha256))||!SHA256.test(text(input.expected_assignment_plan_sha256))||!SHA256.test(text(input.expected_job_set_sha256))||!UUID.test(text(input.expected_enqueue_authorization_id))||!Number.isFinite(maximum)||maximum<0.01||maximum>0.5||Math.round(maximum*1_000_000)!==Math.round(sumA1PlanReservations(plan)*1_000_000)||!SHA256.test(text(input.user_authorization_sha256))||!IDEMPOTENCY.test(text(input.idempotency_key)))throw new Error('fields')
    return { decision:decision as 'approved'|'rejected',rationale,reviewerId:text(input.reviewer_id),reviewerEmail:'proptimizaspa@gmail.com',reviewedAt:new Date(reviewedMs).toISOString(),expiresAt:new Date(expiresMs).toISOString(),expectedMissionSha256:text(input.expected_mission_sha256),expectedAssignmentPlanSha256:text(input.expected_assignment_plan_sha256),expectedJobSetSha256:text(input.expected_job_set_sha256),expectedEnqueueAuthorizationId:text(input.expected_enqueue_authorization_id),maximumProviderCreditSpendUsd:maximum,userAuthorizationSha256:text(input.user_authorization_sha256),attestations:validateRequestAttestations(input.attestations),idempotencyKey:text(input.idempotency_key),assignmentPlan:plan }
  } catch { throw new A1AssignmentExecutionAuthorizationError('A1_ASSIGNMENT_EXECUTION_AUTHORIZATION_INVALID') }
}

export function validateA1AssignmentExecutionAuthorizationState(value: unknown): A1AssignmentExecutionAuthorizationState {
  try {
    const state=object(value);exactKeys(state,['authorizationId','missionId','traceId','planVersion','enqueueAuthorizationId','decision','rationale','reviewerId','reviewerEmail','reviewedAt','expiresAt','missionSha256','assignmentPlanSha256','jobSetSha256','assignmentIds','maximumProviderCreditSpendUsd','userAuthorizationSha256','attestations','idempotencyKey','executionAuthorizationRecorded','dispatchExecutionEligible','executionArmCreated','dispatchClaimingPermitted','jobsClaimed','executionStarted','internetAccessAllowed','providerCreditSpendAllowed','contactPermitted','crmWriteAllowed','maximumExternalActions','globalKillSwitchRequired','productionGate','nextRequiredGate','provenance'])
    const ids=state.assignmentIds
    if(!UUID.test(text(state.authorizationId))||!UUID.test(text(state.missionId))||!UUID.test(text(state.traceId))||!UUID.test(text(state.enqueueAuthorizationId))||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(text(state.planVersion))||!['approved','rejected'].includes(text(state.decision))||text(state.rationale).length<20||!ACTOR.test(text(state.reviewerId))||state.reviewerEmail!=='proptimizaspa@gmail.com'||!validDate(state.reviewedAt)||!validDate(state.expiresAt)||!SHA256.test(text(state.missionSha256))||!SHA256.test(text(state.assignmentPlanSha256))||!SHA256.test(text(state.jobSetSha256))||!Array.isArray(ids)||ids.length<1||ids.length>6||new Set(ids).size!==ids.length||ids.some(id=>!UUID.test(text(id)))||typeof state.maximumProviderCreditSpendUsd!=='number'||state.maximumProviderCreditSpendUsd<0.01||state.maximumProviderCreditSpendUsd>0.5||!SHA256.test(text(state.userAuthorizationSha256))||!IDEMPOTENCY.test(text(state.idempotencyKey))||state.executionAuthorizationRecorded!==true||state.dispatchExecutionEligible!==(state.decision==='approved')||state.executionArmCreated!==false||state.dispatchClaimingPermitted!==false||state.jobsClaimed!==false||state.executionStarted!==false||state.internetAccessAllowed!==false||state.providerCreditSpendAllowed!==false||state.contactPermitted!==false||state.crmWriteAllowed!==false||state.maximumExternalActions!==0||state.globalKillSwitchRequired!==true||state.productionGate!=='blocked'||state.nextRequiredGate!=='arm_single_mission_execution_separately')throw new Error('state')
    validateStateAttestations(state.attestations);const provenance=object(state.provenance);exactKeys(provenance,['source','sourceId','observedAt','synthetic']);if(provenance.source!=='control-broker'||provenance.sourceId!==`a1-assignment-execution-authorization:${state.authorizationId}`||!validDate(provenance.observedAt)||provenance.synthetic!==false)throw new Error('provenance')
    return value as A1AssignmentExecutionAuthorizationState
  } catch { throw new A1AssignmentExecutionAuthorizationError('A1_ASSIGNMENT_EXECUTION_AUTHORIZATION_STATE_INVALID') }
}

export function assertA1AssignmentExecutionAuthorizationAdmission(mission: MissionRecord,plan: AssignmentPlan,enqueueAuthorization:A1AssignmentEnqueueAuthorizationState|null,executionAuthorization:A1AssignmentExecutionAuthorizationState|null,now:Date):void {
  if(!enqueueAuthorization||!executionAuthorization)throw new A1AssignmentExecutionAuthorizationError('A1_ASSIGNMENT_EXECUTION_AUTHORIZATION_GATE_CLOSED')
  const state=validateA1AssignmentExecutionAuthorizationState(executionAuthorization)
  if(state.decision!=='approved'||Date.parse(state.expiresAt)<=now.getTime()||Date.parse(enqueueAuthorization.expiresAt)<=now.getTime()||state.enqueueAuthorizationId!==enqueueAuthorization.authorizationId||state.missionId!==mission.mission_id||state.traceId!==plan.trace_id||state.planVersion!==plan.plan_version||state.missionSha256!==hashA1Mission(mission)||state.assignmentPlanSha256!==hashA1AssignmentPlan(plan)||state.assignmentPlanSha256!==enqueueAuthorization.assignmentPlanSha256||state.jobSetSha256!==hashA1JobSet(plan)||state.assignmentIds.join('\0')!==plan.assignments.map(item=>item.assignment_id).join('\0')||Math.round(state.maximumProviderCreditSpendUsd*1_000_000)!==Math.round(sumA1PlanReservations(plan)*1_000_000))throw new A1AssignmentExecutionAuthorizationError('A1_ASSIGNMENT_EXECUTION_AUTHORIZATION_GATE_CLOSED')
}

function validateRequestAttestations(value:unknown):A1AssignmentExecutionAttestations{const input=object(value);exactKeys(input,['exact_job_set_confirmed','authorization_record_only','no_jobs_claimed_by_authorization','no_execution','no_internet','no_contact','no_crm_write','no_external_actions','no_provider_credit_spend','global_kill_switch_required','execution_arm_requires_separate_gate']);if(Object.values(input).some(entry=>entry!==true))throw new Error('attestations');return{exactJobSetConfirmed:true,authorizationRecordOnly:true,noJobsClaimedByAuthorization:true,noExecution:true,noInternet:true,noContact:true,noCrmWrite:true,noExternalActions:true,noProviderCreditSpend:true,globalKillSwitchRequired:true,executionArmRequiresSeparateGate:true}}
function validateStateAttestations(value:unknown):A1AssignmentExecutionAttestations{const input=object(value);exactKeys(input,['exactJobSetConfirmed','authorizationRecordOnly','noJobsClaimedByAuthorization','noExecution','noInternet','noContact','noCrmWrite','noExternalActions','noProviderCreditSpend','globalKillSwitchRequired','executionArmRequiresSeparateGate']);if(Object.values(input).some(entry=>entry!==true))throw new Error('attestations');return input as unknown as A1AssignmentExecutionAttestations}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('object');return value as Record<string,unknown>}function text(value:unknown):string{return typeof value==='string'?value:''}function validDate(value:unknown):boolean{return typeof value==='string'&&Number.isFinite(Date.parse(value))}function exactKeys(value:Record<string,unknown>,expected:readonly string[]):void{const actual=Object.keys(value).sort(),wanted=[...expected].sort();if(actual.length!==wanted.length||actual.some((key,index)=>key!==wanted[index]))throw new Error('keys')}
