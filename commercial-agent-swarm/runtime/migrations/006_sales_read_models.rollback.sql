BEGIN;
REVOKE EXECUTE ON FUNCTION control.get_portfolio_read_model() FROM commercial_runtime;
REVOKE EXECUTE ON FUNCTION integration.get_crm_summary() FROM commercial_crm_sync;
DO $$
BEGIN
  IF to_regclass('control.schema_migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM control.schema_migrations WHERE version=$1'
      USING '006_sales_read_models';
  END IF;
END $$;
-- Projection functions and authoritative data are retained; rerunning 006 restores grants.
COMMIT;
