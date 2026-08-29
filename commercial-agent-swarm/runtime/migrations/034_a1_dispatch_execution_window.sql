BEGIN;

CREATE TABLE control.a1_dispatch_execution_window_authorizations(
  window_authorization_id uuid PRIMARY KEY,
  mission_id uuid NOT NULL UNIQUE REFERENCES control.missions(mission_id) ON DELETE RESTRICT,
  arm_id uuid NOT NULL UNIQUE REFERENCES control.a1_dispatch_execution_arms(arm_id) ON DELETE RESTRICT,
  arm_authorization_id uuid NOT NULL UNIQUE REFERENCES control.a1_dispatch_execution_arm_authorizations(authorization_id) ON DELETE RESTRICT,
  execution_authorization_id uuid NOT NULL REFERENCES control.a1_assignment_execution_authorizations(authorization_id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK(decision='approved'),
  rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 20 AND 1000),
  reviewer_id text NOT NULL CHECK(reviewer_id~'^[A-Za-z0-9._:@+-]{3,254}$'),
  reviewer_email text NOT NULL CHECK(reviewer_email='proptimizaspa@gmail.com'),
  reviewed_at timestamptz NOT NULL,
  opens_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  mission_sha256 text NOT NULL CHECK(mission_sha256~'^[0-9a-f]{64}$'),
  assignment_plan_sha256 text NOT NULL CHECK(assignment_plan_sha256~'^[0-9a-f]{64}$'),
  job_set_sha256 text NOT NULL CHECK(job_set_sha256~'^[0-9a-f]{64}$'),
  worker_id text NOT NULL CHECK(worker_id='broker-dispatcher-1'),
  maximum_claims integer NOT NULL CHECK(maximum_claims BETWEEN 1 AND 6),
  maximum_provider_credit_spend_usd numeric(12,6) NOT NULL CHECK(maximum_provider_credit_spend_usd BETWEEN 0.01 AND 0.5),
  user_authorization_sha256 text NOT NULL UNIQUE CHECK(user_authorization_sha256~'^[0-9a-f]{64}$'),
  attestations jsonb NOT NULL CHECK(attestations=jsonb_build_object('exact_arm_confirmed',true,'exact_mission_confirmed',true,'single_mission_window_confirmed',true,'provider_credit_spend_authorized',true,'automatic_recontainment_required',true,'global_kill_switch_may_open_only_for_window',true,'external_channels_blocked',true,'maximum_external_actions_zero',true,'no_contact',true,'no_crm_write',true,'a3_blocked',true,'mail_blocked',true,'telegram_blocked',true,'timer_disabled_confirmed',true)),
  idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key~'^a1-execution-window:[A-Za-z0-9._:-]{8,100}$'),
  request_sha256 text NOT NULL CHECK(request_sha256~'^[0-9a-f]{64}$'),
  closed_at timestamptz NULL,
  close_reason text NULL CHECK(close_reason IS NULL OR close_reason~'^[A-Z0-9_:-]{3,128}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(opens_at>=reviewed_at AND opens_at<=reviewed_at+interval '5 minutes'),
  CHECK(expires_at>opens_at AND expires_at<=opens_at+interval '10 minutes' AND expires_at<=reviewed_at+interval '10 minutes'),
  CHECK((closed_at IS NULL AND close_reason IS NULL) OR (closed_at IS NOT NULL AND close_reason IS NOT NULL))
);

