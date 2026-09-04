BEGIN;

-- Additive safety interlock. Never edit the already deployed migration 034.
DO $$ BEGIN
  IF NOT control.is_global_kill_switch_active()
     OR NOT control.external_actions_blocked()
     OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
     OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control WHERE claiming_enabled)
     OR EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE status='leased' OR usage_budget_state='held_uncertain')
  THEN RAISE EXCEPTION 'A1_SUPERVISOR_MIGRATION_REQUIRES_CONTAINMENT'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commercial_a1_supervisor') THEN
    CREATE ROLE commercial_a1_supervisor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commercial_a1_supervisor' AND
    (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='commercial_a1_supervisor'))
  THEN RAISE EXCEPTION 'UNSAFE_A1_SUPERVISOR_CAPABILITY'; END IF;
END $$;

CREATE TABLE control.a1_window_supervisor_lease(
  singleton integer PRIMARY KEY CHECK(singleton=1),
  instance_id uuid NOT NULL,
  epoch_id uuid NOT NULL,
  backend_pid integer NOT NULL,
  backend_start timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  lease_until timestamptz NOT NULL,
  CHECK(lease_until>=observed_at AND lease_until<=observed_at+interval '5 seconds')
);
ALTER TABLE control.a1_dispatch_execution_window_authorizations ADD COLUMN supervisor_epoch uuid;

CREATE FUNCTION control.a1_window_supervisor_live() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM control.a1_window_supervisor_lease s
    JOIN pg_stat_activity a ON a.pid=s.backend_pid AND a.backend_start=s.backend_start
    JOIN pg_locks l ON l.pid=s.backend_pid AND l.locktype='advisory'
      AND l.classid=195278449 AND l.objid=35 AND l.objsubid=2 AND l.granted AND l.mode='ExclusiveLock'
      AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
    WHERE s.singleton=1 AND s.observed_at<=clock_timestamp() AND s.lease_until>clock_timestamp()
  )
$$;

