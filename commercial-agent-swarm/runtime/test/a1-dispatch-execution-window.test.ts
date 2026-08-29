import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  assertA1DispatchExecutionWindowAdmission,
  validateA1DispatchExecutionWindowRequest,
  validateA1DispatchExecutionWindowState,
} from '../src/a1-dispatch-execution-window.js'
import type { A1DispatchExecutionArmState } from '../src/a1-dispatch-execution-arm.js'

const NOW = new Date('2026-08-29T20:00:00.000Z')
const MISSION = 'a2500000-0000-4500-8500-000000000053'
const ARM = 'a2500000-0000-4500-8500-000000000127'
const ARM_AUTH = 'a2500000-0000-4500-8500-000000001127'
const EXEC_AUTH = 'a2500000-0000-4500-8500-000000000126'
const HASH = 'a'.repeat(64)
const attestations = {
  exact_arm_confirmed:true,exact_mission_confirmed:true,single_mission_window_confirmed:true,
  provider_credit_spend_authorized:true,automatic_recontainment_required:true,
  global_kill_switch_may_open_only_for_window:true,external_channels_blocked:true,
  maximum_external_actions_zero:true,no_contact:true,no_crm_write:true,a3_blocked:true,
  mail_blocked:true,telegram_blocked:true,timer_disabled_confirmed:true,
} as const
function request(){return{decision:'approved',rationale:'Autoriza una sola ventana interna A1 con autocontención obligatoria.',reviewer_id:'director',reviewer_email:'proptimizaspa@gmail.com',reviewed_at:NOW.toISOString(),opens_at:NOW.toISOString(),expires_at:'2026-08-29T20:05:00.000Z',expected_arm_id:ARM,expected_arm_authorization_id:ARM_AUTH,expected_execution_authorization_id:EXEC_AUTH,expected_mission_sha256:HASH,expected_assignment_plan_sha256:'b'.repeat(64),expected_job_set_sha256:'c'.repeat(64),worker_id:'broker-dispatcher-1',maximum_claims:1,maximum_provider_credit_spend_usd:0.01,user_authorization_sha256:'d'.repeat(64),attestations,idempotency_key:'a1-execution-window:mission-00000053'}}
function arm():A1DispatchExecutionArmState{return{armId:ARM,authorizationId:ARM_AUTH,missionId:MISSION,traceId:'a2500000-0000-4500-8500-000000000001',planVersion:'a1-plan-v1',executionAuthorizationId:EXEC_AUTH,decision:'approved',rationale:'Crea solamente el arm exacto y no ejecuta trabajos.',reviewerId:'director',reviewerEmail:'proptimizaspa@gmail.com',reviewedAt:NOW.toISOString(),startsAt:NOW.toISOString(),expiresAt:'2026-08-29T20:10:00.000Z',missionSha256:HASH,assignmentPlanSha256:'b'.repeat(64),jobSetSha256:'c'.repeat(64),assignmentIds:['a2500000-0000-4500-8500-000000000001'],workerId:'broker-dispatcher-1',maximumClaims:1,maximumProviderCreditSpendUsd:0.01,userAuthorizationSha256:'e'.repeat(64),attestations:{exactJobSetConfirmed:true,singleUseArmConfirmed:true,armCreationOnly:true,noJobsClaimedByArmCreation:true,noExecution:true,noInternet:true,noContact:true,noCrmWrite:true,noExternalActions:true,noProviderCreditSpend:true,globalKillSwitchMustRemainActive:true,dispatcherWindowRequiresSeparateGate:true,externalChannelsBlocked:true,timerDisabledConfirmed:true},idempotencyKey:'a1-execution-arm:mission-00000053',armAuthorizationRecorded:true,executionArmCreated:true,claimsUsed:0,executionWindowEnabled:false,dispatchClaimingPermitted:false,jobsClaimed:false,executionStarted:false,internetAccessAllowed:false,providerCreditSpendAllowed:false,contactPermitted:false,crmWriteAllowed:false,maximumExternalActions:0,globalKillSwitchActive:true,externalChannelsBlocked:true,dispatcherTimerDisabled:true,productionGate:'blocked',nextRequiredGate:'open_single_mission_execution_window_separately',provenance:{source:'control-broker',sourceId:`a1-dispatch-execution-arm:${ARM}`,observedAt:NOW.toISOString(),synthetic:false}}}

describe('A1 dispatch execution window',()=>{
  it('admits only the exact short-lived human authorization',()=>{const parsed=validateA1DispatchExecutionWindowRequest(request(),NOW);assert.doesNotThrow(()=>assertA1DispatchExecutionWindowAdmission(arm(),parsed,NOW));assert.equal(parsed.maximumProviderCreditSpendUsd,0.01)})
  it('rejects stale, overlong, mutated, or externally permissive requests',()=>{for(const mutation of[{expires_at:'2026-08-29T20:11:00.000Z'},{expected_arm_id:'a2500000-0000-4500-8500-000000000999'},{attestations:{...attestations,no_contact:false}}])assert.throws(()=>{const parsed=validateA1DispatchExecutionWindowRequest({...request(),...mutation},NOW);assertA1DispatchExecutionWindowAdmission(arm(),parsed,NOW)},/A1_DISPATCH_EXECUTION_WINDOW_(INVALID|GATE_CLOSED)/)})
  it('validates active state before and after a claim',()=>{const parsed=validateA1DispatchExecutionWindowRequest(request(),NOW);const base={windowAuthorizationId:'a2500000-0000-4500-8500-000000000128',missionId:MISSION,...parsed,executionWindowAuthorizationRecorded:true,executionWindowEnabled:true,dispatchClaimingPermitted:true,claimsUsed:0,jobsClaimed:false,executionStarted:false,providerCreditSpendAllowed:true,contactPermitted:false,crmWriteAllowed:false,maximumExternalActions:0,globalKillSwitchActive:false,externalChannelsBlocked:true,automaticRecontainmentArmed:true,productionGate:'single_mission_internal_execution',nextRequiredGate:'automatic_recontainment_after_terminal_or_expiry',provenance:{source:'control-broker',sourceId:'a1-dispatch-execution-window:a2500000-0000-4500-8500-000000000128',observedAt:NOW.toISOString(),synthetic:false}};assert.equal(validateA1DispatchExecutionWindowState(base).claimsUsed,0);assert.equal(validateA1DispatchExecutionWindowState({...base,claimsUsed:1,jobsClaimed:true,executionStarted:true}).claimsUsed,1);assert.throws(()=>validateA1DispatchExecutionWindowState({...base,claimsUsed:1,jobsClaimed:false}),/STATE_INVALID/)})
  it('ships least privilege, exact claim interlock, auto-recontainment, and fail-closed rollback',async()=>{const sql=await readFile(new URL('../migrations/034_a1_dispatch_execution_window.sql',import.meta.url),'utf8'),rollback=await readFile(new URL('../migrations/034_a1_dispatch_execution_window.rollback.sql',import.meta.url),'utf8');assert.match(sql,/commercial_safety_operator/);assert.match(sql,/JOIN control\.a1_dispatch_execution_window_authorizations/);assert.match(sql,/CREATE TRIGGER a1_dispatch_execution_recontain/);assert.match(sql,/WINDOW_EXPIRED/);assert.match(sql,/maximum_external_actions_zero/);assert.doesNotMatch(sql,/mail\.send|integration\.enqueue_crm_change/i);assert.match(rollback,/A1_DISPATCH_EXECUTION_WINDOW_HISTORY_PRESENT/)})
})