CREATE OR REPLACE FUNCTION control.get_a1_dispatch_execution_window(uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'windowAuthorizationId',w.window_authorization_id,'missionId',w.mission_id,'decision',w.decision,'rationale',w.rationale,'reviewerId',w.reviewer_id,'reviewerEmail',w.reviewer_email,
  'reviewedAt',to_char(w.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'opensAt',to_char(w.opens_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(w.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expectedArmId',w.arm_id,'expectedArmAuthorizationId',w.arm_authorization_id,'expectedExecutionAuthorizationId',w.execution_authorization_id,'expectedMissionSha256',w.mission_sha256,'expectedAssignmentPlanSha256',w.assignment_plan_sha256,'expectedJobSetSha256',w.job_set_sha256,'workerId',w.worker_id,'maximumClaims',w.maximum_claims,'maximumProviderCreditSpendUsd',w.maximum_provider_credit_spend_usd::double precision,'userAuthorizationSha256',w.user_authorization_sha256,
  'attestations',jsonb_build_object('exactArmConfirmed',true,'exactMissionConfirmed',true,'singleMissionWindowConfirmed',true,'providerCreditSpendAuthorized',true,'automaticRecontainmentRequired',true,'globalKillSwitchMayOpenOnlyForWindow',true,'externalChannelsBlocked',true,'maximumExternalActionsZero',true,'noContact',true,'noCrmWrite',true,'a3Blocked',true,'mailBlocked',true,'telegramBlocked',true,'timerDisabledConfirmed',true),'idempotencyKey',w.idempotency_key,
  'executionWindowAuthorizationRecorded',true,'executionWindowEnabled',true,'dispatchClaimingPermitted',true,'claimsUsed',arm.claims_used,'jobsClaimed',arm.claims_used>0,'executionStarted',arm.claims_used>0,'providerCreditSpendAllowed',true,'contactPermitted',false,'crmWriteAllowed',false,'maximumExternalActions',0,'globalKillSwitchActive',false,'externalChannelsBlocked',true,'automaticRecontainmentArmed',true,'productionGate','single_mission_internal_execution','nextRequiredGate','automatic_recontainment_after_terminal_or_expiry',
  'provenance',jsonb_build_object('source','control-broker','sourceId','a1-dispatch-execution-window:'||w.window_authorization_id::text,'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'synthetic',false)
 )
 FROM control.a1_dispatch_execution_window_authorizations w
 JOIN control.a1_dispatch_execution_arms arm ON arm.arm_id=w.arm_id
 JOIN control.a1_dispatch_execution_control ctl ON ctl.control_id=1 AND ctl.claiming_enabled AND ctl.mission_id=w.mission_id AND ctl.arm_id=w.arm_id AND ctl.worker_id=w.worker_id AND ctl.opened_at=w.opens_at AND ctl.expires_at=w.expires_at
 WHERE w.mission_id=$1 AND w.closed_at IS NULL AND w.opens_at<=clock_timestamp() AND w.expires_at>clock_timestamp() AND NOT control.is_global_kill_switch_active() AND control.external_actions_blocked()
$$;

CREATE OR REPLACE FUNCTION control.recontain_a1_dispatch_execution_window(uuid,text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w control.a1_dispatch_execution_window_authorizations%ROWTYPE;now_at timestamptz:=clock_timestamp();
BEGIN
 IF $2!~'^[A-Z0-9_:-]{3,128}$' THEN RAISE EXCEPTION'A1_DISPATCH_EXECUTION_WINDOW_INVALID';END IF;
 PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
 SELECT*INTO w FROM control.a1_dispatch_execution_window_authorizations WHERE mission_id=$1 AND closed_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM control.set_kill_switch('global','*',true);
 UPDATE control.a1_dispatch_execution_control SET claiming_enabled=false,mission_id=NULL,arm_id=NULL,worker_id=NULL,opened_at=NULL,expires_at=NULL,updated_at=now_at WHERE control_id=1 AND mission_id=$1;
 UPDATE control.a1_dispatch_execution_window_authorizations SET closed_at=now_at,close_reason=$2 WHERE window_authorization_id=w.window_authorization_id;
 INSERT INTO control.audit_events(event)VALUES(jsonb_build_object('event','a1_dispatch_execution_window_recontained','window_authorization_id',w.window_authorization_id,'mission_id',$1,'reason',$2,'global_kill_switch_active',true,'external_action',false,'recorded_at',now_at));
 RETURN true;
END$$;

CREATE OR REPLACE FUNCTION control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing control.a1_dispatch_execution_window_authorizations%ROWTYPE;arm control.a1_dispatch_execution_arms%ROWTYPE;arm_auth control.a1_dispatch_execution_arm_authorizations%ROWTYPE;ctl control.a1_dispatch_execution_control%ROWTYPE;guard control.usage_budget_control%ROWTYPE;mission_payload jsonb;now_at timestamptz:=clock_timestamp();
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext($21));PERFORM pg_advisory_xact_lock(hashtext($2::text));
 SELECT*INTO existing FROM control.a1_dispatch_execution_window_authorizations WHERE window_authorization_id=$1 OR mission_id=$2 OR arm_id=$10 OR arm_authorization_id=$11 OR user_authorization_sha256=$19 OR idempotency_key=$21;
 IF FOUND THEN
  IF existing.window_authorization_id<>$1 OR existing.mission_id<>$2 OR existing.decision<>$3 OR existing.rationale<>btrim($4) OR existing.reviewer_id<>$5 OR existing.reviewer_email<>$6 OR existing.reviewed_at<>$7 OR existing.opens_at<>$8 OR existing.expires_at<>$9 OR existing.arm_id<>$10 OR existing.arm_authorization_id<>$11 OR existing.execution_authorization_id<>$12 OR existing.mission_sha256<>$13 OR existing.assignment_plan_sha256<>$14 OR existing.job_set_sha256<>$15 OR existing.worker_id<>$16 OR existing.maximum_claims<>$17 OR existing.maximum_provider_credit_spend_usd<>$18 OR existing.user_authorization_sha256<>$19 OR existing.attestations<>$20 OR existing.idempotency_key<>$21 OR existing.request_sha256<>$22 OR existing.closed_at IS NOT NULL THEN RAISE EXCEPTION'A1_DISPATCH_EXECUTION_WINDOW_IMMUTABLE_CONFLICT';END IF;
  RETURN control.get_a1_dispatch_execution_window($2);
 END IF;
 IF $3<>'approved' OR length(btrim($4)) NOT BETWEEN 20 AND 1000 OR $4~'[[:cntrl:]]' OR $4~*'(https?://|www[.]|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer[[:space:]]+[A-Za-z0-9._~-]{20,})' OR $5!~'^[A-Za-z0-9._:@+-]{3,254}$' OR $6<>'proptimizaspa@gmail.com' OR abs(extract(epoch FROM now_at-$7))>300 OR $8<$7 OR $8>$7+interval '5 minutes' OR $9<=$8 OR $9>$8+interval '10 minutes' OR $9>$7+interval '10 minutes' OR $9<=now_at OR $13!~'^[0-9a-f]{64}$' OR $14!~'^[0-9a-f]{64}$' OR $15!~'^[0-9a-f]{64}$' OR $16<>'broker-dispatcher-1' OR $17 NOT BETWEEN 1 AND 6 OR $18 NOT BETWEEN 0.01 AND 0.5 OR $19!~'^[0-9a-f]{64}$' OR $20<>jsonb_build_object('exact_arm_confirmed',true,'exact_mission_confirmed',true,'single_mission_window_confirmed',true,'provider_credit_spend_authorized',true,'automatic_recontainment_required',true,'global_kill_switch_may_open_only_for_window',true,'external_channels_blocked',true,'maximum_external_actions_zero',true,'no_contact',true,'no_crm_write',true,'a3_blocked',true,'mail_blocked',true,'telegram_blocked',true,'timer_disabled_confirmed',true) OR $21!~'^a1-execution-window:[A-Za-z0-9._:-]{8,100}$' OR $22!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION'A1_DISPATCH_EXECUTION_WINDOW_INVALID';END IF;
 SELECT*INTO arm FROM control.a1_dispatch_execution_arms WHERE arm_id=$10 AND mission_id=$2 FOR UPDATE;
 SELECT*INTO arm_auth FROM control.a1_dispatch_execution_arm_authorizations WHERE authorization_id=$11 AND mission_id=$2 FOR SHARE;
 SELECT payload INTO mission_payload FROM control.missions WHERE mission_id=$2 FOR SHARE;
 SELECT*INTO ctl FROM control.a1_dispatch_execution_control WHERE control_id=1 FOR UPDATE;
 SELECT*INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR SHARE;
 IF arm.arm_id IS NULL OR arm.arm_authorization_id<>$11 OR arm.execution_authorization_id<>$12 OR arm.worker_id<>$16 OR arm.maximum_claims<>$17 OR arm.maximum_provider_credit_spend_usd<>$18 OR arm.claims_used<>0 OR arm.starts_at>$8 OR arm.expires_at<$9 OR arm_auth.authorization_id IS NULL OR arm_auth.execution_authorization_id<>$12 OR arm_auth.mission_sha256<>$13 OR arm_auth.assignment_plan_sha256<>$14 OR arm_auth.job_set_sha256<>$15 OR arm_auth.expires_at<$9 OR mission_payload IS NULL OR mission_payload->>'autonomy_level'<>'A1' OR mission_payload->>'dry_run'<>'true' OR mission_payload->'contact_policy'->>'contact_permitted'<>'false' OR (mission_payload->'volume_limits'->>'maximum_external_actions')::integer<>0 OR (mission_payload->>'expires_at')::timestamptz<$9 OR ctl.control_id IS NULL OR ctl.claiming_enabled OR ctl.mission_id IS NOT NULL OR guard.control_id IS NULL OR guard.quarantined OR guard.probe_worker IS NOT NULL OR NOT control.is_global_kill_switch_active() OR NOT control.external_actions_blocked() OR EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE mission_id=$2 AND(status<>'queued' OR attempts<>0 OR lease_owner IS NOT NULL OR lease_until IS NOT NULL)) OR (SELECT count(*) FROM control.dispatch_jobs WHERE mission_id=$2)<>$17 THEN RAISE EXCEPTION'A1_DISPATCH_EXECUTION_WINDOW_GATE_CLOSED';END IF;
 INSERT INTO control.a1_dispatch_execution_window_authorizations(window_authorization_id,mission_id,arm_id,arm_authorization_id,execution_authorization_id,decision,rationale,reviewer_id,reviewer_email,reviewed_at,opens_at,expires_at,mission_sha256,assignment_plan_sha256,job_set_sha256,worker_id,maximum_claims,maximum_provider_credit_spend_usd,user_authorization_sha256,attestations,idempotency_key,request_sha256)VALUES($1,$2,$10,$11,$12,$3,btrim($4),$5,$6,$7,$8,$9,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22);
 UPDATE control.a1_dispatch_execution_control SET claiming_enabled=true,mission_id=$2,arm_id=$10,worker_id=$16,opened_at=$8,expires_at=$9,updated_at=now_at WHERE control_id=1;
 PERFORM control.set_kill_switch('global','*',false);
 INSERT INTO control.audit_events(event)VALUES(jsonb_build_object('event','a1_dispatch_execution_window_activated','window_authorization_id',$1,'mission_id',$2,'arm_id',$10,'reviewer_id',$5,'reviewed_at',$7,'opens_at',$8,'expires_at',$9,'maximum_claims',$17,'maximum_provider_credit_spend_usd',$18,'user_authorization_sha256',$19,'request_sha256',$22,'provider_credit_spend_allowed',true,'maximum_external_actions',0,'external_channels_blocked',true,'automatic_recontainment_armed',true,'external_action',false,'recorded_at',now_at));
 RETURN control.get_a1_dispatch_execution_window($2);
END$$;

CREATE OR REPLACE FUNCTION control.claim_dispatch(text,integer,integer) RETURNS SETOF control.dispatch_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE selected uuid;now_at timestamptz:=clock_timestamp();guard control.usage_budget_control%ROWTYPE;job control.dispatch_jobs%ROWTYPE;mission_committed bigint;total_committed bigint;mission_limit bigint;requested_reservation bigint;arm control.a1_dispatch_execution_arms%ROWTYPE;ctl control.a1_dispatch_execution_control%ROWTYPE;
BEGIN
 IF $1 IS NULL OR btrim($1)='' OR $2 NOT BETWEEN 2 AND 3600 OR $3<1 OR $3>=$2 THEN RAISE EXCEPTION'INVALID_DISPATCH_LEASE';END IF;
 SELECT*INTO ctl FROM control.a1_dispatch_execution_control WHERE control_id=1;
 IF ctl.claiming_enabled AND (ctl.expires_at<=now_at OR EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE mission_id=ctl.mission_id AND status='usage_unknown')) THEN PERFORM control.recontain_a1_dispatch_execution_window(ctl.mission_id,CASE WHEN ctl.expires_at<=now_at THEN'WINDOW_EXPIRED'ELSE'USAGE_UNKNOWN'END);RETURN;END IF;
 PERFORM control.recover_dispatch_leases();SELECT*INTO ctl FROM control.a1_dispatch_execution_control WHERE control_id=1;IF ctl.claiming_enabled AND EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE mission_id=ctl.mission_id AND status='usage_unknown') THEN PERFORM control.recontain_a1_dispatch_execution_window(ctl.mission_id,'LEASE_EXPIRED_USAGE_UNKNOWN');RETURN;END IF;
 SELECT*INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;IF guard.quarantined OR guard.probe_worker IS NOT NULL THEN RETURN;END IF;
 SELECT j.job_id INTO selected FROM control.dispatch_jobs j JOIN control.missions m ON m.mission_id=j.mission_id JOIN control.a1_assignment_execution_authorizations auth ON auth.mission_id=j.mission_id JOIN control.a1_dispatch_execution_arms candidate ON candidate.mission_id=j.mission_id AND candidate.execution_authorization_id=auth.authorization_id JOIN control.a1_dispatch_execution_control c ON c.control_id=1 AND c.claiming_enabled AND c.mission_id=j.mission_id AND c.arm_id=candidate.arm_id AND c.worker_id=$1 AND c.opened_at<=now_at AND c.expires_at>now_at JOIN control.a1_dispatch_execution_window_authorizations w ON w.mission_id=j.mission_id AND w.arm_id=candidate.arm_id AND w.closed_at IS NULL AND w.opens_at=c.opened_at AND w.expires_at=c.expires_at WHERE j.status='queued' AND j.next_attempt_at<=now_at AND j.attempts<j.max_attempts AND auth.decision='approved' AND auth.expires_at>now_at AND j.job_id=ANY(auth.assignment_ids) AND candidate.worker_id=$1 AND candidate.starts_at<=now_at AND candidate.expires_at>now_at AND candidate.claims_used<candidate.maximum_claims AND candidate.maximum_provider_credit_spend_usd<=auth.maximum_provider_credit_spend_usd AND (m.payload->>'expires_at')::timestamptz>now_at AND m.payload->>'autonomy_level'='A1' AND m.payload->>'dry_run'='true' AND NOT control.is_global_kill_switch_active() AND control.external_actions_blocked() AND NOT control.is_kill_switch_active(j.mission_id::text,'internal') AND NOT EXISTS(SELECT 1 FROM control.dispatch_dependencies d JOIN control.dispatch_jobs p ON p.job_id=d.depends_on_job_id WHERE d.job_id=j.job_id AND p.status<>'succeeded') ORDER BY j.created_at,j.job_id FOR UPDATE OF j SKIP LOCKED LIMIT 1;
 IF selected IS NULL THEN RETURN;END IF;SELECT*INTO job FROM control.dispatch_jobs WHERE job_id=selected FOR UPDATE;SELECT*INTO arm FROM control.a1_dispatch_execution_arms WHERE mission_id=job.mission_id FOR UPDATE;
 requested_reservation:=round(job.usage_value_reservation_usd*100000000)::bigint;SELECT coalesce(sum(CASE usage_budget_state WHEN'settled'THEN usage_value_actual_micro_cents WHEN'reserved'THEN usage_value_reservation_micro_cents WHEN'held_uncertain'THEN usage_value_reservation_micro_cents ELSE 0 END),0)::bigint INTO mission_committed FROM control.dispatch_jobs WHERE mission_id=job.mission_id;SELECT coalesce(sum(CASE usage_budget_state WHEN'settled'THEN usage_value_actual_micro_cents WHEN'reserved'THEN usage_value_reservation_micro_cents WHEN'held_uncertain'THEN usage_value_reservation_micro_cents ELSE 0 END),0)::bigint INTO total_committed FROM control.dispatch_jobs;mission_limit:=least(guard.mission_ceiling_micro_cents,floor(job.mission_usage_value_ceiling_usd*100000000)::bigint);
 IF requested_reservation<1 OR requested_reservation>guard.run_ceiling_micro_cents OR mission_committed+requested_reservation>mission_limit OR total_committed+requested_reservation>guard.activation_ceiling_micro_cents OR (mission_committed+requested_reservation)::numeric/100000000>arm.maximum_provider_credit_spend_usd THEN UPDATE control.dispatch_jobs SET status='budget_exceeded',updated_at=now_at,error='USAGE_BUDGET_RESERVATION_EXCEEDED' WHERE job_id=selected;INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)VALUES(selected,'queued','budget_exceeded','USAGE_BUDGET_RESERVATION_EXCEEDED',now_at);PERFORM control.recontain_a1_dispatch_execution_window(job.mission_id,'BUDGET_EXCEEDED');RETURN;END IF;
 UPDATE control.a1_dispatch_execution_arms SET claims_used=claims_used+1 WHERE arm_id=arm.arm_id;UPDATE control.dispatch_jobs SET status='leased',lease_owner=$1,lease_until=now_at+make_interval(secs=>$2),child_timeout_seconds=$3,attempts=attempts+1,usage_value_consumed_usd=requested_reservation::numeric/100000000,usage_budget_state='reserved',usage_value_reservation_micro_cents=requested_reservation,usage_value_actual_micro_cents=NULL,usage_record_id=NULL,usage_value_source=NULL,mission_committed_before_micro_cents=mission_committed,total_committed_before_micro_cents=total_committed,usage_budget_version=usage_budget_version+1,updated_at=now_at WHERE job_id=selected;UPDATE control.usage_budget_control SET probe_job_id=selected,probe_worker=$1,probe_lease_until=now_at+make_interval(secs=>$2),updated_at=now_at WHERE control_id=1;INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)VALUES(selected,'queued','leased','A1_EXACT_EXECUTION_WINDOW_CLAIMED',now_at);RETURN QUERY SELECT*FROM control.dispatch_jobs WHERE job_id=selected;
