BEGIN;

CREATE TABLE control.a1_assignment_enqueue_authorizations (
  authorization_id uuid PRIMARY KEY,
  mission_id uuid NOT NULL UNIQUE REFERENCES control.missions(mission_id) ON DELETE RESTRICT,
  trace_id uuid NOT NULL,
  plan_version text NOT NULL CHECK(plan_version~'^[a-z0-9][a-z0-9._-]{0,63}$'),
  dispatch_authorization_id uuid NOT NULL UNIQUE REFERENCES control.a1_dispatch_authorizations(authorization_id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK(decision IN('approved','rejected')),
  rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 20 AND 1000),
  reviewer_id text NOT NULL CHECK(reviewer_id~'^[A-Za-z0-9._:@+-]{3,254}$'),
  reviewer_email text NOT NULL CHECK(reviewer_email='proptimizaspa@gmail.com'),
  reviewed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  mission_sha256 text NOT NULL CHECK(mission_sha256~'^[0-9a-f]{64}$'),
  assignment_plan_sha256 text NOT NULL UNIQUE CHECK(assignment_plan_sha256~'^[0-9a-f]{64}$'),
  user_authorization_sha256 text NOT NULL UNIQUE CHECK(user_authorization_sha256~'^[0-9a-f]{64}$'),
  attestations jsonb NOT NULL CHECK(attestations=jsonb_build_object(
    'exact_enqueue_confirmed',true,'authorization_record_only',true,
    'no_assignments_enqueued_by_authorization',true,'no_execution',true,
    'no_contact',true,'no_crm_write',true,'no_external_actions',true,
    'no_provider_credit_spend',true,'global_kill_switch_required',true
  )),
  idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key~'^a1-enqueue-auth:[A-Za-z0-9._:-]{8,105}$'),
  request_sha256 text NOT NULL CHECK(request_sha256~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(expires_at>reviewed_at AND expires_at<=reviewed_at+interval '30 minutes')
);

