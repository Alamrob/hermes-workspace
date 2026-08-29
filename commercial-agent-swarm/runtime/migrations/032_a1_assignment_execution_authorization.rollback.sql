BEGIN;

DO $$BEGIN
 IF EXISTS(SELECT 1 FROM control.a1_assignment_execution_authorizations) OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_arms)
 THEN RAISE EXCEPTION'A1_ASSIGNMENT_EXECUTION_AUTHORIZATION_HISTORY_PRESENT';END IF;
END$$;

CREATE OR REPLACE FUNCTION control.claim_dispatch(text,integer,integer)
RETURNS SETOF control.dispatch_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE selected uuid;now_at timestamptz:=clock_timestamp();guard control.usage_budget_control%ROWTYPE;
 job control.dispatch_jobs%ROWTYPE;mission_committed bigint;total_committed bigint;mission_limit bigint;
 requested_reservation bigint;
BEGIN
 IF $1 IS NULL OR btrim($1)='' OR $2 NOT BETWEEN 2 AND 3600 OR $3<1 OR $3>=$2
   THEN RAISE EXCEPTION'INVALID_DISPATCH_LEASE';END IF;
 PERFORM control.recover_dispatch_leases();
 SELECT*INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
 IF guard.quarantined OR guard.probe_worker IS NOT NULL THEN RETURN;END IF;
 SELECT j.job_id INTO selected
 FROM control.dispatch_jobs j JOIN control.missions m ON m.mission_id=j.mission_id
 WHERE j.status='queued' AND j.next_attempt_at<=now_at AND j.attempts<j.max_attempts
   AND (m.payload->>'expires_at')::timestamptz>now_at
   AND NOT control.is_kill_switch_active(j.mission_id::text,'internal')
   AND NOT EXISTS(
     SELECT 1 FROM control.dispatch_dependencies d
     JOIN control.dispatch_jobs p ON p.job_id=d.depends_on_job_id
     WHERE d.job_id=j.job_id AND p.status<>'succeeded'
   )
 ORDER BY j.created_at,j.job_id FOR UPDATE OF j SKIP LOCKED LIMIT 1;
 IF selected IS NULL THEN RETURN;END IF;
 SELECT*INTO job FROM control.dispatch_jobs WHERE job_id=selected FOR UPDATE;
 requested_reservation:=round(job.usage_value_reservation_usd*100000000)::bigint;
 SELECT coalesce(sum(CASE usage_budget_state
   WHEN'settled'THEN usage_value_actual_micro_cents
   WHEN'reserved'THEN usage_value_reservation_micro_cents
   WHEN'held_uncertain'THEN usage_value_reservation_micro_cents ELSE 0 END),0)::bigint
 INTO mission_committed FROM control.dispatch_jobs WHERE mission_id=job.mission_id;
 SELECT coalesce(sum(CASE usage_budget_state
   WHEN'settled'THEN usage_value_actual_micro_cents
   WHEN'reserved'THEN usage_value_reservation_micro_cents
   WHEN'held_uncertain'THEN usage_value_reservation_micro_cents ELSE 0 END),0)::bigint
 INTO total_committed FROM control.dispatch_jobs;
 mission_limit:=least(
   guard.mission_ceiling_micro_cents,
   floor(job.mission_usage_value_ceiling_usd*100000000)::bigint
 );
 IF requested_reservation<1
    OR requested_reservation>guard.run_ceiling_micro_cents
    OR mission_committed+requested_reservation>mission_limit
    OR total_committed+requested_reservation>guard.activation_ceiling_micro_cents THEN
   UPDATE control.dispatch_jobs SET status='budget_exceeded',updated_at=now_at,
     error='USAGE_BUDGET_RESERVATION_EXCEEDED' WHERE job_id=selected;
   INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)
     VALUES(selected,'queued','budget_exceeded','USAGE_BUDGET_RESERVATION_EXCEEDED',now_at);
   RETURN;
 END IF;
 UPDATE control.dispatch_jobs SET status='leased',lease_owner=$1,
   lease_until=now_at+make_interval(secs=>$2),child_timeout_seconds=$3,
   attempts=attempts+1,usage_value_consumed_usd=requested_reservation::numeric/100000000,
   usage_budget_state='reserved',usage_value_reservation_micro_cents=requested_reservation,
   usage_value_actual_micro_cents=NULL,usage_record_id=NULL,usage_value_source=NULL,
   mission_committed_before_micro_cents=mission_committed,
   total_committed_before_micro_cents=total_committed,
   usage_budget_version=usage_budget_version+1,updated_at=now_at
 WHERE job_id=selected;
 UPDATE control.usage_budget_control SET probe_job_id=selected,probe_worker=$1,
   probe_lease_until=now_at+make_interval(secs=>$2),updated_at=now_at WHERE control_id=1;
 INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)
   VALUES(selected,'queued','leased','USAGE_BUDGET_RESERVED',now_at);
 RETURN QUERY SELECT*FROM control.dispatch_jobs WHERE job_id=selected;
END$$;

REVOKE ALL ON FUNCTION control.get_a1_assignment_execution_authorization(uuid),control.record_a1_assignment_execution_authorization(uuid,uuid,uuid,text,uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,uuid[],numeric,text,jsonb,text,text) FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
DROP FUNCTION control.get_a1_assignment_execution_authorization(uuid),control.record_a1_assignment_execution_authorization(uuid,uuid,uuid,text,uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,uuid[],numeric,text,jsonb,text,text);
DROP TABLE control.a1_dispatch_execution_arms,control.a1_assignment_execution_authorizations;
DELETE FROM control.schema_migrations WHERE version='032_a1_assignment_execution_authorization';

COMMIT;
