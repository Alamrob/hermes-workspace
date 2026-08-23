BEGIN;

CREATE OR REPLACE FUNCTION control.terminalize_failed_dispatch_dependencies()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE
  batch_count integer;
  total_count integer := 0;
  now_at timestamptz := clock_timestamp();
BEGIN
  LOOP
    WITH terminalized AS (
      UPDATE control.dispatch_jobs child
      SET status='failed',
          error='DEPENDENCY_TERMINAL_NON_SUCCESS',
          usage_budget_state='released',
          usage_value_consumed_usd=0,
          updated_at=now_at
      FROM control.dispatch_dependencies dependency
      JOIN control.dispatch_jobs parent
        ON parent.job_id=dependency.depends_on_job_id
      WHERE child.job_id=dependency.job_id
        AND child.status='queued'
        AND child.usage_budget_state IN('unreserved','released')
        AND parent.status IN('failed','budget_exceeded')
      RETURNING child.job_id
    )
    INSERT INTO control.dispatch_events(
      job_id,from_status,to_status,reason,occurred_at
    )
    SELECT job_id,'queued','failed','DEPENDENCY_TERMINAL_NON_SUCCESS',now_at
    FROM terminalized;

    GET DIAGNOSTICS batch_count = ROW_COUNT;
    total_count := total_count + batch_count;
    EXIT WHEN batch_count = 0;
  END LOOP;
  RETURN total_count;
END$$;

REVOKE ALL ON FUNCTION control.terminalize_failed_dispatch_dependencies()
FROM PUBLIC,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.terminalize_failed_dispatch_dependencies()
TO commercial_runtime;

COMMIT;
