BEGIN;

ALTER TABLE control.instruction_requests
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_reason text,
  ADD COLUMN IF NOT EXISTS review_idempotency_key text,
  ADD COLUMN IF NOT EXISTS review_request_sha256 text,
  ADD COLUMN IF NOT EXISTS converted_mission_id uuid REFERENCES control.missions(mission_id) ON DELETE RESTRICT;

ALTER TABLE control.instruction_requests
  DROP CONSTRAINT IF EXISTS instruction_review_state_ck;
ALTER TABLE control.instruction_requests
  ADD CONSTRAINT instruction_review_state_ck CHECK (
    (status='pending_codex_review' AND reviewed_by IS NULL AND reviewed_at IS NULL
      AND review_reason IS NULL AND review_idempotency_key IS NULL
      AND review_request_sha256 IS NULL AND converted_mission_id IS NULL)
    OR
    (status IN('approved','rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_reason IS NOT NULL AND review_idempotency_key IS NOT NULL
      AND review_request_sha256 IS NOT NULL AND converted_mission_id IS NULL)
    OR
    (status='converted' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_reason IS NOT NULL AND review_idempotency_key IS NOT NULL
      AND review_request_sha256 IS NOT NULL AND converted_mission_id IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS instruction_review_idempotency_uq
  ON control.instruction_requests(review_idempotency_key)
  WHERE review_idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION control.list_instruction_requests() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'request_id',request_id,
  'idempotency_key',idempotency_key,
  'project_id',project_id,
  'title',title,
  'instruction',instruction,
  'instruction_sha256',instruction_sha256,
  'requested_by',requested_by,
  'source',source,
  'status',status,
  'autonomy_ceiling',autonomy_ceiling,
  'requires_codex_review',requires_codex_review,
  'external_actions_allowed',external_actions_allowed,
  'created_at',created_at,
  'expires_at',expires_at,
  'metadata',metadata,
  'reviewed_by',reviewed_by,
  'reviewed_at',reviewed_at,
  'review_reason',review_reason,
  'converted_mission_id',converted_mission_id
) ORDER BY created_at,request_id),'[]'::jsonb)
FROM (
  SELECT * FROM control.instruction_requests
  ORDER BY created_at DESC,request_id DESC
  LIMIT 100
) AS bounded
$$;

