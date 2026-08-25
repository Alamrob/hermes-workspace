BEGIN;

CREATE TABLE control.policy_human_reviews (
  project_id text NOT NULL CHECK (project_id='proptimiza'),
  policy_version text NOT NULL CHECK (policy_version='policy-v2'),
  review_kind text NOT NULL CHECK (review_kind IN ('commercial','privacy_legal')),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 20 AND 2000),
  reviewer_id text NOT NULL CHECK (reviewer_id ~ '^[A-Za-z0-9._:@+-]{3,254}$'),
  reviewer_email text NOT NULL CHECK (reviewer_email='proptimizaspa@gmail.com'),
  reviewed_at timestamptz NOT NULL,
  policy_digest text NOT NULL CHECK (policy_digest='888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19'),
  attestations jsonb NOT NULL CHECK (jsonb_typeof(attestations)='object'),
  idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key ~ '^policy-review:[A-Za-z0-9._:-]{8,108}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id,policy_version,review_kind),
  FOREIGN KEY(project_id,policy_version) REFERENCES catalog.policy_versions(project_id,version) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION control.reject_policy_human_review_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'POLICY_HUMAN_REVIEW_IMMUTABLE'; END
$$;

CREATE TRIGGER policy_human_reviews_immutable
BEFORE UPDATE OR DELETE ON control.policy_human_reviews
FOR EACH ROW EXECUTE FUNCTION control.reject_policy_human_review_mutation();

