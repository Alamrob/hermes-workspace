BEGIN;

INSERT INTO control.kill_switches(scope,scope_id,active)
VALUES
  ('channel','email',true),
  ('channel','whatsapp',true),
  ('channel','calendar',true),
  ('channel','web_chat',true),
  ('channel','telephone',true),
  ('channel','crm',true),
  ('channel','public_web',true)
ON CONFLICT(scope,scope_id) DO NOTHING;

CREATE OR REPLACE FUNCTION control.external_actions_blocked()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS(
    SELECT 1
    FROM unnest(ARRAY['email','whatsapp','calendar','web_chat','telephone','crm','public_web']) channel
    WHERE NOT control.is_kill_switch_active('*',channel)
  )
$$;

CREATE OR REPLACE FUNCTION control.get_mission_execution(uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,control AS $$
  SELECT jsonb_build_object(
    'mission_id',$1,
    'status',CASE
      WHEN count(*)=0 THEN 'completed'
      WHEN bool_or(status IN('usage_unknown','budget_exceeded')) THEN 'blocked'
      WHEN bool_or(status='failed') THEN 'failed'
      WHEN bool_or(status='leased') THEN 'running'
      WHEN bool_or(status='queued') THEN 'queued'
      ELSE 'completed'
    END,
    'assignments',coalesce(jsonb_agg(jsonb_build_object(
      'assignment_id',job_id,
      'profile_id',profile_id,
      'status',status,
      'attempts',attempts,
      'max_attempts',max_attempts,
      'artifact_sha256',artifact_sha256,
      'result_envelope',result_envelope,
      'error',error
    ) ORDER BY created_at,job_id),'[]'::jsonb)
  )
  FROM control.dispatch_jobs
  WHERE mission_id=$1
$$;

CREATE OR REPLACE FUNCTION control.get_dispatch_dependency_evidence(uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,control AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'assignment_id',parent.job_id,
    'profile_id',parent.profile_id,
    'artifact_sha256',parent.artifact_sha256,
    'result_envelope',parent.result_envelope
  ) ORDER BY parent.created_at,parent.job_id),'[]'::jsonb)
  FROM control.dispatch_dependencies dependency
  JOIN control.dispatch_jobs parent ON parent.job_id=dependency.depends_on_job_id
  WHERE dependency.job_id=$1
$$;

REVOKE ALL ON FUNCTION control.external_actions_blocked(),control.get_mission_execution(uuid),control.get_dispatch_dependency_evidence(uuid)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.external_actions_blocked(),control.get_mission_execution(uuid),control.get_dispatch_dependency_evidence(uuid)
TO commercial_runtime;

COMMIT;
