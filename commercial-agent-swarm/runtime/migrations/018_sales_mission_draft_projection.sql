BEGIN;

CREATE OR REPLACE FUNCTION control.get_portfolio_read_model() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
WITH observation AS (
  SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
)
SELECT jsonb_build_object(
  'portfolio',(
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',i.project_id,
      'name',p.display_name,
      'stage','paused',
      'activatable',i.activatable,
      'health','unknown',
      'metric',NULL,
      'metricStatus','unknown',
      'provenance',jsonb_build_object(
        'source','control-broker',
        'sourceId','inventory:' || i.project_id,
        'observedAt',observation.observed_at,
        'synthetic',false
      )
    ) ORDER BY p.display_name),'[]'::jsonb)
    FROM catalog.project_inventory i
    JOIN catalog.projects p USING(project_id)
  ),
  'projects',(
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',o.offer_id,
      'portfolioId',a.project_id,
      'name',o.name,
      'offer',o.description,
      'icp',i.description,
      'priceClpFrom',o.starting_price,
      'stage','validation',
      'provenance',jsonb_build_object(
        'source','control-broker',
        'sourceId','catalog:' || a.project_id || ':' || o.offer_id || ':' || o.version || ':' || i.version,
        'observedAt',observation.observed_at,
        'synthetic',false
      )
    ) ORDER BY a.project_id,o.offer_id),'[]'::jsonb)
    FROM catalog.current_version_activation a
    JOIN catalog.offer_versions o
      ON o.project_id=a.project_id AND o.offer_id=a.offer_id
     AND o.version=a.offer_version AND o.project_version=a.project_version
    JOIN catalog.icp_versions i
      ON i.project_id=a.project_id AND i.version=a.icp_version
     AND i.project_version=a.project_version
    WHERE a.project_id='proptimiza'
  ),
  'missions','[]'::jsonb,
  'missionDrafts',(
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',request_id,
      'projectId',coalesce(metadata->>'offer_id',project_id),
      'portfolioId',project_id,
      'title',title,
      'status',CASE WHEN status='pending_codex_review' THEN 'submitted' ELSE 'draft' END,
      'provenance',jsonb_build_object(
        'source','control-broker','sourceId','instruction:' || request_id,
        'observedAt',observation.observed_at,'synthetic',false
      )) ORDER BY created_at,request_id),'[]'::jsonb)
    FROM control.instruction_requests
    WHERE source='sales'
      AND project_id='proptimiza'
      AND metadata->>'offer_id'='operacion-sin-planillas'
      AND status IN('pending_codex_review','approved')
      AND expires_at>statement_timestamp()
  ),
  'approvals','[]'::jsonb,'qa','[]'::jsonb,'agents','[]'::jsonb,
  'experiments','[]'::jsonb,'costs','[]'::jsonb,'audit','[]'::jsonb,
  'control',jsonb_build_object(
    'killSwitch',control.external_actions_blocked()
  )
)
FROM observation
$$;

REVOKE ALL ON FUNCTION control.get_portfolio_read_model() FROM PUBLIC,
  commercial_runtime,commercial_crm_sync,commercial_observer;
GRANT EXECUTE ON FUNCTION control.get_portfolio_read_model() TO commercial_runtime;

COMMIT;
