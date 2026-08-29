BEGIN;

DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM control.missions
    WHERE payload->'authority'->>'algorithm'='Ed25519'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_ED25519_MISSIONS_EXIST';
  END IF;
END$$;

CREATE OR REPLACE FUNCTION control.save_mission(uuid,text,jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$DECLARE required text[]:=ARRAY['mission_id','trace_id','created_at','expires_at','project_id','project_version','offer_id','offer_version','icp_version','policy_version','objective','business_context','target_segment','allowed_actions','prohibited_actions','approved_channels','approved_tools','autonomy_level','budget_limit','volume_limits','success_criteria','stop_conditions','required_evidence','approval_token','idempotency_key','requested_by','authority','data_policy','contact_policy','dry_run','a3_enabled'];allowed text[]:=required||ARRAY['metadata'];BEGIN
IF $3 IS NULL OR jsonb_typeof($3)<>'object' OR NOT($3?&required) OR EXISTS(SELECT 1 FROM jsonb_object_keys($3)k WHERE NOT(k=ANY(allowed)))THEN RAISE EXCEPTION'INVALID_WORK_ORDER_SHAPE';END IF;
IF $3->>'mission_id'<>$1::text OR $3->>'idempotency_key'<>$2 OR length($2)NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION'WORK_ORDER_IDENTITY_MISMATCH';END IF;
IF ($3->>'trace_id')::uuid IS NULL OR ($3->>'created_at')::timestamptz>=($3->>'expires_at')::timestamptz THEN RAISE EXCEPTION'INVALID_WORK_ORDER_TIME';END IF;
IF $3->>'autonomy_level' NOT IN('A0','A1','A2','A3','A4') OR jsonb_typeof($3->'dry_run')<>'boolean' OR jsonb_typeof($3->'a3_enabled')<>'boolean' OR (($3->>'a3_enabled')::boolean<>($3->>'autonomy_level'='A3'))THEN RAISE EXCEPTION'INVALID_WORK_ORDER_AUTHORITY';END IF;
IF jsonb_typeof($3->'authority')<>'object' OR NOT(($3->'authority')?&ARRAY['issuer','audience','key_id','algorithm','signature']) OR EXISTS(SELECT 1 FROM jsonb_object_keys($3->'authority')k WHERE NOT(k=ANY(ARRAY['issuer','audience','key_id','algorithm','signature']))) OR ($3->'authority'->>'algorithm')<>'HMAC-SHA256' OR ($3->'authority'->>'signature')!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION'INVALID_WORK_ORDER_SIGNATURE_METADATA';END IF;
IF jsonb_typeof($3->'budget_limit')<>'object' OR ($3->'budget_limit'->>'currency')!~'^[A-Z]{3}$' OR jsonb_typeof($3->'budget_limit'->'maximum')<>'number' OR ($3->'budget_limit'->>'maximum')::numeric<0 THEN RAISE EXCEPTION'INVALID_WORK_ORDER_BUDGET';END IF;
IF EXISTS(SELECT 1 FROM unnest(ARRAY['allowed_actions','prohibited_actions','approved_channels','approved_tools','success_criteria','stop_conditions','required_evidence'])n WHERE jsonb_typeof($3->n)<>'array') OR jsonb_typeof($3->'volume_limits')<>'object' OR jsonb_typeof($3->'data_policy')<>'object' OR jsonb_typeof($3->'contact_policy')<>'object' THEN RAISE EXCEPTION'INVALID_WORK_ORDER_POLICY';END IF;
IF NOT catalog.mission_versions_exist($3->>'project_id',$3->>'project_version',$3->>'offer_id',$3->>'offer_version',$3->>'icp_version',$3->>'policy_version')THEN RAISE EXCEPTION 'UNKNOWN_CATALOG_VERSION';END IF;INSERT INTO control.missions(mission_id,idempotency_key,payload)VALUES($1,$2,$3)ON CONFLICT DO NOTHING;IF FOUND THEN RETURN'inserted';END IF;IF EXISTS(SELECT 1 FROM control.missions WHERE(mission_id=$1 OR idempotency_key=$2)AND payload=$3)THEN RETURN'existing';END IF;RAISE EXCEPTION'MISSION_CONFLICT';END$$;

REVOKE ALL ON FUNCTION control.save_mission(uuid,text,jsonb)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.save_mission(uuid,text,jsonb) TO commercial_work_order_ingestor;

COMMIT;
