BEGIN;

CREATE TABLE IF NOT EXISTS control.instruction_requests (
  request_id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  project_id text NOT NULL REFERENCES catalog.projects(project_id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160 AND title !~ '[[:cntrl:]]'),
  instruction text NOT NULL CHECK (length(instruction) BETWEEN 1 AND 8000),
  instruction_sha256 text NOT NULL CHECK (instruction_sha256 ~ '^[a-f0-9]{64}$'),
  requested_by text NOT NULL CHECK (requested_by ~ '^[A-Za-z0-9._:@+-]{3,254}$'),
  source text NOT NULL CHECK (source IN ('workspace','sales')),
  status text NOT NULL DEFAULT 'pending_codex_review'
    CHECK (status IN ('pending_codex_review','approved','rejected','converted')),
  autonomy_ceiling text NOT NULL CHECK (autonomy_ceiling IN ('A0','A1','A2')),
  requires_codex_review boolean NOT NULL CHECK (requires_codex_review),
  external_actions_allowed boolean NOT NULL CHECK (NOT external_actions_allowed),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days')
);

CREATE INDEX IF NOT EXISTS instruction_requests_status_created_idx
  ON control.instruction_requests(status,created_at DESC);

CREATE OR REPLACE FUNCTION control.create_instruction_request(
  uuid,text,text,text,text,text,text,text,text,timestamptz,timestamptz,jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control,catalog AS $$
DECLARE existing control.instruction_requests%ROWTYPE; inserted boolean:=false;
BEGIN
  IF $3<>'proptimiza' OR NOT EXISTS(
    SELECT 1 FROM catalog.project_inventory
    WHERE project_id=$3 AND activatable
  ) THEN RAISE EXCEPTION 'INSTRUCTION_PROJECT_NOT_ACTIVATABLE'; END IF;
  IF length($2) NOT BETWEEN 8 AND 128 OR $2!~'^[A-Za-z0-9._:-]+$'
     OR length($4) NOT BETWEEN 1 AND 160 OR $4~'[[:cntrl:]]'
     OR length($5) NOT BETWEEN 1 AND 8000
     OR $6!~'^[a-f0-9]{64}$'
     OR $7!~'^[A-Za-z0-9._:@+-]{3,254}$'
     OR $8 NOT IN('workspace','sales')
     OR $9 NOT IN('A0','A1','A2')
     OR $10>clock_timestamp()+interval '5 minutes'
     OR $10<clock_timestamp()-interval '24 hours'
     OR $11<=$10 OR $11>$10+interval '30 days'
     OR jsonb_typeof($12)<>'object'
  THEN RAISE EXCEPTION 'INSTRUCTION_REQUEST_INVALID'; END IF;

  INSERT INTO control.instruction_requests(
    request_id,idempotency_key,project_id,title,instruction,instruction_sha256,
    requested_by,source,autonomy_ceiling,requires_codex_review,
    external_actions_allowed,created_at,expires_at,metadata
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,false,$10,$11,$12)
  ON CONFLICT(idempotency_key) DO NOTHING;
  inserted:=FOUND;

  SELECT * INTO existing FROM control.instruction_requests
  WHERE idempotency_key=$2 FOR UPDATE;
  IF existing.request_id<>$1 OR existing.project_id<>$3 OR existing.title<>$4
     OR existing.instruction_sha256<>$6 OR existing.requested_by<>$7
     OR existing.source<>$8 OR existing.autonomy_ceiling<>$9
  THEN RAISE EXCEPTION 'INSTRUCTION_IDEMPOTENCY_CONFLICT'; END IF;

  RETURN jsonb_build_object(
    'request_id',existing.request_id,
    'project_id',existing.project_id,
    'title',existing.title,
    'status',existing.status,
    'autonomy_ceiling',existing.autonomy_ceiling,
    'requires_codex_review',existing.requires_codex_review,
    'external_actions_allowed',existing.external_actions_allowed,
    'created_at',existing.created_at,
    'expires_at',existing.expires_at,
    'created',inserted
  );
END$$;

CREATE OR REPLACE FUNCTION control.get_portfolio_read_model() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
WITH observation AS (
  SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
)
SELECT jsonb_build_object(
  'portfolio',(
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',i.project_id,'name',p.display_name,'stage','paused',
      'activatable',i.activatable,'health','unknown','metric',NULL,
      'metricStatus','unknown','provenance',jsonb_build_object(
        'source','control-broker','sourceId','inventory:' || i.project_id,
        'observedAt',observation.observed_at,'synthetic',false
      )) ORDER BY p.display_name),'[]'::jsonb)
    FROM catalog.project_inventory i JOIN catalog.projects p USING(project_id)
  ),
  'projects','[]'::jsonb,
  'missions','[]'::jsonb,
  'missionDrafts',(
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',request_id,'projectId',project_id,'portfolioId',project_id,
      'title',title,
      'status',CASE WHEN status='pending_codex_review' THEN 'submitted' ELSE 'draft' END,
      'provenance',jsonb_build_object(
        'source','control-broker','sourceId','instruction:' || request_id,
        'observedAt',observation.observed_at,'synthetic',false
      )) ORDER BY created_at,request_id),'[]'::jsonb)
    FROM control.instruction_requests
    WHERE status IN('pending_codex_review','approved') AND expires_at>statement_timestamp()
  ),
  'approvals','[]'::jsonb,'qa','[]'::jsonb,'agents','[]'::jsonb,
  'experiments','[]'::jsonb,'costs','[]'::jsonb,'audit','[]'::jsonb,
  'control',jsonb_build_object('killSwitch',EXISTS(
    SELECT 1 FROM control.kill_switches
    WHERE scope='global' AND scope_id='*' AND active
  ))
)
FROM observation
$$;

REVOKE ALL ON control.instruction_requests FROM PUBLIC,commercial_runtime,
  commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,
  commercial_observer,commercial_approval_evidence;
REVOKE ALL ON FUNCTION control.create_instruction_request(
  uuid,text,text,text,text,text,text,text,text,timestamptz,timestamptz,jsonb
) FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,
  commercial_approver,commercial_safety_operator,commercial_observer,
  commercial_approval_evidence;
GRANT EXECUTE ON FUNCTION control.create_instruction_request(
  uuid,text,text,text,text,text,text,text,text,timestamptz,timestamptz,jsonb
) TO commercial_work_order_ingestor;

REVOKE ALL ON FUNCTION control.get_portfolio_read_model() FROM PUBLIC,
  commercial_runtime,commercial_crm_sync,commercial_observer;
GRANT EXECUTE ON FUNCTION control.get_portfolio_read_model() TO commercial_runtime;

COMMIT;