-- Read-only lease assertion, not an authorization writer or a job claim.
-- One statement/snapshot binds the observed supervisor generation to its
-- session and exclusive lock. The receiver's challenge must precede this read.
CREATE FUNCTION control.get_a1_job_execution_permit(uuid,text,bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE permit record; remaining integer;
BEGIN
  SELECT j.job_id,j.mission_id,w.worker_id,w.window_authorization_id,s.epoch_id,j.usage_budget_version,
    least(j.lease_until,j.updated_at+make_interval(secs=>j.child_timeout_seconds),g.probe_lease_until,s.lease_until,w.expires_at,c.expires_at,arm.expires_at,
      aa.expires_at,ea.expires_at,(m.payload->>'expires_at')::timestamptz) AS deadline
  INTO permit
  FROM control.dispatch_jobs j
  JOIN control.missions m ON m.mission_id=j.mission_id
  JOIN control.usage_budget_control g ON g.control_id=1 AND NOT g.quarantined AND g.probe_job_id=j.job_id
    AND g.probe_worker=$2 AND g.probe_lease_until IS NOT NULL
  JOIN control.a1_dispatch_execution_window_authorizations w ON w.mission_id=j.mission_id
    AND w.closed_at IS NULL AND w.worker_id=$2 AND w.opens_at<=clock_timestamp()
  JOIN control.a1_dispatch_execution_control c ON c.control_id=1 AND c.claiming_enabled
    AND c.mission_id=w.mission_id AND c.arm_id=w.arm_id AND c.worker_id=w.worker_id
    AND c.opened_at=w.opens_at AND c.expires_at=w.expires_at
  JOIN control.a1_dispatch_execution_arms arm ON arm.arm_id=w.arm_id AND arm.mission_id=j.mission_id
    AND arm.worker_id=$2 AND arm.starts_at<=clock_timestamp() AND arm.claims_used BETWEEN 1 AND arm.maximum_claims
    AND arm.arm_authorization_id=w.arm_authorization_id AND arm.execution_authorization_id=w.execution_authorization_id
  JOIN control.a1_dispatch_execution_arm_authorizations aa ON aa.authorization_id=w.arm_authorization_id
    AND aa.mission_id=j.mission_id AND aa.execution_authorization_id=w.execution_authorization_id
    AND aa.worker_id=$2 AND aa.decision='approved' AND j.job_id=ANY(aa.assignment_ids)
    AND aa.mission_sha256=w.mission_sha256 AND aa.assignment_plan_sha256=w.assignment_plan_sha256 AND aa.job_set_sha256=w.job_set_sha256
  JOIN control.a1_assignment_execution_authorizations ea ON ea.authorization_id=w.execution_authorization_id
    AND ea.mission_id=j.mission_id AND ea.decision='approved' AND j.job_id=ANY(ea.assignment_ids)
    AND ea.mission_sha256=w.mission_sha256 AND ea.assignment_plan_sha256=w.assignment_plan_sha256 AND ea.job_set_sha256=w.job_set_sha256
  JOIN control.a1_window_supervisor_lease s ON s.singleton=1 AND s.epoch_id=w.supervisor_epoch
    AND s.observed_at<=clock_timestamp()
  JOIN pg_stat_activity a ON a.pid=s.backend_pid AND a.backend_start=s.backend_start
  JOIN pg_locks l ON l.pid=s.backend_pid AND l.locktype='advisory' AND l.classid=195278449
    AND l.objid=35 AND l.objsubid=2 AND l.granted AND l.mode='ExclusiveLock'
    AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
  WHERE j.job_id=$1 AND j.status='leased' AND j.usage_budget_state='reserved' AND j.lease_owner=$2
    AND j.lease_until IS NOT NULL AND j.child_timeout_seconds>=1 AND j.usage_budget_version=$3 AND $3>0
    AND j.usage_value_reservation_micro_cents BETWEEN 1 AND g.run_ceiling_micro_cents
    AND m.payload->>'autonomy_level'='A1' AND m.payload->>'dry_run'='true'
    AND m.payload->>'expires_at' IS NOT NULL
    AND m.payload->'contact_policy'->>'contact_permitted'='false'
    AND m.payload->'volume_limits'->>'maximum_external_actions'='0'
    AND NOT control.is_global_kill_switch_active() AND control.external_actions_blocked()
    AND NOT control.is_kill_switch_active(j.mission_id::text,'internal')
    AND NOT EXISTS(SELECT 1 FROM control.dispatch_jobs sibling WHERE sibling.mission_id=j.mission_id
      AND (sibling.status IN('failed','usage_unknown','budget_exceeded') OR sibling.usage_budget_state='held_uncertain'));
  IF NOT FOUND OR permit.deadline IS NULL THEN RETURN jsonb_build_object('allowed',false); END IF;
  remaining:=least(5000,floor(extract(epoch FROM permit.deadline-clock_timestamp())*1000)::integer);
  IF remaining<1 THEN RETURN jsonb_build_object('allowed',false); END IF;
  RETURN jsonb_build_object('allowed',true,'job_id',permit.job_id,'mission_id',permit.mission_id,
    'worker_id',permit.worker_id,'window_id',permit.window_authorization_id,'epoch_id',permit.epoch_id,
    'budget_version',permit.usage_budget_version,'valid_for_ms',remaining);
END $$;
REVOKE ALL ON FUNCTION control.get_a1_job_execution_permit(uuid,text,bigint)
  FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor;
GRANT EXECUTE ON FUNCTION control.get_a1_job_execution_permit(uuid,text,bigint) TO commercial_runtime;

CREATE FUNCTION control.require_a1_window_supervisor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w control.a1_dispatch_execution_window_authorizations%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='a1_dispatch_execution_window_authorizations' THEN
    IF TG_WHEN='BEFORE' THEN
      SELECT epoch_id INTO NEW.supervisor_epoch FROM control.a1_window_supervisor_lease WHERE singleton=1;
    END IF;
    w:=NEW;
    IF TG_WHEN='AFTER' AND EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations
      WHERE window_authorization_id=w.window_authorization_id AND closed_at IS NOT NULL)
    THEN RETURN NEW; END IF;
  ELSE
    IF TG_WHEN='AFTER' AND EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE job_id=NEW.job_id AND status<>'leased')
    THEN RETURN NEW; END IF;
    SELECT * INTO w FROM control.a1_dispatch_execution_window_authorizations
      WHERE mission_id=NEW.mission_id AND closed_at IS NULL;
    IF w.window_authorization_id IS NULL OR w.opens_at>clock_timestamp() OR w.worker_id IS DISTINCT FROM NEW.lease_owner
    THEN RAISE EXCEPTION 'A1_SUPERVISOR_WINDOW_BINDING_INVALID'; END IF;
  END IF;
  IF NOT control.a1_window_supervisor_live() THEN
    RAISE EXCEPTION 'A1_SUPERVISOR_NOT_LIVE';
  END IF;
  IF w.supervisor_epoch IS NULL OR NOT EXISTS(SELECT 1 FROM control.a1_window_supervisor_lease
    WHERE singleton=1 AND epoch_id=w.supervisor_epoch)
  THEN RAISE EXCEPTION 'A1_SUPERVISOR_EPOCH_CHANGED'; END IF;
  IF w.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM control.missions m
    WHERE m.mission_id=w.mission_id AND (m.payload->>'expires_at')::timestamptz>clock_timestamp())
  THEN RAISE EXCEPTION 'A1_SUPERVISOR_WINDOW_EXPIRED'; END IF;
  -- Activation fills control after INSERT. Verify its binding at commit, and at both claim gates.
  IF TG_WHEN='AFTER' OR TG_TABLE_NAME='dispatch_jobs' THEN
    IF NOT EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control c WHERE c.control_id=1
      AND c.claiming_enabled AND c.mission_id=w.mission_id AND c.arm_id=w.arm_id
      AND c.worker_id=w.worker_id AND c.opened_at=w.opens_at AND c.expires_at=w.expires_at)
      OR control.is_global_kill_switch_active() OR NOT control.external_actions_blocked()
    THEN RAISE EXCEPTION 'A1_SUPERVISOR_WINDOW_BINDING_INVALID'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a1_window_requires_live_supervisor
