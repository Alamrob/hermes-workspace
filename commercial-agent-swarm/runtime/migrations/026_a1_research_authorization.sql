BEGIN;

CREATE TABLE control.a1_research_authorizations (
  authorization_id uuid PRIMARY KEY,
  review_id uuid NOT NULL UNIQUE REFERENCES control.draft_review_sessions(review_id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK(decision IN('approved','rejected')),
  rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 20 AND 1000),
  reviewer_id text NOT NULL CHECK(reviewer_id~'^[A-Za-z0-9._:@+-]{3,254}$'),
  reviewer_email text NOT NULL CHECK(reviewer_email='proptimizaspa@gmail.com'),
  reviewed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  dossier_sha256 text NOT NULL CHECK(dossier_sha256~'^[0-9a-f]{64}$'),
  attestations jsonb NOT NULL CHECK(
    jsonb_typeof(attestations)='object' AND
    attestations=jsonb_build_object(
      'no_contact',true,
      'no_crm_write',true,
      'no_external_actions',true,
      'no_provider_credit_spend',true,
      'separate_signed_work_order_required',true
    )
  ),
  idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key~'^a1-research-auth:[A-Za-z0-9._:-]{8,110}$'),
  request_sha256 text NOT NULL CHECK(request_sha256~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(expires_at>reviewed_at AND expires_at<=reviewed_at+interval '30 minutes')
);

