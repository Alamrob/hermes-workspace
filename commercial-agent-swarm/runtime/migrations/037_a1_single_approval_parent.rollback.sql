BEGIN;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM control.a1_single_approval_parent_consumptions)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control WHERE claiming_enabled)
    OR NOT control.is_global_kill_switch_active()
    OR NOT control.external_actions_blocked()
  THEN RAISE EXCEPTION 'A1_SINGLE_APPROVAL_ROLLBACK_REQUIRES_EMPTY_CONTAINED_LEDGER'; END IF;
END $$;

REVOKE ALL ON FUNCTION control.consume_a1_single_approval_parent(jsonb),
  control.get_a1_single_approval_chain_state(uuid),control.recontain_a1_single_approval_chain(uuid,text)
  FROM commercial_a1_chain_runner;
DROP FUNCTION control.consume_a1_single_approval_parent(jsonb),
  control.get_a1_single_approval_chain_state(uuid),control.recontain_a1_single_approval_chain(uuid,text);
DROP TRIGGER a1_single_approval_parent_immutable ON control.a1_single_approval_parent_consumptions;
DROP TABLE control.a1_single_approval_parent_consumptions;
REVOKE USAGE ON SCHEMA control FROM commercial_a1_chain_runner;
DELETE FROM control.schema_migrations WHERE version='037_a1_single_approval_parent';

COMMIT;