BEFORE INSERT ON control.a1_dispatch_execution_window_authorizations
FOR EACH ROW EXECUTE FUNCTION control.require_a1_window_supervisor();
CREATE TRIGGER a1_claim_requires_live_supervisor
BEFORE UPDATE OF status ON control.dispatch_jobs
FOR EACH ROW WHEN(NEW.status='leased' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION control.require_a1_window_supervisor();
CREATE CONSTRAINT TRIGGER a1_window_supervisor_commit_gate
AFTER INSERT ON control.a1_dispatch_execution_window_authorizations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control.require_a1_window_supervisor();
CREATE CONSTRAINT TRIGGER a1_claim_supervisor_commit_gate
AFTER UPDATE OF status ON control.dispatch_jobs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='leased' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION control.require_a1_window_supervisor();

-- Private helper: only closes existing windows; it cannot authorize or dispatch.
CREATE FUNCTION control.sweep_a1_windows_for_supervisor(text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w record; reason text; closed jsonb:='[]'::jsonb;
BEGIN
  IF $1 IS NOT NULL AND $1 NOT IN('SUPERVISOR_RESTART','SUPERVISOR_STOP') THEN
    RAISE EXCEPTION 'A1_SUPERVISOR_INVALID_SWEEP';
  END IF;
  FOR w IN SELECT * FROM control.a1_dispatch_execution_window_authorizations
    WHERE closed_at IS NULL ORDER BY window_authorization_id
  LOOP
    reason:=$1;
    IF reason IS NULL THEN
      IF w.expires_at<=clock_timestamp() THEN reason:='WINDOW_EXPIRED';
      ELSIF control.is_global_kill_switch_active() THEN reason:='GLOBAL_KILL_SWITCH_ACTIVE';
      ELSIF NOT control.external_actions_blocked() THEN reason:='CHANNEL_GUARD_CHANGED';
      ELSIF NOT EXISTS(SELECT 1 FROM control.a1_window_supervisor_lease WHERE singleton=1 AND epoch_id=w.supervisor_epoch)
      THEN reason:='WINDOW_BINDING_CHANGED';
      ELSIF NOT EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control c WHERE c.control_id=1
        AND c.claiming_enabled AND c.mission_id=w.mission_id AND c.arm_id=w.arm_id
        AND c.worker_id=w.worker_id AND c.opened_at=w.opens_at AND c.expires_at=w.expires_at)
      THEN reason:='WINDOW_BINDING_CHANGED';
      ELSIF EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE mission_id=w.mission_id
        AND (status IN('failed','usage_unknown','budget_exceeded') OR usage_budget_state='held_uncertain'))
      THEN reason:='DISPATCH_UNSAFE';
      ELSIF NOT EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE mission_id=w.mission_id AND status IN('queued','leased'))
      THEN reason:='MISSION_TERMINAL';
      END IF;
    END IF;
    IF reason IS NOT NULL THEN
      PERFORM control.recontain_a1_dispatch_execution_window(w.mission_id,reason);
      IF NOT control.is_global_kill_switch_active()
        OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE window_authorization_id=w.window_authorization_id AND closed_at IS NULL)
        OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control WHERE mission_id=w.mission_id OR arm_id=w.arm_id)
      THEN RAISE EXCEPTION 'A1_SUPERVISOR_CONTAINMENT_UNVERIFIED'; END IF;
      closed:=closed||jsonb_build_array(jsonb_build_object('mission_id',w.mission_id,'window_id',w.window_authorization_id,'reason',reason));
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
    AND (NOT control.is_global_kill_switch_active() OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control
      WHERE claiming_enabled OR mission_id IS NOT NULL OR arm_id IS NOT NULL OR worker_id IS NOT NULL OR opened_at IS NOT NULL OR expires_at IS NOT NULL))
  THEN
    PERFORM control.set_kill_switch('global','*',true);
    UPDATE control.a1_dispatch_execution_control SET claiming_enabled=false,mission_id=NULL,arm_id=NULL,
      worker_id=NULL,opened_at=NULL,expires_at=NULL,updated_at=clock_timestamp() WHERE control_id=1;
    INSERT INTO control.audit_events(event) VALUES(jsonb_build_object('event','a1_supervisor_orphan_contained',
      'recorded_at',clock_timestamp(),'external_action',false));
    closed:=closed||jsonb_build_array(jsonb_build_object('mission_id',NULL,'window_id',NULL,'reason','ORPHANED_CONTROL'));
  END IF;
  RETURN closed;
