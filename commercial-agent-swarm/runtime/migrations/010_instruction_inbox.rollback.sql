BEGIN;

REVOKE ALL ON FUNCTION control.create_instruction_request(
  uuid,text,text,text,text,text,text,text,text,timestamptz,timestamptz,jsonb
) FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,
  commercial_approver,commercial_safety_operator,commercial_observer,
  commercial_approval_evidence;
DROP FUNCTION IF EXISTS control.create_instruction_request(
  uuid,text,text,text,text,text,text,text,text,timestamptz,timestamptz,jsonb
);
DROP TABLE IF EXISTS control.instruction_requests;

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
  'projects','[]'::jsonb,'missions','[]'::jsonb,'missionDrafts','[]'::jsonb,
  'approvals','[]'::jsonb,'qa','[]'::jsonb,'agents','[]'::jsonb,
  'experiments','[]'::jsonb,'costs','[]'::jsonb,'audit','[]'::jsonb,
  'control',jsonb_build_object('killSwitch',EXISTS(
    SELECT 1 FROM control.kill_switches
    WHERE scope='global' AND scope_id='*' AND active
  ))
)
FROM observation
$$;

REVOKE ALL ON FUNCTION control.get_portfolio_read_model() FROM PUBLIC,
  commercial_runtime,commercial_crm_sync,commercial_observer;
GRANT EXECUTE ON FUNCTION control.get_portfolio_read_model() TO commercial_runtime;

COMMIT;
