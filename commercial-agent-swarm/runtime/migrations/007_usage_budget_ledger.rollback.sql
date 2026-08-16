BEGIN;
REVOKE EXECUTE ON FUNCTION
  control.recover_dispatch_leases(),control.claim_dispatch(text,integer,integer),
  control.fail_dispatch(uuid,text,text,boolean,text,bigint),
  control.complete_dispatch(uuid,text,jsonb,text,bigint,text,bigint,bigint,integer)
FROM commercial_runtime;
DO $$
BEGIN
  IF to_regclass('control.schema_migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM control.schema_migrations WHERE version=$1'
      USING '007_usage_budget_ledger';
  END IF;
END $$;
-- Budget state, confirmed Usage IDs, holds and functions remain for audit and reactivation.
COMMIT;
