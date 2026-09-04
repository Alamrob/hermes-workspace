BEGIN;
DO $$ BEGIN
  -- Exclude a new supervisor until rollback commits; never wait behind a running one.
  IF NOT pg_try_advisory_xact_lock(195278449,35) THEN
    RAISE EXCEPTION 'A1_SUPERVISOR_STILL_RUNNING'; END IF;
  IF NOT control.is_global_kill_switch_active() OR NOT control.external_actions_blocked()
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control WHERE claiming_enabled)
  THEN RAISE EXCEPTION 'A1_SUPERVISOR_ROLLBACK_REQUIRES_CONTAINMENT'; END IF;
  IF EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=195278449 AND objid=35 AND objsubid=2
    AND granted AND pid<>pg_backend_pid() AND database=(SELECT oid FROM pg_database WHERE datname=current_database()))
  THEN RAISE EXCEPTION 'A1_SUPERVISOR_STILL_RUNNING'; END IF;
END $$;
DROP TRIGGER a1_claim_requires_live_supervisor ON control.dispatch_jobs;
DROP TRIGGER a1_window_requires_live_supervisor ON control.a1_dispatch_execution_window_authorizations;
DROP TRIGGER a1_claim_supervisor_commit_gate ON control.dispatch_jobs;
DROP TRIGGER a1_window_supervisor_commit_gate ON control.a1_dispatch_execution_window_authorizations;
DROP FUNCTION control.require_a1_window_supervisor();
DROP FUNCTION control.get_a1_job_execution_permit(uuid,text,bigint);
DROP FUNCTION control.pulse_a1_window_supervisor(uuid),control.stop_a1_window_supervisor(uuid);
DROP FUNCTION control.sweep_a1_windows_for_supervisor(text);
DROP FUNCTION control.a1_window_supervisor_live();
ALTER TABLE control.a1_dispatch_execution_window_authorizations DROP COLUMN supervisor_epoch;
DROP TABLE control.a1_window_supervisor_lease;
REVOKE USAGE ON SCHEMA control FROM commercial_a1_supervisor;
DELETE FROM control.schema_migrations WHERE version='035_a1_window_supervisor';
-- Capability role and audit history remain; never delete evidence or login roles.
COMMIT;
