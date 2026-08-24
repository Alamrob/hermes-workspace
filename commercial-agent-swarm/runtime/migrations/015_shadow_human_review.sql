BEGIN;

CREATE TABLE control.shadow_review_sessions (
  review_id uuid PRIMARY KEY,
  mission_id uuid NOT NULL UNIQUE REFERENCES control.missions(mission_id) ON DELETE RESTRICT,
  project_id text NOT NULL CHECK (project_id = 'proptimiza'),
  title text NOT NULL CHECK (btrim(title) <> ''),
  source_artifact_sha256 text NOT NULL CHECK (source_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  qa_artifact_sha256 text NOT NULL CHECK (qa_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  expected_decisions integer NOT NULL CHECK (expected_decisions = 30),
  external_actions integer NOT NULL CHECK (external_actions = 0),
  status text NOT NULL CHECK (status IN ('open','completed')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  concordance_percent numeric(5,2),
  evidence_completeness_percent numeric(5,2),
  shadow_gate text NOT NULL DEFAULT 'pending' CHECK (shadow_gate IN ('pending','passed','failed')),
  production_gate text NOT NULL DEFAULT 'blocked' CHECK (production_gate = 'blocked'),
  reviewer_id text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'open' AND reviewer_id IS NULL AND completed_at IS NULL AND concordance_percent IS NULL AND evidence_completeness_percent IS NULL AND shadow_gate = 'pending')
    OR
    (status = 'completed' AND reviewer_id IS NOT NULL AND completed_at IS NOT NULL AND concordance_percent IS NOT NULL AND evidence_completeness_percent IS NOT NULL AND shadow_gate IN ('passed','failed'))
  )
);

CREATE TABLE control.shadow_review_accounts (
  review_id uuid NOT NULL REFERENCES control.shadow_review_sessions(review_id) ON DELETE RESTRICT,
  account_slot integer NOT NULL CHECK (account_slot BETWEEN 1 AND 10),
  account_name text NOT NULL CHECK (btrim(account_name) <> ''),
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  PRIMARY KEY (review_id, account_slot),
  UNIQUE (review_id, source_url)
);

CREATE TABLE control.shadow_review_decisions (
  review_id uuid NOT NULL,
  account_slot integer NOT NULL,
  dimension text NOT NULL CHECK (dimension IN ('icp_fit','evidence_sufficiency','outreach_eligibility')),
  machine_value text NOT NULL,
  machine_rationale text NOT NULL CHECK (btrim(machine_rationale) <> ''),
  evidence_url text NOT NULL CHECK (evidence_url ~ '^https://'),
  human_value text,
  human_rationale text,
  reviewer_id text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz,
  PRIMARY KEY (review_id, account_slot, dimension),
  FOREIGN KEY (review_id, account_slot) REFERENCES control.shadow_review_accounts(review_id, account_slot) ON DELETE RESTRICT,
  CHECK (
    (dimension = 'icp_fit' AND machine_value IN ('yes','no','unknown'))
    OR (dimension = 'evidence_sufficiency' AND machine_value IN ('sufficient','insufficient'))
    OR (dimension = 'outreach_eligibility' AND machine_value IN ('yes','no'))
  ),
  CHECK (
    human_value IS NULL
    OR (dimension = 'icp_fit' AND human_value IN ('yes','no','unknown'))
    OR (dimension = 'evidence_sufficiency' AND human_value IN ('sufficient','insufficient'))
    OR (dimension = 'outreach_eligibility' AND human_value IN ('yes','no'))
  ),
  CHECK (
    (human_value IS NULL AND human_rationale IS NULL AND reviewer_id IS NULL AND updated_at IS NULL AND version = 0)
    OR (human_value IS NOT NULL AND length(btrim(human_rationale)) BETWEEN 3 AND 1000 AND reviewer_id IS NOT NULL AND updated_at IS NOT NULL AND version > 0)
  )
);

CREATE TABLE control.shadow_review_commands (
  idempotency_key text PRIMARY KEY CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  review_id uuid NOT NULL REFERENCES control.shadow_review_sessions(review_id) ON DELETE RESTRICT,
  command_type text NOT NULL CHECK (command_type IN ('record_decision','complete_review')),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9._:@+-]{3,254}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION control.build_shadow_review(uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
WITH session AS (
  SELECT * FROM control.shadow_review_sessions WHERE review_id=$1
), accounts AS (
  SELECT a.review_id, jsonb_agg(
    jsonb_build_object(
      'slot',a.account_slot,
      'name',a.account_name,
      'url',a.source_url,
      'decisions',(
        SELECT jsonb_agg(jsonb_build_object(
          'dimension',d.dimension,
          'machineValue',d.machine_value,
          'machineRationale',d.machine_rationale,
          'humanValue',d.human_value,
          'humanRationale',d.human_rationale,
          'evidenceUrl',d.evidence_url,
          'version',d.version,
          'updatedAt',CASE WHEN d.updated_at IS NULL THEN NULL ELSE to_char(d.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
        ) ORDER BY CASE d.dimension WHEN 'icp_fit' THEN 1 WHEN 'evidence_sufficiency' THEN 2 ELSE 3 END)
        FROM control.shadow_review_decisions d
        WHERE d.review_id=a.review_id AND d.account_slot=a.account_slot
      )
    ) ORDER BY a.account_slot
  ) AS items
  FROM control.shadow_review_accounts a WHERE a.review_id=$1 GROUP BY a.review_id
), completed AS (
  SELECT review_id,count(*) FILTER (WHERE human_value IS NOT NULL)::integer AS count
  FROM control.shadow_review_decisions WHERE review_id=$1 GROUP BY review_id
)
SELECT jsonb_build_object(
  'id',s.review_id,
  'missionId',s.mission_id,
  'projectId',s.project_id,
  'title',s.title,
  'status',s.status,
  'expectedDecisionCount',s.expected_decisions,
  'completedDecisionCount',coalesce(c.count,0),
  'version',s.version,
  'concordancePercent',s.concordance_percent,
  'evidenceCompletenessPercent',s.evidence_completeness_percent,
  'shadowGate',s.shadow_gate,
  'productionGate',s.production_gate,
  'externalActions',s.external_actions,
  'reviewerId',s.reviewer_id,
  'completedAt',CASE WHEN s.completed_at IS NULL THEN NULL ELSE to_char(s.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
  'sourceArtifactSha256',s.source_artifact_sha256,
  'qaArtifactSha256',s.qa_artifact_sha256,
  'accounts',coalesce(a.items,'[]'::jsonb),
  'provenance',jsonb_build_object(
    'source','control-broker',
    'sourceId','shadow-review:' || s.review_id::text,
    'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'synthetic',false
  )
)
FROM session s LEFT JOIN accounts a USING(review_id) LEFT JOIN completed c USING(review_id)
$$;

CREATE OR REPLACE FUNCTION control.list_shadow_reviews() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_agg(control.build_shadow_review(review_id) ORDER BY created_at DESC),'[]'::jsonb)
  FROM control.shadow_review_sessions
$$;

CREATE OR REPLACE FUNCTION control.get_shadow_review(uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT control.build_shadow_review($1)
$$;

CREATE OR REPLACE FUNCTION control.record_shadow_review_decision(
  uuid,integer,text,text,text,text,integer,text,text,text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing control.shadow_review_commands%ROWTYPE; current_version integer; result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext($9));
  SELECT * INTO existing FROM control.shadow_review_commands WHERE idempotency_key=$9;
  IF FOUND THEN
    IF existing.review_id<>$1 OR existing.command_type<>'record_decision' OR existing.request_sha256<>$10 OR existing.actor_id<>$8 THEN
      RAISE EXCEPTION 'SHADOW_REVIEW_IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN existing.result;
  END IF;
  IF $8 !~ '^[A-Za-z0-9._:@+-]{3,254}$' OR $9 !~ '^[A-Za-z0-9._:-]{8,128}$' OR $10 !~ '^[0-9a-f]{64}$' OR length(btrim($5)) NOT BETWEEN 3 AND 1000 OR $6 !~ '^https://' THEN
    RAISE EXCEPTION 'SHADOW_REVIEW_DECISION_INVALID';
  END IF;
  IF NOT (($3='icp_fit' AND $4 IN ('yes','no','unknown')) OR ($3='evidence_sufficiency' AND $4 IN ('sufficient','insufficient')) OR ($3='outreach_eligibility' AND $4 IN ('yes','no'))) THEN
    RAISE EXCEPTION 'SHADOW_REVIEW_DECISION_INVALID';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM control.shadow_review_sessions WHERE review_id=$1 AND status='open') THEN
    RAISE EXCEPTION 'SHADOW_REVIEW_NOT_OPEN';
  END IF;
  SELECT version INTO current_version FROM control.shadow_review_decisions WHERE review_id=$1 AND account_slot=$2 AND dimension=$3 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHADOW_REVIEW_DECISION_NOT_FOUND'; END IF;
  IF current_version<>$7 THEN RAISE EXCEPTION 'SHADOW_REVIEW_VERSION_CONFLICT'; END IF;
  UPDATE control.shadow_review_decisions SET human_value=$4,human_rationale=btrim($5),evidence_url=$6,reviewer_id=$8,version=version+1,updated_at=clock_timestamp()
  WHERE review_id=$1 AND account_slot=$2 AND dimension=$3;
  UPDATE control.shadow_review_sessions SET version=version+1,updated_at=clock_timestamp() WHERE review_id=$1;
  result:=control.build_shadow_review($1);
  INSERT INTO control.shadow_review_commands(idempotency_key,review_id,command_type,request_sha256,result,actor_id) VALUES($9,$1,'record_decision',$10,result,$8);
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object('event','shadow_review_decision_recorded','review_id',$1,'account_slot',$2,'dimension',$3,'actor_id',$8,'request_sha256',$10,'external_action',false,'recorded_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN result;
END
$$;

CREATE OR REPLACE FUNCTION control.complete_shadow_review(uuid,integer,text,text,text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing control.shadow_review_commands%ROWTYPE; current_version integer; completed_count integer; matches integer; evidence_count integer; concordance numeric(5,2); completeness numeric(5,2); result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext($4));
  SELECT * INTO existing FROM control.shadow_review_commands WHERE idempotency_key=$4;
  IF FOUND THEN
    IF existing.review_id<>$1 OR existing.command_type<>'complete_review' OR existing.request_sha256<>$5 OR existing.actor_id<>$3 THEN
      RAISE EXCEPTION 'SHADOW_REVIEW_IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN existing.result;
  END IF;
  IF $3 !~ '^[A-Za-z0-9._:@+-]{3,254}$' OR $4 !~ '^[A-Za-z0-9._:-]{8,128}$' OR $5 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'SHADOW_REVIEW_COMPLETION_INVALID'; END IF;
  SELECT version INTO current_version FROM control.shadow_review_sessions WHERE review_id=$1 AND status='open' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHADOW_REVIEW_NOT_OPEN'; END IF;
  IF current_version<>$2 THEN RAISE EXCEPTION 'SHADOW_REVIEW_VERSION_CONFLICT'; END IF;
  SELECT count(*) FILTER(WHERE human_value IS NOT NULL),count(*) FILTER(WHERE human_value=machine_value),count(*) FILTER(WHERE evidence_url ~ '^https://' AND length(btrim(human_rationale))>=3)
  INTO completed_count,matches,evidence_count FROM control.shadow_review_decisions WHERE review_id=$1;
  IF completed_count<>30 THEN RAISE EXCEPTION 'SHADOW_REVIEW_INCOMPLETE'; END IF;
  concordance:=round(matches::numeric*100/30,2); completeness:=round(evidence_count::numeric*100/30,2);
  UPDATE control.shadow_review_sessions SET status='completed',version=version+1,concordance_percent=concordance,evidence_completeness_percent=completeness,shadow_gate=CASE WHEN concordance>=90 AND completeness>=95 AND external_actions=0 THEN 'passed' ELSE 'failed' END,production_gate='blocked',reviewer_id=$3,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE review_id=$1;
  result:=control.build_shadow_review($1);
  INSERT INTO control.shadow_review_commands(idempotency_key,review_id,command_type,request_sha256,result,actor_id) VALUES($4,$1,'complete_review',$5,result,$3);
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object('event','shadow_review_completed','review_id',$1,'actor_id',$3,'concordance_percent',concordance,'evidence_completeness_percent',completeness,'production_gate','blocked','external_action',false,'recorded_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN result;
END
$$;

DO $$ BEGIN
IF EXISTS(SELECT 1 FROM control.missions WHERE mission_id='bbfc3cae-e64d-5fc8-93a8-5354f470216a') THEN
  INSERT INTO control.shadow_review_sessions(review_id,mission_id,project_id,title,source_artifact_sha256,qa_artifact_sha256,expected_decisions,external_actions,status)
  VALUES('a1500000-0000-4500-8500-000000000050','bbfc3cae-e64d-5fc8-93a8-5354f470216a','proptimiza','Revisión humana ALA-50 · 10 cuentas × 3 decisiones','3e7ce42f86221028e1178247e4adeeb02b52eb7b4bcef78beadcb139f28f74e3','9947eb88927c51e74c3c2538c3bb6473aebb85028a5362a8adc7bc9041fe9a34',30,0,'open');

  WITH accounts(slot,name,url,rationale) AS (VALUES
  (1,'Buk','https://www.buk.cl/','Official site evidences Chilean B2B HR SaaS activity; headcount and manual-operations signals not stated.'),
  (2,'CAM Logistic','https://camlogistic.cl/','Chilean B2B logistics with self-reported 75+ collaborators; manual-operations signal absent.'),
  (3,'Transtecnica','https://www.transtecnica.cl/','Chilean B2B logistics; headcount and manual-operations unknown.'),
  (4,'Transport Network','https://www.transportnetwork.cl/','Chilean B2B last-mile logistics; headcount and manual-operations not disclosed.'),
  (5,'Akiva','https://www.akiva.cl/','Page title only; body not retrievable, size and operations unknown.'),
  (6,'Recíbelo','https://www.recibelo.cl/','Chilean B2B last-mile logistics; API/webhook features do not evidence internal manual operations; headcount unknown.'),
  (7,'JOINT','https://joint.cl/','Chilean B2B last-mile/3PL; public WhatsApp is not evidence of internal manual operations; size unknown.'),
  (8,'Pulso RRHH','https://www.pulsorrhh.cl/','Chilean B2B HR consultancy for SMEs; company size and internal tooling unknown.'),
  (9,'Youhr','https://youhr.cl/','Chilean B2B HR consultancy for PYMEs; headcount and manual operations not published.'),
  (10,'CuBuQ','https://www.cubuq.cl/','Chilean B2B digital accounting office; headcount and manual operations not published.')
  ) INSERT INTO control.shadow_review_accounts(review_id,account_slot,account_name,source_url)
    SELECT 'a1500000-0000-4500-8500-000000000050',slot,name,url FROM accounts;

  WITH accounts(slot,url,rationale) AS (VALUES
    (1,'https://www.buk.cl/','Official site evidences Chilean B2B HR SaaS activity; headcount and manual-operations signals not stated.'),
    (2,'https://camlogistic.cl/','Chilean B2B logistics with self-reported 75+ collaborators; manual-operations signal absent.'),
    (3,'https://www.transtecnica.cl/','Chilean B2B logistics; headcount and manual-operations unknown.'),
    (4,'https://www.transportnetwork.cl/','Chilean B2B last-mile logistics; headcount and manual-operations not disclosed.'),
    (5,'https://www.akiva.cl/','Page title only; body not retrievable, size and operations unknown.'),
    (6,'https://www.recibelo.cl/','Chilean B2B last-mile logistics; API/webhook features do not evidence internal manual operations; headcount unknown.'),
    (7,'https://joint.cl/','Chilean B2B last-mile/3PL; public WhatsApp is not evidence of internal manual operations; size unknown.'),
    (8,'https://www.pulsorrhh.cl/','Chilean B2B HR consultancy for SMEs; company size and internal tooling unknown.'),
    (9,'https://youhr.cl/','Chilean B2B HR consultancy for PYMEs; headcount and manual operations not published.'),
    (10,'https://www.cubuq.cl/','Chilean B2B digital accounting office; headcount and manual operations not published.')
  ) INSERT INTO control.shadow_review_decisions(review_id,account_slot,dimension,machine_value,machine_rationale,evidence_url)
    SELECT 'a1500000-0000-4500-8500-000000000050',a.slot,d.dimension,d.machine_value,a.rationale,a.url
    FROM accounts a CROSS JOIN (VALUES('icp_fit','unknown'),('evidence_sufficiency','insufficient'),('outreach_eligibility','no')) AS d(dimension,machine_value);

  IF (SELECT count(*) FROM control.shadow_review_accounts WHERE review_id='a1500000-0000-4500-8500-000000000050')<>10 OR (SELECT count(*) FROM control.shadow_review_decisions WHERE review_id='a1500000-0000-4500-8500-000000000050')<>30 THEN RAISE EXCEPTION 'ALA50_SHADOW_REVIEW_SEED_INVALID'; END IF;
END IF;
END $$;

REVOKE ALL ON control.shadow_review_sessions,control.shadow_review_accounts,control.shadow_review_decisions,control.shadow_review_commands FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION control.build_shadow_review(uuid),control.list_shadow_reviews(),control.get_shadow_review(uuid),control.record_shadow_review_decision(uuid,integer,text,text,text,text,integer,text,text,text),control.complete_shadow_review(uuid,integer,text,text,text) FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.list_shadow_reviews(),control.get_shadow_review(uuid),control.record_shadow_review_decision(uuid,integer,text,text,text,text,integer,text,text,text),control.complete_shadow_review(uuid,integer,text,text,text) TO commercial_runtime;

COMMIT;
