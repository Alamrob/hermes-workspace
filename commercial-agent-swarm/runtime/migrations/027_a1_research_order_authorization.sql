BEGIN;

CREATE TABLE control.a1_research_order_authorizations (
  order_authorization_id uuid PRIMARY KEY,
  review_id uuid NOT NULL UNIQUE REFERENCES control.draft_review_sessions(review_id) ON DELETE RESTRICT,
  parent_authorization_id uuid NOT NULL UNIQUE REFERENCES control.a1_research_authorizations(authorization_id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK(decision IN('approved','rejected')),
  rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 20 AND 1000),
  reviewer_id text NOT NULL CHECK(reviewer_id~'^[A-Za-z0-9._:@+-]{3,254}$'),
  reviewer_email text NOT NULL CHECK(reviewer_email='proptimizaspa@gmail.com'),
  reviewed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  dossier_sha256 text NOT NULL CHECK(dossier_sha256~'^[0-9a-f]{64}$'),
  unsigned_work_order_sha256 text NOT NULL UNIQUE CHECK(unsigned_work_order_sha256~'^[0-9a-f]{64}$'),
  mission_id uuid NOT NULL UNIQUE,
  user_authorization_sha256 text NOT NULL UNIQUE CHECK(user_authorization_sha256~'^[0-9a-f]{64}$'),
  attestations jsonb NOT NULL CHECK(attestations=jsonb_build_object(
    'exact_work_order_confirmed',true,
    'no_contact',true,
    'no_crm_write',true,
    'no_external_actions',true,
    'no_provider_credit_spend',true
  )),
  idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key~'^a1-order-auth:[A-Za-z0-9._:-]{8,112}$'),
  request_sha256 text NOT NULL CHECK(request_sha256~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(expires_at>reviewed_at AND expires_at<=reviewed_at+interval '30 minutes')
);