CREATE OR REPLACE FUNCTION control.get_instruction_request(uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT jsonb_build_object(
  'request_id',request_id,
  'idempotency_key',idempotency_key,
  'project_id',project_id,
  'title',title,
  'instruction',instruction,
  'instruction_sha256',instruction_sha256,
  'requested_by',requested_by,
  'source',source,
  'status',status,
  'autonomy_ceiling',autonomy_ceiling,
  'requires_codex_review',requires_codex_review,
  'external_actions_allowed',external_actions_allowed,
  'created_at',created_at,
  'expires_at',expires_at,
  'metadata',metadata,
  'reviewed_by',reviewed_by,
  'reviewed_at',reviewed_at,
  'review_reason',review_reason,
  'converted_mission_id',converted_mission_id
)
FROM control.instruction_requests WHERE request_id=$1
$$;

CREATE OR REPLACE FUNCTION control.review_instruction_request(
  uuid,text,text,text,timestamptz,text,text,text,uuid,text,jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE
  existing control.instruction_requests%ROWTYPE;
  mission_existing control.missions%ROWTYPE;
  replayed boolean:=false;
  target_status text;
  mission_payload jsonb:=$11;
BEGIN
  SELECT * INTO existing FROM control.instruction_requests
  WHERE request_id=$1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSTRUCTION_REQUEST_NOT_FOUND'; END IF;

  IF $2 NOT IN('reject','convert') OR $3<>'codex-auditor'
     OR length(btrim($4)) NOT BETWEEN 10 AND 1000
     OR $5<clock_timestamp()-interval '5 minutes'
     OR $5>clock_timestamp()+interval '5 minutes'
     OR $6!~'^codex-review:[A-Za-z0-9._:-]{8,180}$'
     OR $7!~'^[a-f0-9]{64}$' OR $8!~'^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'INSTRUCTION_REVIEW_INVALID'; END IF;

  IF existing.status<>'pending_codex_review' THEN
    IF existing.review_idempotency_key=$6 AND existing.review_request_sha256=$8
       AND existing.reviewed_by=$3
    THEN replayed:=true;
    ELSE RAISE EXCEPTION 'INSTRUCTION_REVIEW_CONFLICT';
    END IF;
  ELSE
    IF existing.instruction_sha256<>$7 THEN
      RAISE EXCEPTION 'INSTRUCTION_REVIEW_CONFLICT';
    END IF;
    IF existing.expires_at<=$5 THEN RAISE EXCEPTION 'INSTRUCTION_REQUEST_EXPIRED'; END IF;

    IF $2='reject' THEN
      IF $9 IS NOT NULL OR $10 IS NOT NULL OR $11 IS NOT NULL THEN
        RAISE EXCEPTION 'INSTRUCTION_REVIEW_INVALID';
      END IF;
      target_status:='rejected';
    ELSE
      IF $9 IS NULL OR $10 IS NULL OR jsonb_typeof(mission_payload)<>'object'
         OR mission_payload->>'mission_id'<>$9::text
         OR mission_payload->>'idempotency_key'<>$10
         OR mission_payload->>'project_id'<>existing.project_id
         OR mission_payload->>'offer_id'<>'operacion-sin-planillas'
         OR mission_payload->>'requested_by'<>'codex-auditor'
         OR mission_payload->'dry_run'<>'true'::jsonb
         OR mission_payload->'a3_enabled'<>'false'::jsonb
         OR NOT (mission_payload ? 'approval_token')
         OR mission_payload->'approval_token'<>'null'::jsonb
         OR mission_payload#>'{contact_policy,contact_permitted}'<>'false'::jsonb
         OR mission_payload#>'{volume_limits,maximum_external_actions}'<>'0'::jsonb
         OR mission_payload#>'{volume_limits,maximum_contacts}'<>'0'::jsonb
         OR jsonb_typeof(mission_payload#>'{volume_limits,maximum_accounts}')<>'number'
         OR coalesce((mission_payload#>>'{volume_limits,maximum_accounts}')::int,11)>10
         OR mission_payload#>>'{budget_limit,currency}'<>'USD'
         OR jsonb_typeof(mission_payload#>'{budget_limit,maximum}')<>'number'
         OR coalesce((mission_payload#>>'{budget_limit,maximum}')::numeric,0)>0.5
         OR mission_payload#>>'{metadata,instruction_request_id}'<>existing.request_id::text
         OR mission_payload#>>'{metadata,instruction_sha256}'<>existing.instruction_sha256
         OR (mission_payload->>'expires_at')::timestamptz>existing.expires_at
         OR mission_payload->>'autonomy_level' NOT IN('A0','A1','A2')
         OR (CASE mission_payload->>'autonomy_level' WHEN 'A0' THEN 0 WHEN 'A1' THEN 1 ELSE 2 END)
            > (CASE existing.autonomy_ceiling WHEN 'A0' THEN 0 WHEN 'A1' THEN 1 ELSE 2 END)
         OR jsonb_typeof(mission_payload->'approved_channels')<>'array'
         OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(mission_payload->'approved_channels')='array'
                   THEN mission_payload->'approved_channels' ELSE '[]'::jsonb END
            ) AS item(value) WHERE value NOT IN('none','internal','public_web'))
         OR jsonb_typeof(mission_payload->'allowed_actions')<>'array'
         OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(mission_payload->'allowed_actions')='array'
                   THEN mission_payload->'allowed_actions' ELSE '[]'::jsonb END
            ) AS item(value) WHERE value NOT IN('analysis.internal','research.public.read','artifact.prepare'))
         OR jsonb_typeof(mission_payload->'approved_tools')<>'array'
         OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(mission_payload->'approved_tools')='array'
                   THEN mission_payload->'approved_tools' ELSE '[]'::jsonb END
            ) AS item(value) WHERE value NOT IN('hermes.analysis','hermes.web','hermes.file.ephemeral'))
         OR jsonb_typeof(mission_payload->'prohibited_actions')<>'array'
         OR NOT (mission_payload->'prohibited_actions' ?& ARRAY[
           'mail.send','message.send','campaign.activate','crm.write',
           'price.change','proposal.send','contract.commit'
         ])
      THEN RAISE EXCEPTION 'INSTRUCTION_REVIEW_INVALID'; END IF;

      INSERT INTO control.missions(mission_id,idempotency_key,payload)
      VALUES($9,$10,mission_payload)
      ON CONFLICT(idempotency_key) DO NOTHING;
      SELECT * INTO mission_existing FROM control.missions
      WHERE idempotency_key=$10 FOR UPDATE;
      IF mission_existing.mission_id<>$9 OR mission_existing.payload<>mission_payload THEN
        RAISE EXCEPTION 'INSTRUCTION_REVIEW_CONFLICT';
      END IF;
      target_status:='converted';
    END IF;

    UPDATE control.instruction_requests SET
      status=target_status,reviewed_by=$3,reviewed_at=$5,review_reason=btrim($4),
      review_idempotency_key=$6,review_request_sha256=$8,
      converted_mission_id=CASE WHEN target_status='converted' THEN $9 ELSE NULL END,
      updated_at=clock_timestamp()
    WHERE request_id=$1;

    INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
      'event_type','instruction_request_reviewed',
      'request_id',$1,
      'decision',$2,
      'actor_id',$3,
      'review_request_sha256',$8,
      'mission_id',CASE WHEN target_status='converted' THEN $9 ELSE NULL END,
      'external_actions',0
    ));
  END IF;

  SELECT * INTO existing FROM control.instruction_requests WHERE request_id=$1;
  RETURN jsonb_build_object(
    'request_id',existing.request_id,
    'status',existing.status,
    'reviewed_by',existing.reviewed_by,
    'reviewed_at',existing.reviewed_at,
    'review_reason',existing.review_reason,
    'converted_mission_id',existing.converted_mission_id,
    'replayed',replayed,
    'external_actions_allowed',false
  );
END$$;

REVOKE ALL ON FUNCTION control.list_instruction_requests() FROM PUBLIC,
  commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_approval_evidence;
REVOKE ALL ON FUNCTION control.get_instruction_request(uuid) FROM PUBLIC,
  commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_approval_evidence;
REVOKE ALL ON FUNCTION control.review_instruction_request(
  uuid,text,text,text,timestamptz,text,text,text,uuid,text,jsonb
) FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_approval_evidence;
GRANT EXECUTE ON FUNCTION control.list_instruction_requests(),
  control.get_instruction_request(uuid),
  control.review_instruction_request(uuid,text,text,text,timestamptz,text,text,text,uuid,text,jsonb)
  TO commercial_work_order_ingestor;

COMMIT;
