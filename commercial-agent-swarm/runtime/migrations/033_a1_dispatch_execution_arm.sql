BEGIN;

DO $$BEGIN
 IF EXISTS(SELECT 1 FROM control.a1_dispatch_execution_arms) THEN
  RAISE EXCEPTION 'A1_DISPATCH_EXECUTION_ARM_LEGACY_ROWS_PRESENT';
 END IF;
END$$;

CREATE TABLE control.a1_dispatch_execution_arm_authorizations(
  authorization_id uuid PRIMARY KEY,
  mission_id uuid NOT NULL UNIQUE REFERENCES control.missions(mission_id) ON DELETE RESTRICT,
  trace_id uuid NOT NULL,
  plan_version text NOT NULL CHECK(plan_version~'^[a-z0-9][a-z0-9._-]{0,63}$'),
  execution_authorization_id uuid NOT NULL UNIQUE REFERENCES control.a1_assignment_execution_authorizations(authorization_id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK(decision='approved'),
  rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 20 AND 1000),
  reviewer_id text NOT NULL CHECK(reviewer_id~'^[A-Za-z0-9._:@+-]{3,254}$'),
  reviewer_email text NOT NULL CHECK(reviewer_email='proptimizaspa@gmail.com'),
  reviewed_at timestamptz NOT NULL,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  mission_sha256 text NOT NULL CHECK(mission_sha256~'^[0-9a-f]{64}$'),
  assignment_plan_sha256 text NOT NULL UNIQUE CHECK(assignment_plan_sha256~'^[0-9a-f]{64}$'),
  job_set_sha256 text NOT NULL UNIQUE CHECK(job_set_sha256~'^[0-9a-f]{64}$'),
  assignment_ids uuid[] NOT NULL CHECK(cardinality(assignment_ids) BETWEEN 1 AND 6),
  worker_id text NOT NULL CHECK(worker_id~'^[A-Za-z0-9._:-]{3,128}$'),
  maximum_claims integer NOT NULL CHECK(maximum_claims BETWEEN 1 AND 6),
  maximum_provider_credit_spend_usd numeric(12,6) NOT NULL CHECK(maximum_provider_credit_spend_usd BETWEEN 0.01 AND 0.5),
  user_authorization_sha256 text NOT NULL UNIQUE CHECK(user_authorization_sha256~'^[0-9a-f]{64}$'),
  attestations jsonb NOT NULL CHECK(attestations=jsonb_build_object('exact_job_set_confirmed',true,'single_use_arm_confirmed',true,'arm_creation_only',true,'no_jobs_claimed_by_arm_creation',true,'no_execution',true,'no_internet',true,'no_contact',true,'no_crm_write',true,'no_external_actions',true,'no_provider_credit_spend',true,'global_kill_switch_must_remain_active',true,'dispatcher_window_requires_separate_gate',true,'external_channels_blocked',true,'timer_disabled_confirmed',true)),
  idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key~'^a1-execution-arm:[A-Za-z0-9._:-]{8,103}$'),
  request_sha256 text NOT NULL CHECK(request_sha256~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(starts_at>=reviewed_at AND starts_at<=reviewed_at+interval '5 minutes'),
  CHECK(expires_at>starts_at AND expires_at<=starts_at+interval '30 minutes' AND expires_at<=reviewed_at+interval '30 minutes'),
  CHECK(maximum_claims=cardinality(assignment_ids))
);

ALTER TABLE control.a1_dispatch_execution_arms
  ADD COLUMN arm_authorization_id uuid NOT NULL UNIQUE REFERENCES control.a1_dispatch_execution_arm_authorizations(authorization_id) ON DELETE RESTRICT;

CREATE TABLE control.a1_dispatch_execution_control(
  control_id smallint PRIMARY KEY CHECK(control_id=1),
  claiming_enabled boolean NOT NULL DEFAULT false,
  mission_id uuid NULL REFERENCES control.missions(mission_id) ON DELETE RESTRICT,
  arm_id uuid NULL REFERENCES control.a1_dispatch_execution_arms(arm_id) ON DELETE RESTRICT,
  worker_id text NULL,
  opened_at timestamptz NULL,
  expires_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((NOT claiming_enabled AND mission_id IS NULL AND arm_id IS NULL AND worker_id IS NULL AND opened_at IS NULL AND expires_at IS NULL) OR (claiming_enabled AND mission_id IS NOT NULL AND arm_id IS NOT NULL AND worker_id~'^[A-Za-z0-9._:-]{3,128}$' AND opened_at IS NOT NULL AND expires_at>opened_at AND expires_at<=opened_at+interval '30 minutes'))
);
INSERT INTO control.a1_dispatch_execution_control(control_id,claiming_enabled)VALUES(1,false);