CREATE OR REPLACE FUNCTION control.build_a1_research_authorization_state(uuid,text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  dossier jsonb;
  authorization control.a1_research_authorizations%ROWTYPE;
  authorization_json jsonb := NULL;
  current_dossier boolean := true;
  next_gate text;
BEGIN
  IF $2!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A1_RESEARCH_AUTHORIZATION_INVALID'; END IF;
  dossier:=control.build_a1_research_dossier($1);
  IF dossier IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO authorization FROM control.a1_research_authorizations WHERE review_id=$1;
  IF FOUND THEN
    current_dossier:=authorization.dossier_sha256=$2;
    authorization_json:=jsonb_build_object(
      'authorizationId',authorization.authorization_id,
      'decision',authorization.decision,
      'rationale',authorization.rationale,
      'reviewerId',authorization.reviewer_id,
      'reviewerEmail',authorization.reviewer_email,
      'reviewedAt',to_char(authorization.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expiresAt',to_char(authorization.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'dossierSha256',authorization.dossier_sha256,
      'attestations',jsonb_build_object(
        'noContact',true,
        'noCrmWrite',true,
        'noExternalActions',true,
        'noProviderCreditSpend',true,
        'separateSignedWorkOrderRequired',true
      )
    );
  END IF;
  next_gate:=CASE
    WHEN dossier->>'status'='review_incomplete' THEN 'complete_draft_review'
    WHEN dossier->>'status'='no_eligible_accounts' THEN 'no_eligible_accounts'
    WHEN authorization.authorization_id IS NULL THEN 'human_authorization'
    WHEN NOT current_dossier THEN 'stale_dossier_review'
    WHEN authorization.decision='rejected' THEN 'authorization_rejected'
    ELSE 'separate_signed_work_order'
  END;
  RETURN jsonb_build_object(
    'reviewId',dossier->>'reviewId',
    'projectId',dossier->>'projectId',
    'offerId',dossier->>'offerId',
    'offerVersion',dossier->>'offerVersion',
    'dossierSha256',$2,
    'dossierStatus',dossier->>'status',
    'eligibleAccountCount',(dossier->>'eligibleAccountCount')::integer,
    'authorizationRecorded',authorization.authorization_id IS NOT NULL,
    'dossierCurrent',current_dossier,
    'authorization',authorization_json,
    'executionAuthorized',false,
    'missionCreated',false,
    'internetAccessAllowed',false,
    'providerCreditSpendAllowed',false,
    'contactPermitted',false,
    'crmWriteAllowed',false,
    'maximumExternalActions',0,
    'productionGate','blocked',
    'separateSignedWorkOrderRequired',true,
    'nextRequiredGate',next_gate,
    'provenance',jsonb_build_object(
      'source','control-broker',
      'sourceId','a1-research-authorization:'||$1::text,
      'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'synthetic',false
    )
  );
END$$;

CREATE OR REPLACE FUNCTION control.record_a1_research_authorization(uuid,uuid,text,text,text,text,timestamptz,timestamptz,text,jsonb,text,text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  existing control.a1_research_authorizations%ROWTYPE;
  dossier jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext($11));
  SELECT * INTO existing FROM control.a1_research_authorizations WHERE idempotency_key=$11 OR review_id=$2;
  IF FOUND THEN
    IF existing.authorization_id<>$1 OR existing.review_id<>$2 OR existing.decision<>$3 OR existing.rationale<>btrim($4) OR
       existing.reviewer_id<>$5 OR existing.reviewer_email<>$6 OR existing.reviewed_at<>$7 OR existing.expires_at<>$8 OR
       existing.dossier_sha256<>$9 OR existing.attestations<>$10 OR existing.idempotency_key<>$11 OR existing.request_sha256<>$12
    THEN RAISE EXCEPTION 'A1_RESEARCH_AUTHORIZATION_IMMUTABLE_CONFLICT'; END IF;
    RETURN control.build_a1_research_authorization_state($2,$9);
  END IF;
  IF $3 NOT IN('approved','rejected') OR length(btrim($4)) NOT BETWEEN 20 AND 1000 OR
     $4~'[[:cntrl:]]' OR $4~*'(https?://|www[.]|```|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|oc_sk)-[A-Za-z0-9_-]{16,}|Bearer[[:space:]]+[A-Za-z0-9._~-]{20,})' OR
     $5!~'^[A-Za-z0-9._:@+-]{3,254}$' OR $6<>'proptimizaspa@gmail.com' OR
     $8<=$7 OR $8>$7+interval '30 minutes' OR $9!~'^[0-9a-f]{64}$' OR
     $10<>jsonb_build_object('no_contact',true,'no_crm_write',true,'no_external_actions',true,'no_provider_credit_spend',true,'separate_signed_work_order_required',true) OR
     $11!~'^a1-research-auth:[A-Za-z0-9._:-]{8,110}$' OR $12!~'^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'A1_RESEARCH_AUTHORIZATION_INVALID'; END IF;
  dossier:=control.build_a1_research_dossier($2);
  IF dossier IS NULL THEN RAISE EXCEPTION 'A1_RESEARCH_DOSSIER_NOT_FOUND'; END IF;
  IF dossier->>'status'<>'authorization_required' OR dossier->>'reviewCompleted'<>'true' OR
     (dossier->>'eligibleAccountCount')::integer<1 OR dossier->>'missionCreated'<>'false' OR
     dossier->>'internetAccessAllowed'<>'false' OR dossier->>'providerCreditSpendAllowed'<>'false' OR
     dossier->>'contactPermitted'<>'false' OR dossier->>'crmWriteAllowed'<>'false' OR
     dossier->>'productionGate'<>'blocked' OR (dossier->>'externalActions')::integer<>0
  THEN RAISE EXCEPTION 'A1_RESEARCH_AUTHORIZATION_GATE_CLOSED'; END IF;
  INSERT INTO control.a1_research_authorizations(
    authorization_id,review_id,decision,rationale,reviewer_id,reviewer_email,reviewed_at,expires_at,
    dossier_sha256,attestations,idempotency_key,request_sha256
  ) VALUES($1,$2,$3,btrim($4),$5,$6,$7,$8,$9,$10,$11,$12);
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a1_research_authorization_recorded','authorization_id',$1,'review_id',$2,'decision',$3,
    'reviewer_id',$5,'reviewer_email',$6,'reviewed_at',to_char($7 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expires_at',to_char($8 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'dossier_sha256',$9,'request_sha256',$12,'mission_created',false,'internet_access_allowed',false,
    'provider_credit_spend_allowed',false,'external_action',false,'production_gate','blocked',
    'recorded_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ));
  RETURN control.build_a1_research_authorization_state($2,$9);
END$$;

REVOKE ALL ON control.a1_research_authorizations FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION control.build_a1_research_authorization_state(uuid,text),control.record_a1_research_authorization(uuid,uuid,text,text,text,text,timestamptz,timestamptz,text,jsonb,text,text)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.build_a1_research_authorization_state(uuid,text),control.record_a1_research_authorization(uuid,uuid,text,text,text,text,timestamptz,timestamptz,text,jsonb,text,text) TO commercial_runtime;

COMMIT;
