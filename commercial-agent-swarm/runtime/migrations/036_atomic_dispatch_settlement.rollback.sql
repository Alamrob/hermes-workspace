BEGIN;
DO $$ DECLARE f record;c record; BEGIN
 PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
 IF NOT control.is_global_kill_switch_active() OR NOT control.external_actions_blocked()
 OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
 OR EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE status='leased' OR usage_budget_state='held_uncertain')
 THEN RAISE EXCEPTION 'SETTLEMENT_ROLLBACK_REQUIRES_CONTAINMENT'; END IF;
 -- No erasure of historical cost/attempt evidence. Once used, rollback needs
 -- an archival compatible release, not this empty-installation rollback.
 IF EXISTS(SELECT 1 FROM control.dispatch_attempt_bindings) OR EXISTS(SELECT 1 FROM control.dispatch_settlement_receipts)
 THEN RAISE EXCEPTION 'SETTLEMENT_HISTORY_PRESENT'; END IF;
 FOR f IN SELECT * FROM (VALUES
 ('claim_dispatch','text,integer,integer'),('recover_dispatch_leases',''),('fail_dispatch','uuid,text,text,boolean,text,bigint'),
 ('complete_dispatch','uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer'),
 ('activate_a1_dispatch_execution_window','uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text')
 ) AS functions(name,types) LOOP
  EXECUTE format('DROP FUNCTION control.%I(%s)',f.name,f.types);
  EXECUTE format('ALTER FUNCTION control.%I(%s) RENAME TO %I','legacy_036_'||f.name,f.types,f.name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION control.%I(%s) TO %I',f.name,f.types,CASE WHEN f.name='activate_a1_dispatch_execution_window' THEN 'commercial_safety_operator' ELSE 'commercial_runtime' END);
 END LOOP;
 FOR c IN SELECT * FROM control.settlement_036_constraint_restore LOOP
  EXECUTE format('ALTER TABLE control.dispatch_jobs DROP CONSTRAINT %I',c.name);
  EXECUTE format('ALTER TABLE control.dispatch_jobs ADD CONSTRAINT %I %s',c.name,c.definition);
 END LOOP;
END $$;
DROP TRIGGER capture_dispatch_attempt_binding ON control.dispatch_jobs;
DROP PROCEDURE control.commit_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer,uuid);
DROP TABLE control.dispatch_settlement_receipts,control.dispatch_attempt_bindings,control.settlement_036_constraint_restore;
DROP FUNCTION control.capture_dispatch_attempt_binding(),control.finalize_dispatch_settlement(),control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer),control.get_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer);
DELETE FROM control.schema_migrations WHERE version='036_atomic_dispatch_settlement';
COMMIT;