CREATE OR REPLACE FUNCTION control.get_a1_research_order_authorization(uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'orderAuthorizationId',row.order_authorization_id,
    'reviewId',row.review_id,
    'parentAuthorizationId',row.parent_authorization_id,
    'decision',row.decision,
    'rationale',row.rationale,
    'reviewerId',row.reviewer_id,
    'reviewerEmail',row.reviewer_email,
    'reviewedAt',to_char(row.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(row.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'dossierSha256',row.dossier_sha256,
    'unsignedWorkOrderSha256',row.unsigned_work_order_sha256,
    'missionId',row.mission_id,
    'userAuthorizationSha256',row.user_authorization_sha256,
    'attestations',jsonb_build_object(
      'exactWorkOrderConfirmed',true,'noContact',true,'noCrmWrite',true,
      'noExternalActions',true,'noProviderCreditSpend',true
    ),
    'idempotencyKey',row.idempotency_key,
    'executionAuthorized',false,'missionCreated',false,'dispatchQueued',false,
    'internetAccessAllowed',false,'providerCreditSpendAllowed',false,
    'contactPermitted',false,'crmWriteAllowed',false,'maximumExternalActions',0,
    'productionGate','blocked','nextRequiredGate','sign_exact_work_order',
    'provenance',jsonb_build_object(
      'source','control-broker',
      'sourceId','a1-research-order-authorization:'||row.order_authorization_id::text,
      'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'synthetic',false
    )
  ) FROM control.a1_research_order_authorizations row WHERE row.order_authorization_id=$1
$$;

CREATE OR REPLACE FUNCTION control.record_a1_research_order_authorization(
  uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,text,text,uuid,text,jsonb,text,text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  existing control.a1_research_order_authorizations%ROWTYPE;
  parent control.a1_research_authorizations%ROWTYPE;
  dossier jsonb;
  now_at timestamptz:=clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext($15));
  SELECT * INTO existing FROM control.a1_research_order_authorizations
  WHERE order_authorization_id=$1 OR review_id=$2 OR parent_authorization_id=$3 OR mission_id=$12 OR idempotency_key=$15;
  IF FOUND THEN
    IF existing.order_authorization_id<>$1 OR existing.review_id<>$2 OR existing.parent_authorization_id<>$3 OR
       existing.decision<>$4 OR existing.rationale<>btrim($5) OR existing.reviewer_id<>$6 OR
       existing.reviewer_email<>$7 OR existing.reviewed_at<>$8 OR existing.expires_at<>$9 OR
       existing.dossier_sha256<>$10 OR existing.unsigned_work_order_sha256<>$11 OR existing.mission_id<>$12 OR
       existing.user_authorization_sha256<>$13 OR existing.attestations<>$14 OR
       existing.idempotency_key<>$15 OR existing.request_sha256<>$16
    THEN RAISE EXCEPTION 'A1_RESEARCH_ORDER_AUTHORIZATION_IMMUTABLE_CONFLICT'; END IF;
    RETURN control.get_a1_research_order_authorization(existing.order_authorization_id);
  END IF;

  IF $4 NOT IN('approved','rejected') OR length(btrim($5)) NOT BETWEEN 20 AND 1000 OR
     $5~'[[:cntrl:]]' OR $5~*'(https?://|www[.]|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer[[:space:]]+[A-Za-z0-9._~-]{20,})' OR
     $6!~'^[A-Za-z0-9._:@+-]{3,254}$' OR $7<>'proptimizaspa@gmail.com' OR
     abs(extract(epoch FROM now_at-$8))>300 OR $9<=$8 OR $9>$8+interval '30 minutes' OR
     $10!~'^[0-9a-f]{64}$' OR $11!~'^[0-9a-f]{64}$' OR $13!~'^[0-9a-f]{64}$' OR
     $14<>jsonb_build_object('exact_work_order_confirmed',true,'no_contact',true,'no_crm_write',true,'no_external_actions',true,'no_provider_credit_spend',true) OR
     $15!~'^a1-order-auth:[A-Za-z0-9._:-]{8,112}$' OR $16!~'^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'A1_RESEARCH_ORDER_AUTHORIZATION_INVALID'; END IF;

  SELECT * INTO parent FROM control.a1_research_authorizations WHERE authorization_id=$3 AND review_id=$2 FOR SHARE;
  IF NOT FOUND OR parent.decision<>'approved' OR parent.dossier_sha256<>$10 OR parent.expires_at<=now_at OR
     $8<parent.reviewed_at OR $9>parent.expires_at
  THEN RAISE EXCEPTION 'A1_RESEARCH_ORDER_AUTHORIZATION_GATE_CLOSED'; END IF;
  dossier:=control.build_a1_research_dossier($2);
  IF dossier IS NULL OR dossier->>'status'<>'authorization_required' OR dossier->>'reviewCompleted'<>'true' OR
     (dossier->>'eligibleAccountCount')::integer<1 OR dossier->>'missionCreated'<>'false' OR
     dossier->>'internetAccessAllowed'<>'false' OR dossier->>'providerCreditSpendAllowed'<>'false' OR
     dossier->>'contactPermitted'<>'false' OR dossier->>'crmWriteAllowed'<>'false' OR
     dossier->>'productionGate'<>'blocked' OR (dossier->>'externalActions')::integer<>0
  THEN RAISE EXCEPTION 'A1_RESEARCH_ORDER_AUTHORIZATION_GATE_CLOSED'; END IF;

  INSERT INTO control.a1_research_order_authorizations(
    order_authorization_id,review_id,parent_authorization_id,decision,rationale,reviewer_id,reviewer_email,
    reviewed_at,expires_at,dossier_sha256,unsigned_work_order_sha256,mission_id,user_authorization_sha256,
    attestations,idempotency_key,request_sha256
  ) VALUES($1,$2,$3,$4,btrim($5),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16);
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a1_research_order_authorization_recorded','order_authorization_id',$1,'review_id',$2,
    'parent_authorization_id',$3,'decision',$4,'reviewer_id',$6,'reviewer_email',$7,
    'reviewed_at',to_char($8 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expires_at',to_char($9 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'dossier_sha256',$10,'unsigned_work_order_sha256',$11,'mission_id',$12,
    'user_authorization_sha256',$13,'request_sha256',$16,'mission_created',false,'dispatch_queued',false,
    'internet_access_allowed',false,'provider_credit_spend_allowed',false,'external_action',false,
    'production_gate','blocked','recorded_at',to_char(now_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ));
  RETURN control.get_a1_research_order_authorization($1);
END$$;

REVOKE ALL ON control.a1_research_order_authorizations
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION control.get_a1_research_order_authorization(uuid),
  control.record_a1_research_order_authorization(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,text,text,uuid,text,jsonb,text,text)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.get_a1_research_order_authorization(uuid),
  control.record_a1_research_order_authorization(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,text,text,uuid,text,jsonb,text,text)
TO commercial_runtime;

COMMIT;