END $$;

CREATE FUNCTION control.pulse_a1_window_supervisor(uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior control.a1_window_supervisor_lease%ROWTYPE; same_session boolean;
  continued boolean; started timestamptz; at_time timestamptz; closed jsonb; epoch uuid;
BEGIN
  IF $1 IS NULL THEN RAISE EXCEPTION 'A1_SUPERVISOR_INSTANCE_REQUIRED'; END IF;
  -- Never increment the re-entrant advisory lock count on each pulse.
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
    AND classid=195278449 AND objid=35 AND objsubid=2 AND granted AND mode='ExclusiveLock'
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) THEN
    IF NOT pg_try_advisory_lock(195278449,35) THEN RAISE EXCEPTION 'A1_SUPERVISOR_ALREADY_RUNNING'; END IF;
  END IF;
  SELECT backend_start INTO started FROM pg_stat_activity WHERE pid=pg_backend_pid();
  SELECT * INTO prior FROM control.a1_window_supervisor_lease WHERE singleton=1;
  same_session:=prior.instance_id=$1 AND prior.backend_pid=pg_backend_pid() AND prior.backend_start=started;
  continued:=coalesce(same_session AND control.a1_window_supervisor_live(),false);
  closed:=control.sweep_a1_windows_for_supervisor(CASE WHEN continued THEN NULL ELSE 'SUPERVISOR_RESTART' END);
  epoch:=CASE WHEN continued THEN prior.epoch_id ELSE gen_random_uuid() END;
  at_time:=clock_timestamp();
  INSERT INTO control.a1_window_supervisor_lease(singleton,instance_id,epoch_id,backend_pid,backend_start,observed_at,lease_until)
    VALUES(1,$1,epoch,pg_backend_pid(),started,at_time,at_time+interval '5 seconds')
    ON CONFLICT(singleton) DO UPDATE SET instance_id=EXCLUDED.instance_id,epoch_id=EXCLUDED.epoch_id,backend_pid=EXCLUDED.backend_pid,
      backend_start=EXCLUDED.backend_start,observed_at=EXCLUDED.observed_at,lease_until=EXCLUDED.lease_until;
  IF NOT continued THEN
    INSERT INTO control.audit_events(event) VALUES(jsonb_build_object('event','a1_supervisor_session_started',
      'instance_id',$1,'backend_pid',pg_backend_pid(),'recorded_at',at_time,'external_action',false));
  END IF;
  RETURN jsonb_build_object('status','ready','instance_id',$1,'server_time',at_time,'lease_until',at_time+interval '5 seconds','closed',closed);
END $$;

CREATE FUNCTION control.stop_a1_window_supervisor(uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE closed jsonb; at_time timestamptz;
BEGIN
  IF $1 IS NULL OR NOT EXISTS(SELECT 1 FROM control.a1_window_supervisor_lease s
    JOIN pg_stat_activity a ON a.pid=s.backend_pid AND a.backend_start=s.backend_start
    WHERE s.singleton=1 AND s.instance_id=$1 AND s.backend_pid=pg_backend_pid())
  THEN RAISE EXCEPTION 'A1_SUPERVISOR_NOT_OWNER'; END IF;
  closed:=control.sweep_a1_windows_for_supervisor('SUPERVISOR_STOP');
  at_time:=clock_timestamp();
  UPDATE control.a1_window_supervisor_lease SET observed_at=at_time,lease_until=at_time WHERE singleton=1;
  PERFORM pg_advisory_unlock(195278449,35);
  RETURN jsonb_build_object('status','stopped','instance_id',$1,'server_time',at_time,'lease_until',at_time,'closed',closed);
END $$;

REVOKE ALL ON control.a1_window_supervisor_lease FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor;
REVOKE ALL ON FUNCTION control.a1_window_supervisor_live(),control.require_a1_window_supervisor(),
 control.sweep_a1_windows_for_supervisor(text),control.pulse_a1_window_supervisor(uuid),control.stop_a1_window_supervisor(uuid)
 FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor;
GRANT USAGE ON SCHEMA control TO commercial_a1_supervisor;
GRANT EXECUTE ON FUNCTION control.pulse_a1_window_supervisor(uuid),control.stop_a1_window_supervisor(uuid) TO commercial_a1_supervisor;

COMMIT;
