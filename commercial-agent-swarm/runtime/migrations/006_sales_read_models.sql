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
  'projects','[]'::jsonb,
  'missions','[]'::jsonb,
  'missionDrafts','[]'::jsonb,
  'approvals','[]'::jsonb,
  'qa','[]'::jsonb,
  'agents','[]'::jsonb,
  'experiments','[]'::jsonb,
  'costs','[]'::jsonb,
  'audit','[]'::jsonb,
  'control',jsonb_build_object(
    'killSwitch',EXISTS(
      SELECT 1 FROM control.kill_switches
      WHERE scope='global' AND scope_id='*' AND active
    )
  )
)
FROM observation
$$;

CREATE OR REPLACE FUNCTION integration.get_crm_summary() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
WITH snapshot AS (
  SELECT
    EXISTS(
      SELECT 1 FROM integration.sync_control
      WHERE control_id=1 AND enabled
    ) AS enabled,
    to_char(statement_timestamp() AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
), counts AS (
  SELECT
    count(DISTINCT remote_record_id) FILTER (WHERE record_type='account') AS accounts,
    count(DISTINCT remote_record_id) FILTER (WHERE record_type='contact') AS contacts,
    count(DISTINCT remote_record_id) FILTER (WHERE record_type='opportunity') AS opportunities
  FROM integration.crm_inbox
  WHERE connector_id='twenty'
)
SELECT jsonb_build_object(
  'availability',CASE WHEN snapshot.enabled THEN 'available' ELSE 'unavailable' END,
  'accounts',CASE WHEN snapshot.enabled THEN counts.accounts ELSE NULL END,
  'contacts',CASE WHEN snapshot.enabled THEN counts.contacts ELSE NULL END,
  'opportunities',CASE WHEN snapshot.enabled THEN counts.opportunities ELSE NULL END,
  'pipelineUsd',NULL,
  'provenance',jsonb_build_object(
    'source','twenty',
    'sourceId','crm-summary:postgres',
    'observedAt',snapshot.observed_at,
    'synthetic',false
  )
) || CASE WHEN snapshot.enabled
          THEN '{}'::jsonb
          ELSE jsonb_build_object('message','CRM sync disabled')
     END
FROM snapshot CROSS JOIN counts
$$;

REVOKE ALL ON FUNCTION control.get_portfolio_read_model() FROM
  PUBLIC,commercial_runtime,commercial_crm_sync,commercial_observer;
REVOKE ALL ON FUNCTION integration.get_crm_summary() FROM
  PUBLIC,commercial_runtime,commercial_crm_sync,commercial_observer;
GRANT EXECUTE ON FUNCTION control.get_portfolio_read_model() TO commercial_runtime;
GRANT EXECUTE ON FUNCTION integration.get_crm_summary() TO commercial_crm_sync;

COMMIT;