CREATE OR REPLACE FUNCTION control.get_a1_assignment_enqueue_authorization(uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'authorizationId',row.authorization_id,'missionId',row.mission_id,'traceId',row.trace_id,
    'planVersion',row.plan_version,'dispatchAuthorizationId',row.dispatch_authorization_id,
    'decision',row.decision,'rationale',row.rationale,'reviewerId',row.reviewer_id,
    'reviewerEmail',row.reviewer_email,
    'reviewedAt',to_char(row.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(row.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'missionSha256',row.mission_sha256,'assignmentPlanSha256',row.assignment_plan_sha256,
    'userAuthorizationSha256',row.user_authorization_sha256,
    'attestations',jsonb_build_object(
      'exactEnqueueConfirmed',true,'authorizationRecordOnly',true,
      'noAssignmentsEnqueuedByAuthorization',true,'noExecution',true,'noContact',true,
      'noCrmWrite',true,'noExternalActions',true,'noProviderCreditSpend',true,
      'globalKillSwitchRequired',true
    ),
    'idempotencyKey',row.idempotency_key,'enqueueAuthorizationRecorded',true,
    'assignmentEnqueuePermitted',row.decision='approved','assignmentsEnqueued',false,
    'executionAuthorized',false,'dispatchClaimingPermitted',false,
    'internetAccessAllowed',false,'providerCreditSpendAllowed',false,
    'contactPermitted',false,'crmWriteAllowed',false,'maximumExternalActions',0,
    'globalKillSwitchRequired',true,'productionGate','blocked',
    'nextRequiredGate','enqueue_exact_assignment_plan_separately',
    'provenance',jsonb_build_object('source','control-broker',
      'sourceId','a1-assignment-enqueue-authorization:'||row.authorization_id::text,
      'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'synthetic',false)
  ) FROM control.a1_assignment_enqueue_authorizations row WHERE row.mission_id=$1
$$;

CREATE OR REPLACE FUNCTION control.record_a1_assignment_enqueue_authorization(
  uuid,uuid,uuid,text,uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,jsonb,text,text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing control.a1_assignment_enqueue_authorizations%ROWTYPE; parent control.a1_dispatch_authorizations%ROWTYPE; mission_payload jsonb; now_at timestamptz:=clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext($16));
  SELECT * INTO existing FROM control.a1_assignment_enqueue_authorizations
  WHERE authorization_id=$1 OR mission_id=$2 OR dispatch_authorization_id=$5 OR
        assignment_plan_sha256=$13 OR user_authorization_sha256=$14 OR idempotency_key=$16;
  IF FOUND THEN
    IF existing.authorization_id<>$1 OR existing.mission_id<>$2 OR existing.trace_id<>$3 OR
       existing.plan_version<>$4 OR existing.dispatch_authorization_id<>$5 OR
       existing.decision<>$6 OR existing.rationale<>btrim($7) OR existing.reviewer_id<>$8 OR
       existing.reviewer_email<>$9 OR existing.reviewed_at<>$10 OR existing.expires_at<>$11 OR
       existing.mission_sha256<>$12 OR existing.assignment_plan_sha256<>$13 OR
       existing.user_authorization_sha256<>$14 OR existing.attestations<>$15 OR
       existing.idempotency_key<>$16 OR existing.request_sha256<>$17
    THEN RAISE EXCEPTION 'A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_IMMUTABLE_CONFLICT'; END IF;
    RETURN control.get_a1_assignment_enqueue_authorization(existing.mission_id);
  END IF;
  IF $4!~'^[a-z0-9][a-z0-9._-]{0,63}$' OR $6 NOT IN('approved','rejected') OR
     length(btrim($7)) NOT BETWEEN 20 AND 1000 OR $7~'[[:cntrl:]]' OR
     $7~*'(https?://|www[.]|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer[[:space:]]+[A-Za-z0-9._~-]{20,})' OR
     $8!~'^[A-Za-z0-9._:@+-]{3,254}$' OR $9<>'proptimizaspa@gmail.com' OR
     abs(extract(epoch FROM now_at-$10))>300 OR $11<=$10 OR $11>$10+interval '30 minutes' OR
     $12!~'^[0-9a-f]{64}$' OR $13!~'^[0-9a-f]{64}$' OR $14!~'^[0-9a-f]{64}$' OR
     $15<>jsonb_build_object('exact_enqueue_confirmed',true,'authorization_record_only',true,
       'no_assignments_enqueued_by_authorization',true,'no_execution',true,'no_contact',true,
       'no_crm_write',true,'no_external_actions',true,'no_provider_credit_spend',true,
       'global_kill_switch_required',true) OR
     $16!~'^a1-enqueue-auth:[A-Za-z0-9._:-]{8,105}$' OR $17!~'^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_INVALID'; END IF;
  SELECT * INTO parent FROM control.a1_dispatch_authorizations WHERE authorization_id=$5 FOR SHARE;
  SELECT payload INTO mission_payload FROM control.missions WHERE mission_id=$2 FOR SHARE;
  IF parent.authorization_id IS NULL OR parent.mission_id<>$2 OR parent.trace_id<>$3 OR
     parent.plan_version<>$4 OR parent.decision<>'approved' OR parent.expires_at<=now_at OR
     $11>parent.expires_at OR parent.mission_sha256<>$12 OR parent.assignment_plan_sha256<>$13 OR
     mission_payload IS NULL OR mission_payload->>'mission_id'<>$2::text OR
     mission_payload->>'trace_id'<>$3::text OR mission_payload->>'autonomy_level'<>'A1' OR
     mission_payload->>'dry_run'<>'true' OR mission_payload->'contact_policy'->>'contact_permitted'<>'false' OR
     (mission_payload->'volume_limits'->>'maximum_external_actions')::integer<>0 OR
     EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE mission_id=$2) OR
     NOT control.is_global_kill_switch_active() OR NOT control.external_actions_blocked()
  THEN RAISE EXCEPTION 'A1_ASSIGNMENT_ENQUEUE_AUTHORIZATION_GATE_CLOSED'; END IF;
  INSERT INTO control.a1_assignment_enqueue_authorizations(
    authorization_id,mission_id,trace_id,plan_version,dispatch_authorization_id,decision,rationale,
    reviewer_id,reviewer_email,reviewed_at,expires_at,mission_sha256,assignment_plan_sha256,
    user_authorization_sha256,attestations,idempotency_key,request_sha256
  ) VALUES($1,$2,$3,$4,$5,$6,btrim($7),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17);
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a1_assignment_enqueue_authorization_recorded','authorization_id',$1,
    'mission_id',$2,'trace_id',$3,'plan_version',$4,'dispatch_authorization_id',$5,
    'decision',$6,'reviewer_id',$8,'reviewer_email',$9,'reviewed_at',$10,'expires_at',$11,
    'mission_sha256',$12,'assignment_plan_sha256',$13,'user_authorization_sha256',$14,
    'request_sha256',$17,'assignments_enqueued',false,'execution_authorized',false,
    'dispatch_claiming_permitted',false,'external_action',false,'production_gate','blocked',
    'recorded_at',now_at));
  RETURN control.get_a1_assignment_enqueue_authorization($2);
END$$;

REVOKE ALL ON control.a1_assignment_enqueue_authorizations FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION control.get_a1_assignment_enqueue_authorization(uuid),control.record_a1_assignment_enqueue_authorization(uuid,uuid,uuid,text,uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,jsonb,text,text) FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.get_a1_assignment_enqueue_authorization(uuid),control.record_a1_assignment_enqueue_authorization(uuid,uuid,uuid,text,uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,jsonb,text,text) TO commercial_runtime;

COMMIT;