CREATE OR REPLACE FUNCTION control.build_policy_review_state() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
WITH policy AS (
  SELECT p.policy,p.created_at
  FROM catalog.policy_versions p
  WHERE p.project_id='proptimiza' AND p.version='policy-v2'
), reviews AS (
  SELECT review_kind,jsonb_build_object(
    'kind',review_kind,
    'decision',decision,
    'rationale',rationale,
    'reviewerId',reviewer_id,
    'reviewerEmail',reviewer_email,
    'reviewedAt',to_char(reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'policyDigest',policy_digest,
    'attestations',jsonb_build_object(
      'policyDigestConfirmed',(attestations->>'policy_digest_confirmed')::boolean,
      'noActivationRequested',(attestations->>'no_activation_requested')::boolean,
      'reviewScopeConfirmed',(attestations->>'review_scope_confirmed')::boolean,
      'controlSetConfirmed',(attestations->>'control_set_confirmed')::boolean,
      'competentHumanConfirmed',(attestations->>'competent_human_confirmed')::boolean
    )
  ) AS item FROM control.policy_human_reviews
  WHERE project_id='proptimiza' AND policy_version='policy-v2'
), active AS (
  SELECT policy_version FROM catalog.current_version_activation WHERE project_id='proptimiza'
)
SELECT jsonb_build_object(
  'projectId','proptimiza',
  'policyVersion','policy-v2',
  'policyDigest','888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19',
  'draftStatus',policy.policy->>'status',
  'effective',(policy.policy->>'effective')::boolean,
  'externalContact',(policy.policy->>'external_contact')::boolean,
  'activePolicyVersion',active.policy_version,
  'commercialReview',(SELECT item FROM reviews WHERE review_kind='commercial'),
  'privacyLegalReview',(SELECT item FROM reviews WHERE review_kind='privacy_legal'),
  'reviewCompleted',coalesce((SELECT bool_and(decision='approved') AND count(*)=2 FROM control.policy_human_reviews WHERE project_id='proptimiza' AND policy_version='policy-v2'),false),
  'activationCreated',false,
  'provenance',jsonb_build_object('source','control-broker','sourceId','policy-review:proptimiza:policy-v2','observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'synthetic',false)
)
FROM policy CROSS JOIN active
$$;

CREATE OR REPLACE FUNCTION control.record_policy_human_review(text,text,text,text,text,timestamptz,text,jsonb,text,text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing control.policy_human_reviews%ROWTYPE; required_keys text[] := ARRAY['competent_human_confirmed','control_set_confirmed','no_activation_requested','policy_digest_confirmed','review_scope_confirmed'];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext($9));
  SELECT * INTO existing FROM control.policy_human_reviews WHERE idempotency_key=$9;
  IF FOUND THEN
    IF existing.review_kind<>$1 OR existing.decision<>$2 OR existing.request_sha256<>$10 OR existing.reviewer_id<>$4 OR existing.reviewer_email<>lower($5) THEN
      RAISE EXCEPTION 'POLICY_REVIEW_IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN control.build_policy_review_state();
  END IF;
  IF $1 NOT IN ('commercial','privacy_legal') OR $2 NOT IN ('approved','rejected') OR length(btrim($3)) NOT BETWEEN 20 AND 2000 OR
     $4 !~ '^[A-Za-z0-9._:@+-]{3,254}$' OR lower($5)<>'proptimizaspa@gmail.com' OR abs(extract(epoch FROM (clock_timestamp()-$6)))>300 OR
     $7<>'888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19' OR $9 !~ '^policy-review:[A-Za-z0-9._:-]{8,108}$' OR $10 !~ '^[0-9a-f]{64}$' OR
     jsonb_typeof($8)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys($8) AS keys(k))<>required_keys OR
     EXISTS(SELECT 1 FROM jsonb_each($8) WHERE jsonb_typeof(value)<>'boolean') OR ($8->>'policy_digest_confirmed')::boolean IS NOT TRUE OR
     ($8->>'no_activation_requested')::boolean IS NOT TRUE OR ($8->>'review_scope_confirmed')::boolean IS NOT TRUE OR
     ($2='approved' AND ($8->>'control_set_confirmed')::boolean IS NOT TRUE) OR
     ($2='approved' AND $1='privacy_legal' AND ($8->>'competent_human_confirmed')::boolean IS NOT TRUE) THEN
    RAISE EXCEPTION 'POLICY_REVIEW_INVALID';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM catalog.policy_versions WHERE project_id='proptimiza' AND version='policy-v2' AND policy->>'status'='draft_human_approval_required' AND policy->>'effective'='false' AND policy->>'external_contact'='false') OR
     EXISTS(SELECT 1 FROM catalog.version_activations WHERE project_id='proptimiza' AND policy_version='policy-v2') OR
     EXISTS(SELECT 1 FROM mail.delivery_policies WHERE project_id='proptimiza' AND policy_version='policy-v2') OR
     EXISTS(SELECT 1 FROM mail.delivery_policy_activations WHERE project_id='proptimiza' AND policy_version='policy-v2') THEN
    RAISE EXCEPTION 'POLICY_REVIEW_DRAFT_STATE_REQUIRED';
  END IF;
  IF EXISTS(SELECT 1 FROM control.policy_human_reviews WHERE project_id='proptimiza' AND policy_version='policy-v2' AND review_kind=$1) THEN
    RAISE EXCEPTION 'POLICY_REVIEW_IMMUTABLE_CONFLICT';
  END IF;
  INSERT INTO control.policy_human_reviews(project_id,policy_version,review_kind,decision,rationale,reviewer_id,reviewer_email,reviewed_at,policy_digest,attestations,idempotency_key,request_sha256)
  VALUES('proptimiza','policy-v2',$1,$2,btrim($3),$4,lower($5),$6,$7,$8,$9,$10);
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object('event','policy_human_review_recorded','project_id','proptimiza','policy_version','policy-v2','review_kind',$1,'decision',$2,'reviewer_id',$4,'reviewer_email',lower($5),'policy_digest',$7,'request_sha256',$10,'review_completed',(control.build_policy_review_state()->>'reviewCompleted')::boolean,'activation_created',false,'external_action',false,'recorded_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN control.build_policy_review_state();
END
$$;

DO $$
DECLARE state jsonb;
BEGIN
  state:=control.build_policy_review_state();
  IF state->>'draftStatus'<>'draft_human_approval_required' OR state->>'effective'<>'false' OR state->>'externalContact'<>'false' OR state->>'activePolicyVersion'<>'policy-v1' OR state->>'reviewCompleted'<>'false' OR state->>'activationCreated'<>'false' THEN
    RAISE EXCEPTION 'POLICY_REVIEW_INITIAL_STATE_INVALID';
  END IF;
END$$;

REVOKE ALL ON control.policy_human_reviews FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION control.reject_policy_human_review_mutation(),control.build_policy_review_state(),control.record_policy_human_review(text,text,text,text,text,timestamptz,text,jsonb,text,text) FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.build_policy_review_state(),control.record_policy_human_review(text,text,text,text,text,timestamptz,text,jsonb,text,text) TO commercial_runtime;

COMMIT;