END$$;

CREATE OR REPLACE FUNCTION control.recontain_a1_after_dispatch_transition() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE remaining integer;
BEGIN
 IF OLD.status='leased' AND NEW.status IN('queued','failed','usage_unknown','budget_exceeded') THEN
  PERFORM control.recontain_a1_dispatch_execution_window(NEW.mission_id,CASE WHEN NEW.status='usage_unknown'THEN'USAGE_UNKNOWN' WHEN NEW.status='budget_exceeded'THEN'BUDGET_EXCEEDED' ELSE'DISPATCH_FAILED'END);
 ELSIF OLD.status='leased' AND NEW.status='succeeded' THEN
  SELECT count(*) INTO remaining FROM control.dispatch_jobs WHERE mission_id=NEW.mission_id AND job_id<>NEW.job_id AND status IN('queued','leased');
  IF remaining=0 THEN PERFORM control.recontain_a1_dispatch_execution_window(NEW.mission_id,'MISSION_TERMINAL');END IF;
 ELSIF OLD.status='queued' AND NEW.status='budget_exceeded' THEN
  PERFORM control.recontain_a1_dispatch_execution_window(NEW.mission_id,'BUDGET_EXCEEDED');
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER a1_dispatch_execution_recontain AFTER UPDATE OF status ON control.dispatch_jobs FOR EACH ROW WHEN(OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION control.recontain_a1_after_dispatch_transition();

REVOKE ALL ON control.a1_dispatch_execution_window_authorizations FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION control.get_a1_dispatch_execution_window(uuid),control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text),control.recontain_a1_dispatch_execution_window(uuid,text),control.recontain_a1_after_dispatch_transition() FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.get_a1_dispatch_execution_window(uuid) TO commercial_runtime;
GRANT EXECUTE ON FUNCTION control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text) TO commercial_safety_operator;

COMMIT;
