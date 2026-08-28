BEGIN;

CREATE TABLE control.draft_review_sessions (
  review_id uuid PRIMARY KEY,
  mission_id uuid NOT NULL UNIQUE REFERENCES control.missions(mission_id) ON DELETE RESTRICT,
  predecessor_mission_id uuid NOT NULL UNIQUE REFERENCES control.missions(mission_id) ON DELETE RESTRICT,
  project_id text NOT NULL CHECK(project_id='proptimiza'),
  offer_id text NOT NULL CHECK(offer_id='operacion-sin-planillas'),
  offer_version text NOT NULL CHECK(offer_version='v1'),
  title text NOT NULL CHECK(btrim(title)<>''),
  source_artifact_sha256 text NOT NULL CHECK(source_artifact_sha256~'^[0-9a-f]{64}$'),
  qa_artifact_sha256 text NOT NULL CHECK(qa_artifact_sha256~'^[0-9a-f]{64}$'),
  predecessor_artifact_sha256 text NOT NULL CHECK(predecessor_artifact_sha256~'^[0-9a-f]{64}$'),
  predecessor_qa_artifact_sha256 text NOT NULL CHECK(predecessor_qa_artifact_sha256~'^[0-9a-f]{64}$'),
  expected_items integer NOT NULL CHECK(expected_items=3),
  external_actions integer NOT NULL CHECK(external_actions=0),
  status text NOT NULL CHECK(status IN('open','completed')),
  version integer NOT NULL DEFAULT 0 CHECK(version>=0),
  internal_review_gate text NOT NULL DEFAULT 'pending' CHECK(internal_review_gate IN('pending','complete')),
  production_gate text NOT NULL DEFAULT 'blocked' CHECK(production_gate='blocked'),
  reviewer_id text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(
    (status='open' AND internal_review_gate='pending' AND reviewer_id IS NULL AND completed_at IS NULL)
    OR (status='completed' AND internal_review_gate='complete' AND reviewer_id IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE control.draft_review_items (
  review_id uuid NOT NULL REFERENCES control.draft_review_sessions(review_id) ON DELETE RESTRICT,
  item_slot integer NOT NULL CHECK(item_slot BETWEEN 1 AND 3),
  company_name text NOT NULL CHECK(btrim(company_name)<>''),
  source_url text NOT NULL CHECK(source_url~'^https://'),
  evidence_basis text NOT NULL CHECK(btrim(evidence_basis)<>''),
  original_subject text NOT NULL CHECK(btrim(original_subject)<>''),
  original_body text NOT NULL CHECK(btrim(original_body)<>''),
  source_draft_sha256 text NOT NULL CHECK(source_draft_sha256~'^[0-9a-f]{64}$'),
  machine_decision text NOT NULL CHECK(machine_decision='human_review_candidate'),
  machine_reason text NOT NULL CHECK(btrim(machine_reason)<>''),
  risk_flags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(risk_flags)='array'),
  human_decision text CHECK(human_decision IN('accepted_internal','revised_internal','rejected')),
  human_rationale text,
  revised_subject text,
  revised_body text,
  approval_state text NOT NULL DEFAULT 'human_review_required' CHECK(approval_state IN('human_review_required','internal_reviewed','not_applicable')),
  external_action_eligible boolean NOT NULL DEFAULT false CHECK(NOT external_action_eligible),
  reviewer_id text,
  version integer NOT NULL DEFAULT 0 CHECK(version>=0),
  updated_at timestamptz,
  PRIMARY KEY(review_id,item_slot),
  UNIQUE(review_id,source_url),
  UNIQUE(review_id,source_draft_sha256),
  CHECK(
    (human_decision IS NULL AND human_rationale IS NULL AND revised_subject IS NULL AND revised_body IS NULL AND approval_state='human_review_required' AND reviewer_id IS NULL AND version=0 AND updated_at IS NULL)
    OR (human_decision='accepted_internal' AND length(btrim(human_rationale)) BETWEEN 10 AND 1000 AND revised_subject IS NULL AND revised_body IS NULL AND approval_state='internal_reviewed' AND reviewer_id IS NOT NULL AND version>0 AND updated_at IS NOT NULL)
    OR (human_decision='rejected' AND length(btrim(human_rationale)) BETWEEN 10 AND 1000 AND revised_subject IS NULL AND revised_body IS NULL AND approval_state='not_applicable' AND reviewer_id IS NOT NULL AND version>0 AND updated_at IS NOT NULL)
    OR (human_decision='revised_internal' AND length(btrim(human_rationale)) BETWEEN 10 AND 1000 AND length(btrim(revised_subject)) BETWEEN 10 AND 200 AND length(btrim(revised_body)) BETWEEN 30 AND 2000 AND approval_state='internal_reviewed' AND reviewer_id IS NOT NULL AND version>0 AND updated_at IS NOT NULL)
  )
);

CREATE TABLE control.draft_review_commands (
  idempotency_key text PRIMARY KEY CHECK(idempotency_key~'^draft-review:[A-Za-z0-9._:-]{8,114}$'),
  review_id uuid NOT NULL REFERENCES control.draft_review_sessions(review_id) ON DELETE RESTRICT,
  command_type text NOT NULL CHECK(command_type IN('record_item','complete_review')),
  request_sha256 text NOT NULL CHECK(request_sha256~'^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  actor_id text NOT NULL CHECK(actor_id~'^[A-Za-z0-9._:@+-]{3,254}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION control.build_draft_review(uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
WITH session AS (
  SELECT * FROM control.draft_review_sessions WHERE review_id=$1
), items AS (
  SELECT review_id,jsonb_agg(jsonb_build_object(
    'slot',item_slot,'companyName',company_name,'sourceUrl',source_url,
    'evidenceBasis',evidence_basis,'originalSubject',original_subject,'originalBody',original_body,
    'sourceDraftSha256',source_draft_sha256,'machineDecision',machine_decision,
    'machineReason',machine_reason,'riskFlags',risk_flags,'humanDecision',human_decision,
    'humanRationale',human_rationale,'revisedSubject',revised_subject,'revisedBody',revised_body,
    'approvalState',approval_state,'externalActionEligible',external_action_eligible,
    'version',version,'updatedAt',CASE WHEN updated_at IS NULL THEN NULL ELSE to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
  ) ORDER BY item_slot) AS values
  FROM control.draft_review_items WHERE review_id=$1 GROUP BY review_id
), counts AS (
  SELECT review_id,
    count(*) FILTER(WHERE human_decision IS NOT NULL)::integer AS completed,
    count(*) FILTER(WHERE human_decision='accepted_internal')::integer AS accepted,
    count(*) FILTER(WHERE human_decision='revised_internal')::integer AS revised,
    count(*) FILTER(WHERE human_decision='rejected')::integer AS rejected
  FROM control.draft_review_items WHERE review_id=$1 GROUP BY review_id
)
SELECT jsonb_build_object(
  'id',s.review_id,'missionId',s.mission_id,'predecessorMissionId',s.predecessor_mission_id,
  'projectId',s.project_id,'offerId',s.offer_id,'offerVersion',s.offer_version,'title',s.title,
  'status',s.status,'expectedItemCount',s.expected_items,'completedItemCount',coalesce(c.completed,0),
  'acceptedCount',coalesce(c.accepted,0),'revisedCount',coalesce(c.revised,0),'rejectedCount',coalesce(c.rejected,0),
  'version',s.version,'internalReviewGate',s.internal_review_gate,'productionGate',s.production_gate,
  'externalActions',s.external_actions,'reviewerId',s.reviewer_id,
  'completedAt',CASE WHEN s.completed_at IS NULL THEN NULL ELSE to_char(s.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
  'sourceArtifactSha256',s.source_artifact_sha256,'qaArtifactSha256',s.qa_artifact_sha256,
  'predecessorArtifactSha256',s.predecessor_artifact_sha256,'predecessorQaArtifactSha256',s.predecessor_qa_artifact_sha256,
  'items',coalesce(i.values,'[]'::jsonb),
  'provenance',jsonb_build_object('source','control-broker','sourceId','draft-review:'||s.review_id::text,'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'synthetic',false)
)
FROM session s LEFT JOIN items i USING(review_id) LEFT JOIN counts c USING(review_id)
$$;

CREATE OR REPLACE FUNCTION control.list_draft_reviews() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_agg(control.build_draft_review(review_id) ORDER BY created_at DESC),'[]'::jsonb)
  FROM control.draft_review_sessions
$$;

CREATE OR REPLACE FUNCTION control.get_draft_review(uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT control.build_draft_review($1) $$;

CREATE OR REPLACE FUNCTION control.record_draft_review_item(uuid,integer,text,text,text,text,integer,text,text,text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing control.draft_review_commands%ROWTYPE; current_version integer; result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext($9));
  SELECT * INTO existing FROM control.draft_review_commands WHERE idempotency_key=$9;
  IF FOUND THEN
    IF existing.review_id<>$1 OR existing.command_type<>'record_item' OR existing.request_sha256<>$10 OR existing.actor_id<>$8 THEN RAISE EXCEPTION 'DRAFT_REVIEW_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN existing.result;
  END IF;
  IF $2 NOT BETWEEN 1 AND 3 OR $3 NOT IN('accepted_internal','revised_internal','rejected') OR length(btrim($4)) NOT BETWEEN 10 AND 1000 OR $8!~'^[A-Za-z0-9._:@+-]{3,254}$' OR $9!~'^draft-review:[A-Za-z0-9._:-]{8,114}$' OR $10!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'DRAFT_REVIEW_ITEM_INVALID'; END IF;
  IF $4~E'[\\x00-\\x1F\\x7F]' OR $4~*'(https?://|www\\.|@|```|\\||-----BEGIN [A-Z ]*PRIVATE KEY-----|\\m(sk|oc_sk)-[A-Za-z0-9_-]{16,}|\\mBearer[[:space:]]+[A-Za-z0-9._~-]{20,})' THEN RAISE EXCEPTION 'DRAFT_REVIEW_ITEM_INVALID'; END IF;
  IF $3='revised_internal' THEN
    IF length(btrim(coalesce($5,''))) NOT BETWEEN 10 AND 200 OR length(btrim(coalesce($6,''))) NOT BETWEEN 30 AND 2000 OR $5~E'[\\x00-\\x1F\\x7F]' OR $6~E'[\\x00-\\x1F\\x7F]' OR ($5||' '||$6)~*'(https?://|www\\.|@|```|\\||-----BEGIN [A-Z ]*PRIVATE KEY-----|\\m(sk|oc_sk)-[A-Za-z0-9_-]{16,}|\\mBearer[[:space:]]+[A-Za-z0-9._~-]{20,})' OR $6!~*'hipótesis' OR $6!~*'operación sin planillas' OR $6!~*'CLP 1\\.800\\.000' THEN RAISE EXCEPTION 'DRAFT_REVIEW_ITEM_INVALID'; END IF;
  ELSIF $5 IS NOT NULL OR $6 IS NOT NULL THEN RAISE EXCEPTION 'DRAFT_REVIEW_ITEM_INVALID';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM control.draft_review_sessions WHERE review_id=$1 AND status='open') THEN RAISE EXCEPTION 'DRAFT_REVIEW_NOT_OPEN'; END IF;
  SELECT version INTO current_version FROM control.draft_review_items WHERE review_id=$1 AND item_slot=$2 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DRAFT_REVIEW_ITEM_NOT_FOUND'; END IF;
  IF current_version<>$7 THEN RAISE EXCEPTION 'DRAFT_REVIEW_VERSION_CONFLICT'; END IF;
  UPDATE control.draft_review_items SET human_decision=$3,human_rationale=btrim($4),revised_subject=CASE WHEN $3='revised_internal' THEN btrim($5) ELSE NULL END,revised_body=CASE WHEN $3='revised_internal' THEN btrim($6) ELSE NULL END,approval_state=CASE WHEN $3='rejected' THEN 'not_applicable' ELSE 'internal_reviewed' END,external_action_eligible=false,reviewer_id=$8,version=version+1,updated_at=clock_timestamp() WHERE review_id=$1 AND item_slot=$2;
  UPDATE control.draft_review_sessions SET version=version+1,updated_at=clock_timestamp(),production_gate='blocked',external_actions=0 WHERE review_id=$1;
  result:=control.build_draft_review($1);
  INSERT INTO control.draft_review_commands(idempotency_key,review_id,command_type,request_sha256,result,actor_id) VALUES($9,$1,'record_item',$10,result,$8);
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object('event','draft_review_item_recorded','review_id',$1,'item_slot',$2,'decision',$3,'actor_id',$8,'request_sha256',$10,'external_action',false,'production_gate','blocked','recorded_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN result;
END
$$;

CREATE OR REPLACE FUNCTION control.complete_draft_review(uuid,integer,text,text,text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing control.draft_review_commands%ROWTYPE; current_version integer; completed_count integer; result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext($4));
  SELECT * INTO existing FROM control.draft_review_commands WHERE idempotency_key=$4;
  IF FOUND THEN
    IF existing.review_id<>$1 OR existing.command_type<>'complete_review' OR existing.request_sha256<>$5 OR existing.actor_id<>$3 THEN RAISE EXCEPTION 'DRAFT_REVIEW_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN existing.result;
  END IF;
  IF $3!~'^[A-Za-z0-9._:@+-]{3,254}$' OR $4!~'^draft-review:[A-Za-z0-9._:-]{8,114}$' OR $5!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'DRAFT_REVIEW_COMPLETION_INVALID'; END IF;
  SELECT version INTO current_version FROM control.draft_review_sessions WHERE review_id=$1 AND status='open' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DRAFT_REVIEW_NOT_OPEN'; END IF;
  IF current_version<>$2 THEN RAISE EXCEPTION 'DRAFT_REVIEW_VERSION_CONFLICT'; END IF;
  SELECT count(*) FILTER(WHERE human_decision IS NOT NULL) INTO completed_count FROM control.draft_review_items WHERE review_id=$1;
  IF completed_count<>3 THEN RAISE EXCEPTION 'DRAFT_REVIEW_INCOMPLETE'; END IF;
  UPDATE control.draft_review_sessions SET status='completed',version=version+1,internal_review_gate='complete',production_gate='blocked',external_actions=0,reviewer_id=$3,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE review_id=$1;
  result:=control.build_draft_review($1);
  INSERT INTO control.draft_review_commands(idempotency_key,review_id,command_type,request_sha256,result,actor_id) VALUES($4,$1,'complete_review',$5,result,$3);
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object('event','draft_review_completed','review_id',$1,'actor_id',$3,'completed_items',3,'external_action',false,'production_gate','blocked','recorded_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN result;
END
$$;

DO $$
DECLARE ala52_ok boolean; ala53_ok boolean;
BEGIN
  SELECT count(*)=2 AND bool_and(status='succeeded' AND usage_budget_state='settled' AND api_calls_used=1 AND coalesce((result_envelope#>>'{agent_result,metrics,external_actions}')::integer,-1)=0) AND
    count(*) FILTER(WHERE artifact_sha256='37bdaf503a815bd4acdcf3ffbc2fa424e013250be3ed37ce8cbe93fa11c71563')=1 AND
    count(*) FILTER(WHERE artifact_sha256='75b33e7b244059c776e6e8d05adbfa0cea9619496d2f5b50572d0aedd7076ddf')=1
  INTO ala52_ok FROM control.dispatch_jobs WHERE mission_id='6d08b421-69db-5c34-bdf7-601444f9e11b';
  SELECT count(*)=2 AND bool_and(status='succeeded' AND usage_budget_state='settled' AND api_calls_used=1 AND coalesce((result_envelope#>>'{agent_result,metrics,external_actions}')::integer,-1)=0) AND
    count(*) FILTER(WHERE artifact_sha256='04d6975de24153e541846ac1b575464ca4f799d8c82354f20fd705c155ad46ad')=1 AND
    count(*) FILTER(WHERE artifact_sha256='9761cd549ce4c344cf36fcfe800d4dd606dbaa4ca327139c17458a7614cee9c7')=1
  INTO ala53_ok FROM control.dispatch_jobs WHERE mission_id='5f45d649-5527-5bdb-82fc-dd3c2315582f';
  IF NOT EXISTS(SELECT 1 FROM control.missions WHERE mission_id IN('6d08b421-69db-5c34-bdf7-601444f9e11b','5f45d649-5527-5bdb-82fc-dd3c2315582f')) THEN
    RETURN;
  END IF;
  IF ala52_ok IS DISTINCT FROM true OR ala53_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ALA52_53_DRAFT_REVIEW_SOURCE_INVALID'; END IF;

  INSERT INTO control.draft_review_sessions(review_id,mission_id,predecessor_mission_id,project_id,offer_id,offer_version,title,source_artifact_sha256,qa_artifact_sha256,predecessor_artifact_sha256,predecessor_qa_artifact_sha256,expected_items,external_actions,status)
  VALUES('a2500000-0000-4500-8500-000000000053','5f45d649-5527-5bdb-82fc-dd3c2315582f','6d08b421-69db-5c34-bdf7-601444f9e11b','proptimiza','operacion-sin-planillas','v1','Revisión humana interna ALA-52/53 · 3 borradores','04d6975de24153e541846ac1b575464ca4f799d8c82354f20fd705c155ad46ad','9761cd549ce4c344cf36fcfe800d4dd606dbaa4ca327139c17458a7614cee9c7','37bdaf503a815bd4acdcf3ffbc2fa424e013250be3ed37ce8cbe93fa11c71563','75b33e7b244059c776e6e8d05adbfa0cea9619496d2f5b50572d0aedd7076ddf',3,0,'open');

  INSERT INTO control.draft_review_items(review_id,item_slot,company_name,source_url,evidence_basis,original_subject,original_body,source_draft_sha256,machine_decision,machine_reason,risk_flags) VALUES
  ('a2500000-0000-4500-8500-000000000053',1,'Axia Advisors','https://axiacontable.cl/','Chile-focused B2B provider of contable, tributario y laboral outsourcing per its public site; headcount and manual-operations evidence unknown; no conflicts; confidence 0.5 via public web.','Borrador interno: Operación Sin Planillas para Axia Advisors','Hipótesis: la gestión contable, tributaria y laboral podría aún apoyarse en planillas manuales; ante esa situación se explora la oferta Operación Sin Planillas desde CLP 1.800.000, sin promesas de resultado ni contacto.','5778f036a6d74077961ae47f409fac4fefef212382bff8199a78961f8063469a','human_review_candidate','No deterministic blocker detected; human review mandatory.','[]'),
  ('a2500000-0000-4500-8500-000000000053',2,'Asecotri','https://asecotri.cl/','Chilean B2B provider of accounting and tax services for SMEs, including tax, financial and payroll consultancy per its public site; headcount and manual-operations evidence unknown; no conflicts; confidence 0.5 via public web.','Borrador interno: Operación Sin Planillas para Asecotri','Hipótesis: la operación contable, tributaria, financiera y de remuneraciones podría aún apoyarse en planillas manuales; ante esa situación se explora la oferta Operación Sin Planillas desde CLP 1.800.000, sin promesas de resultado ni contacto.','80030b94599c99675065af45c0d3ac960a2e1b5a9c05d0f6b6e424a12eccfba3','human_review_candidate','No deterministic blocker detected; human review mandatory.','[]'),
  ('a2500000-0000-4500-8500-000000000053',3,'Prodata Servicios','https://www.prodataservicios.cl/','Chilean B2B provider of outsourcing of accounting, finance, business intelligence, payroll and operations, with over 20 years in the local market per its public site; headcount and manual-operations evidence unknown; no conflicts; confidence 0.5 via public web.','Borrador interno: Operación Sin Planillas para Prodata Servicios','Hipótesis: la operación contable, financiera, de business intelligence, de remuneraciones y de procesos podría aún apoyarse en planillas manuales; ante esa situación se explora la oferta Operación Sin Planillas desde CLP 1.800.000, sin promesas de resultado ni contacto.','fd820bb42c51306c7a248a558a3e2ee6bb3874cc8d8f15dc67759db199ae8a53','human_review_candidate','No deterministic blocker detected; human review mandatory.','[]');
  IF (SELECT count(*) FROM control.draft_review_items WHERE review_id='a2500000-0000-4500-8500-000000000053')<>3 THEN RAISE EXCEPTION 'ALA52_53_DRAFT_REVIEW_SEED_INVALID'; END IF;
END
$$;

REVOKE ALL ON control.draft_review_sessions,control.draft_review_items,control.draft_review_commands FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION control.build_draft_review(uuid),control.list_draft_reviews(),control.get_draft_review(uuid),control.record_draft_review_item(uuid,integer,text,text,text,text,integer,text,text,text),control.complete_draft_review(uuid,integer,text,text,text) FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.list_draft_reviews(),control.get_draft_review(uuid),control.record_draft_review_item(uuid,integer,text,text,text,text,integer,text,text,text),control.complete_draft_review(uuid,integer,text,text,text) TO commercial_runtime;

COMMIT;
