BEGIN;

REVOKE ALL ON FUNCTION
  control.complete_dispatch(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer;
DROP FUNCTION IF EXISTS
  control.complete_dispatch(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer);

GRANT EXECUTE ON FUNCTION
  control.complete_dispatch(uuid,text,jsonb,text,bigint,text,bigint,bigint,integer)
TO commercial_runtime;

-- Preserve the expanded source constraint so already-recorded native telemetry
-- remains truthful and queryable after an application rollback. Migration 007's
-- nine-argument function remains available to the previous runtime.

COMMIT;
