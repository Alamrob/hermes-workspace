BEGIN;

DO $$
BEGIN
  IF to_regclass('control.schema_migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM control.schema_migrations WHERE version=$1'
      USING '008_simulation_safety_seed';
  END IF;
END $$;

-- The safety row is intentionally retained. Rollback must never disable or
-- remove an operator-selected global kill-switch state.
COMMIT;
