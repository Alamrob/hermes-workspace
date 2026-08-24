BEGIN;
REVOKE EXECUTE ON FUNCTION control.get_portfolio_read_model() FROM commercial_runtime;
REVOKE EXECUTE ON FUNCTION integration.get_crm_summary() FROM commercial_crm_sync;
REVOKE ALL ON catalog.project_inventory FROM commercial_runtime,commercial_crm_sync,commercial_observer,PUBLIC;
DO $$
BEGIN
  IF to_regclass('control.schema_migrations') IS NOT NULL THEN
    DELETE FROM control.schema_migrations
    WHERE version IN ('005_portfolio_read_models', '006_sales_read_models');
  END IF;
END $$;
-- Data, functions, and catalog rows are intentionally retained for auditability.
COMMIT;