CREATE OR REPLACE FUNCTION control.get_a1_dispatch_execution_arm(uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'armId',arm.arm_id,'authorizationId',auth.authorization_id,'missionId',auth.mission_id,'traceId',auth.trace_id,'planVersion',auth.plan_version,'executionAuthorizationId',auth.execution_authorization_id,
  'decision',auth.decision,'rationale',auth.rationale,'reviewerId',auth.reviewer_id,'reviewerEmail',auth.reviewer_email,
  'reviewedAt',to_char(auth.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'startsAt',to_char(auth.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(auth.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'missionSha256',auth.mission_sha256,'assignmentPlanSha256',auth.assignment_plan_sha256,'jobSetSha256',auth.job_set_sha256,'assignmentIds',to_jsonb(auth.assignment_ids),'workerId',auth.worker_id,'maximumClaims',auth.maximum_claims,'maximumProviderCreditSpendUsd',auth.maximum_provider_credit_spend_usd::double precision,
  'userAuthorizationSha256',auth.user_authorization_sha256,'attestations',jsonb_build_object('exactJobSetConfirmed',true,'singleUseArmConfirmed',true,'armCreationOnly',true,'noJobsClaimedByArmCreation',true,'noExecution',true,'noInternet',true,'noContact',true,'noCrmWrite',true,'noExternalActions',true,'noProviderCreditSpend',true,'globalKillSwitchMustRemainActive',true,'dispatcherWindowRequiresSeparateGate',true,'externalChannelsBlocked',true,'timerDisabledConfirmed',true),'idempotencyKey',auth.idempotency_key,
  'armAuthorizationRecorded',true,'executionArmCreated',true,'claimsUsed',arm.claims_used,'executionWindowEnabled',false,'dispatchClaimingPermitted',false,'jobsClaimed',false,'executionStarted',false,'internetAccessAllowed',false,'providerCreditSpendAllowed',false,'contactPermitted',false,'crmWriteAllowed',false,'maximumExternalActions',0,
  'globalKillSwitchActive',true,'externalChannelsBlocked',true,'dispatcherTimerDisabled',true,'productionGate','blocked','nextRequiredGate','open_single_mission_execution_window_separately',
  'provenance',jsonb_build_object('source','control-broker','sourceId','a1-dispatch-execution-arm:'||arm.arm_id::text,'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'synthetic',false)
 )
 FROM control.a1_dispatch_execution_arm_authorizations auth
 JOIN control.a1_dispatch_execution_arms arm ON arm.arm_authorization_id=auth.authorization_id
 JOIN control.a1_dispatch_execution_control ctl ON ctl.control_id=1
 WHERE auth.mission_id=$1 AND ctl.claiming_enabled=false AND control.is_global_kill_switch_active() AND control.external_actions_blocked() AND arm.claims_used=0
$$;

CREATE OR REPLACE FUNCTION control.record_a1_dispatch_execution_arm(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,text,text,text,uuid[],text,integer,numeric,text,jsonb,text,text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing control.a1_dispatch_execution_arm_authorizations%ROWTYPE;parent control.a1_assignment_execution_authorizations%ROWTYPE;mission_payload jsonb;now_at timestamptz:=clock_timestamp();stored_ids uuid[];stored_total numeric;ctl control.a1_dispatch_execution_control%ROWTYPE;guard control.usage_budget_control%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext($23));
 PERFORM pg_advisory_xact_lock(hashtext($3::text));
 SELECT*INTO existing FROM control.a1_dispatch_execution_arm_authorizations WHERE authorization_id=$2 OR mission_id=$3 OR execution_authorization_id=$6 OR assignment_plan_sha256=$15 OR job_set_sha256=$16 OR user_authorization_sha256=$21 OR idempotency_key=$23;
 IF FOUND THEN
  IF existing.authorization_id<>$2 OR existing.mission_id<>$3 OR existing.trace_id<>$4 OR existing.plan_version<>$5 OR existing.execution_authorization_id<>$6 OR existing.decision<>$7 OR existing.rationale<>btrim($8) OR existing.reviewer_id<>$9 OR existing.reviewer_email<>$10 OR existing.reviewed_at<>$11 OR existing.starts_at<>$12 OR existing.expires_at<>$13 OR existing.mission_sha256<>$14 OR existing.assignment_plan_sha256<>$15 OR existing.job_set_sha256<>$16 OR existing.assignment_ids<>$17 OR existing.worker_id<>$18 OR existing.maximum_claims<>$19 OR existing.maximum_provider_credit_spend_usd<>$20 OR existing.user_authorization_sha256<>$21 OR existing.attestations<>$22 OR existing.idempotency_key<>$23 OR existing.request_sha256<>$24 OR NOT EXISTS(SELECT 1 FROM control.a1_dispatch_execution_arms WHERE arm_id=$1 AND arm_authorization_id=existing.authorization_id) THEN RAISE EXCEPTION'A1_DISPATCH_EXECUTION_ARM_IMMUTABLE_CONFLICT';END IF;
  RETURN control.get_a1_dispatch_execution_arm(existing.mission_id);
 END IF;
 IF $5!~'^[a-z0-9][a-z0-9._-]{0,63}$' OR $7<>'approved' OR length(btrim($8)) NOT BETWEEN 20 AND 1000 OR $8~'[[:cntrl:]]' OR $8~*'(https?://|www[.]|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer[[:space:]]+[A-Za-z0-9._~-]{20,})' OR $9!~'^[A-Za-z0-9._:@+-]{3,254}$' OR $10<>'proptimizaspa@gmail.com' OR abs(extract(epoch FROM now_at-$11))>300 OR $12<$11 OR $12>$11+interval '5 minutes' OR $13<=$12 OR $13>$12+interval '30 minutes' OR $13>$11+interval '30 minutes' OR $13<=now_at OR $14!~'^[0-9a-f]{64}$' OR $15!~'^[0-9a-f]{64}$' OR $16!~'^[0-9a-f]{64}$' OR cardinality($17) NOT BETWEEN 1 AND 6 OR cardinality($17)<>(SELECT count(DISTINCT x) FROM unnest($17)x) OR $18!~'^[A-Za-z0-9._:-]{3,128}$' OR $19<>cardinality($17) OR $20 NOT BETWEEN 0.01 AND 0.5 OR $21!~'^[0-9a-f]{64}$' OR $22<>jsonb_build_object('exact_job_set_confirmed',true,'single_use_arm_confirmed',true,'arm_creation_only',true,'no_jobs_claimed_by_arm_creation',true,'no_execution',true,'no_internet',true,'no_contact',true,'no_crm_write',true,'no_external_actions',true,'no_provider_credit_spend',true,'global_kill_switch_must_remain_active',true,'dispatcher_window_requires_separate_gate',true,'external_channels_blocked',true,'timer_disabled_confirmed',true) OR $23!~'^a1-execution-arm:[A-Za-z0-9._:-]{8,103}$' OR $24!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION'A1_DISPATCH_EXECUTION_ARM_INVALID';END IF;
 SELECT*INTO parent FROM control.a1_assignment_execution_authorizations WHERE authorization_id=$6 FOR SHARE;
 SELECT payload INTO mission_payload FROM control.missions WHERE mission_id=$3 FOR SHARE;
 SELECT coalesce(array_agg(job_id ORDER BY created_at,job_id),ARRAY[]::uuid[]),coalesce(sum(usage_value_reservation_usd),0) INTO stored_ids,stored_total FROM control.dispatch_jobs WHERE mission_id=$3;
 SELECT*INTO ctl FROM control.a1_dispatch_execution_control WHERE control_id=1 FOR UPDATE;
 SELECT*INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR SHARE;
 IF parent.authorization_id IS NULL OR parent.mission_id<>$3 OR parent.trace_id<>$4 OR parent.plan_version<>$5 OR parent.decision<>'approved' OR parent.expires_at<=now_at OR $13>parent.expires_at OR parent.mission_sha256<>$14 OR parent.assignment_plan_sha256<>$15 OR parent.job_set_sha256<>$16 OR parent.assignment_ids<>$17 OR parent.maximum_provider_credit_spend_usd<>$20 OR mission_payload IS NULL OR mission_payload->>'mission_id'<>$3::text OR mission_payload->>'trace_id'<>$4::text OR mission_payload->>'autonomy_level'<>'A1' OR mission_payload->>'dry_run'<>'true' OR mission_payload->'contact_policy'->>'contact_permitted'<>'false' OR (mission_payload->'volume_limits'->>'maximum_external_actions')::integer<>0 OR (mission_payload->>'expires_at')::timestamptz<=$13 OR stored_ids<>$17 OR stored_total<>$20 OR EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE mission_id=$3 AND(status<>'queued' OR attempts<>0 OR lease_owner IS NOT NULL OR lease_until IS NOT NULL)) OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_arms WHERE mission_id=$3) OR ctl.control_id IS NULL OR ctl.claiming_enabled OR ctl.mission_id IS NOT NULL OR guard.control_id IS NULL OR guard.quarantined OR guard.probe_worker IS NOT NULL OR NOT control.is_global_kill_switch_active() OR NOT control.external_actions_blocked() THEN RAISE EXCEPTION'A1_DISPATCH_EXECUTION_ARM_GATE_CLOSED';END IF;
 INSERT INTO control.a1_dispatch_execution_arm_authorizations(authorization_id,mission_id,trace_id,plan_version,execution_authorization_id,decision,rationale,reviewer_id,reviewer_email,reviewed_at,starts_at,expires_at,mission_sha256,assignment_plan_sha256,job_set_sha256,assignment_ids,worker_id,maximum_claims,maximum_provider_credit_spend_usd,user_authorization_sha256,attestations,idempotency_key,request_sha256)VALUES($2,$3,$4,$5,$6,$7,btrim($8),$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24);
 INSERT INTO control.a1_dispatch_execution_arms(arm_id,mission_id,execution_authorization_id,worker_id,starts_at,expires_at,maximum_claims,maximum_provider_credit_spend_usd,arm_authorization_id)VALUES($1,$3,$6,$18,$12,$13,$19,$20,$2);
 INSERT INTO control.audit_events(event)VALUES(jsonb_build_object('event','a1_dispatch_execution_arm_recorded','arm_id',$1,'authorization_id',$2,'mission_id',$3,'trace_id',$4,'execution_authorization_id',$6,'reviewer_id',$9,'reviewed_at',$11,'starts_at',$12,'expires_at',$13,'job_set_sha256',$16,'assignment_ids',$17,'worker_id',$18,'maximum_claims',$19,'maximum_provider_credit_spend_usd',$20,'user_authorization_sha256',$21,'request_sha256',$24,'execution_arm_created',true,'execution_window_enabled',false,'jobs_claimed',false,'execution_started',false,'provider_credit_spend_allowed',false,'external_action',false,'production_gate','blocked','recorded_at',now_at));
 RETURN control.get_a1_dispatch_execution_arm($3);
END$$;

CREATE OR REPLACE FUNCTION control.claim_dispatch(text,integer,integer) RETURNS SETOF control.dispatch_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE selected uuid;now_at timestamptz:=clock_timestamp();guard control.usage_budget_control%ROWTYPE;job control.dispatch_jobs%ROWTYPE;mission_committed bigint;total_committed bigint;mission_limit bigint;requested_reservation bigint;arm control.a1_dispatch_execution_arms%ROWTYPE;
BEGIN
 IF $1 IS NULL OR btrim($1)='' OR $2 NOT BETWEEN 2 AND 3600 OR $3<1 OR $3>=$2 THEN RAISE EXCEPTION'INVALID_DISPATCH_LEASE';END IF;PERFORM control.recover_dispatch_leases();SELECT*INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;IF guard.quarantined OR guard.probe_worker IS NOT NULL THEN RETURN;END IF;
 SELECT j.job_id INTO selected FROM control.dispatch_jobs j JOIN control.missions m ON m.mission_id=j.mission_id JOIN control.a1_assignment_execution_authorizations auth ON auth.mission_id=j.mission_id JOIN control.a1_dispatch_execution_arms candidate ON candidate.mission_id=j.mission_id AND candidate.execution_authorization_id=auth.authorization_id JOIN control.a1_dispatch_execution_control ctl ON ctl.control_id=1 AND ctl.claiming_enabled AND ctl.mission_id=j.mission_id AND ctl.arm_id=candidate.arm_id AND ctl.worker_id=$1 AND ctl.opened_at<=now_at AND ctl.expires_at>now_at WHERE j.status='queued' AND j.next_attempt_at<=now_at AND j.attempts<j.max_attempts AND auth.decision='approved' AND auth.expires_at>now_at AND j.job_id=ANY(auth.assignment_ids) AND candidate.worker_id=$1 AND candidate.starts_at<=now_at AND candidate.expires_at>now_at AND candidate.claims_used<candidate.maximum_claims AND candidate.maximum_provider_credit_spend_usd<=auth.maximum_provider_credit_spend_usd AND (m.payload->>'expires_at')::timestamptz>now_at AND m.payload->>'autonomy_level'='A1' AND m.payload->>'dry_run'='true' AND NOT control.is_global_kill_switch_active() AND control.external_actions_blocked() AND NOT control.is_kill_switch_active(j.mission_id::text,'internal') AND NOT EXISTS(SELECT 1 FROM control.dispatch_dependencies d JOIN control.dispatch_jobs p ON p.job_id=d.depends_on_job_id WHERE d.job_id=j.job_id AND p.status<>'succeeded') ORDER BY j.created_at,j.job_id FOR UPDATE OF j SKIP LOCKED LIMIT 1;
 IF selected IS NULL THEN RETURN;END IF;SELECT*INTO job FROM control.dispatch_jobs WHERE job_id=selected FOR UPDATE;SELECT*INTO arm FROM control.a1_dispatch_execution_arms WHERE mission_id=job.mission_id FOR UPDATE;IF arm.arm_id IS NULL OR arm.claims_used>=arm.maximum_claims OR arm.expires_at<=now_at THEN RETURN;END IF;
 requested_reservation:=round(job.usage_value_reservation_usd*100000000)::bigint;SELECT coalesce(sum(CASE usage_budget_state WHEN'settled'THEN usage_value_actual_micro_cents WHEN'reserved'THEN usage_value_reservation_micro_cents WHEN'held_uncertain'THEN usage_value_reservation_micro_cents ELSE 0 END),0)::bigint INTO mission_committed FROM control.dispatch_jobs WHERE mission_id=job.mission_id;SELECT coalesce(sum(CASE usage_budget_state WHEN'settled'THEN usage_value_actual_micro_cents WHEN'reserved'THEN usage_value_reservation_micro_cents WHEN'held_uncertain'THEN usage_value_reservation_micro_cents ELSE 0 END),0)::bigint INTO total_committed FROM control.dispatch_jobs;mission_limit:=least(guard.mission_ceiling_micro_cents,floor(job.mission_usage_value_ceiling_usd*100000000)::bigint);
 IF requested_reservation<1 OR requested_reservation>guard.run_ceiling_micro_cents OR mission_committed+requested_reservation>mission_limit OR total_committed+requested_reservation>guard.activation_ceiling_micro_cents OR (mission_committed+requested_reservation)::numeric/100000000>arm.maximum_provider_credit_spend_usd THEN UPDATE control.dispatch_jobs SET status='budget_exceeded',updated_at=now_at,error='USAGE_BUDGET_RESERVATION_EXCEEDED' WHERE job_id=selected;INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)VALUES(selected,'queued','budget_exceeded','USAGE_BUDGET_RESERVATION_EXCEEDED',now_at);RETURN;END IF;
 UPDATE control.a1_dispatch_execution_arms SET claims_used=claims_used+1 WHERE arm_id=arm.arm_id;UPDATE control.dispatch_jobs SET status='leased',lease_owner=$1,lease_until=now_at+make_interval(secs=>$2),child_timeout_seconds=$3,attempts=attempts+1,usage_value_consumed_usd=requested_reservation::numeric/100000000,usage_budget_state='reserved',usage_value_reservation_micro_cents=requested_reservation,usage_value_actual_micro_cents=NULL,usage_record_id=NULL,usage_value_source=NULL,mission_committed_before_micro_cents=mission_committed,total_committed_before_micro_cents=total_committed,usage_budget_version=usage_budget_version+1,updated_at=now_at WHERE job_id=selected;UPDATE control.usage_budget_control SET probe_job_id=selected,probe_worker=$1,probe_lease_until=now_at+make_interval(secs=>$2),updated_at=now_at WHERE control_id=1;INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)VALUES(selected,'queued','leased','A1_EXACT_EXECUTION_WINDOW_CLAIMED',now_at);RETURN QUERY SELECT*FROM control.dispatch_jobs WHERE job_id=selected;
END$$;

REVOKE ALL ON control.a1_dispatch_execution_arm_authorizations,control.a1_dispatch_execution_control FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION control.get_a1_dispatch_execution_arm(uuid),control.record_a1_dispatch_execution_arm(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,text,text,text,uuid[],text,integer,numeric,text,jsonb,text,text) FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.get_a1_dispatch_execution_arm(uuid),control.record_a1_dispatch_execution_arm(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,text,text,text,uuid[],text,integer,numeric,text,jsonb,text,text) TO commercial_runtime;

COMMIT;
