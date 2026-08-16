BEGIN;

ALTER TABLE control.dispatch_jobs
  ADD COLUMN IF NOT EXISTS usage_budget_state text NOT NULL DEFAULT 'unreserved'
    CHECK(usage_budget_state IN('unreserved','reserved','settled','held_uncertain','released')),
  ADD COLUMN IF NOT EXISTS usage_value_reservation_micro_cents bigint NOT NULL DEFAULT 0
    CHECK(usage_value_reservation_micro_cents BETWEEN 0 AND 10000000),
  ADD COLUMN IF NOT EXISTS usage_value_actual_micro_cents bigint
    CHECK(usage_value_actual_micro_cents BETWEEN 1 AND 10000000),
  ADD COLUMN IF NOT EXISTS usage_record_id text
    CHECK(usage_record_id IS NULL OR (length(usage_record_id) BETWEEN 1 AND 256 AND usage_record_id~'^[A-Za-z0-9._:-]+$')),
  ADD COLUMN IF NOT EXISTS usage_value_source text
    CHECK(usage_value_source IS NULL OR usage_value_source='opencode_usage_export'),
  ADD COLUMN IF NOT EXISTS mission_committed_before_micro_cents bigint NOT NULL DEFAULT 0
    CHECK(mission_committed_before_micro_cents>=0),
  ADD COLUMN IF NOT EXISTS total_committed_before_micro_cents bigint NOT NULL DEFAULT 0
    CHECK(total_committed_before_micro_cents>=0),
  ADD COLUMN IF NOT EXISTS usage_budget_version bigint NOT NULL DEFAULT 0
    CHECK(usage_budget_version>=0);

CREATE UNIQUE INDEX IF NOT EXISTS dispatch_jobs_usage_record_idx
  ON control.dispatch_jobs(usage_record_id) WHERE usage_record_id IS NOT NULL;

UPDATE control.dispatch_jobs
SET usage_budget_state='held_uncertain',
    usage_value_reservation_micro_cents=10000000,
    usage_value_consumed_usd=0.1,
    usage_budget_version=greatest(usage_budget_version,1)
WHERE status IN('leased','usage_unknown') AND usage_budget_state='unreserved';

DO $$BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conrelid='control.dispatch_jobs'::regclass
      AND conname='dispatch_jobs_usage_budget_consistency_check'
  ) THEN
    ALTER TABLE control.dispatch_jobs
      ADD CONSTRAINT dispatch_jobs_usage_budget_consistency_check CHECK(
        (usage_budget_state IN('unreserved','released')
          AND usage_value_actual_micro_cents IS NULL
          AND usage_record_id IS NULL AND usage_value_source IS NULL)
        OR
        (usage_budget_state='reserved' AND status='leased'
          AND usage_value_reservation_micro_cents=10000000
          AND usage_value_actual_micro_cents IS NULL
          AND usage_record_id IS NULL AND usage_value_source IS NULL
          AND usage_budget_version>0)
        OR
        (usage_budget_state='held_uncertain' AND status='usage_unknown'
          AND usage_value_reservation_micro_cents=10000000
          AND usage_value_actual_micro_cents IS NULL
          AND usage_record_id IS NULL AND usage_value_source IS NULL
          AND usage_budget_version>0)
        OR
        (usage_budget_state='settled' AND status IN('succeeded','failed','budget_exceeded')
          AND usage_value_reservation_micro_cents=10000000
          AND usage_value_actual_micro_cents IS NOT NULL
          AND usage_record_id IS NOT NULL
          AND usage_value_source IS NOT NULL
          AND usage_value_source='opencode_usage_export'
          AND usage_budget_version>0)
      );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS control.usage_budget_control(
  control_id smallint PRIMARY KEY CHECK(control_id=1),
  run_ceiling_micro_cents bigint NOT NULL DEFAULT 10000000 CHECK(run_ceiling_micro_cents=10000000),
  mission_ceiling_micro_cents bigint NOT NULL DEFAULT 50000000 CHECK(mission_ceiling_micro_cents=50000000),
  activation_ceiling_micro_cents bigint NOT NULL DEFAULT 1000000000 CHECK(activation_ceiling_micro_cents=1000000000),
  probe_job_id uuid REFERENCES control.dispatch_jobs(job_id) ON DELETE RESTRICT,
  probe_worker text,
  probe_lease_until timestamptz,
  quarantined boolean NOT NULL DEFAULT false,
  quarantine_reason text CHECK(quarantine_reason IS NULL OR quarantine_reason~'^[A-Z0-9_:-]{1,128}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((probe_worker IS NULL)=(probe_lease_until IS NULL)),
  CHECK(probe_worker IS NULL OR probe_job_id IS NOT NULL),
  CHECK(NOT quarantined OR quarantine_reason IS NOT NULL)
);

INSERT INTO control.usage_budget_control(
  control_id,quarantined,quarantine_reason
)
SELECT 1,
  EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE status IN('leased','succeeded','failed','usage_unknown')),
  CASE WHEN EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE status IN('leased','succeeded','failed','usage_unknown'))
       THEN 'PRE_USAGE_LEDGER_HISTORY' ELSE NULL END
ON CONFLICT(control_id) DO NOTHING;

CREATE OR REPLACE FUNCTION control.recover_dispatch_leases() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE n integer;now_at timestamptz:=clock_timestamp();held_job uuid;
BEGIN
 PERFORM 1 FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
 WITH changed AS(
   UPDATE control.dispatch_jobs
   SET status='usage_unknown',lease_owner=NULL,lease_until=NULL,
       child_timeout_seconds=NULL,next_attempt_at=now_at,updated_at=now_at,
       error='LEASE_EXPIRED_USAGE_UNKNOWN',usage_budget_state='held_uncertain',
       usage_value_consumed_usd=usage_value_reservation_micro_cents::numeric/100000000
   WHERE status='leased'AND lease_until<=now_at
   RETURNING job_id,status
 ),events AS(
   INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)
   SELECT job_id,'leased',status,'LEASE_EXPIRED',now_at FROM changed
   RETURNING job_id
 ) SELECT count(*)::integer,min(job_id::text)::uuid INTO n,held_job FROM events;
 IF n>0 THEN
   UPDATE control.usage_budget_control
   SET quarantined=true,quarantine_reason='LEASE_EXPIRED_USAGE_UNKNOWN',
       probe_job_id=held_job,probe_worker=NULL,probe_lease_until=NULL,updated_at=now_at
   WHERE control_id=1;
 END IF;
 RETURN n;
END$$;

CREATE OR REPLACE FUNCTION control.claim_dispatch(text,integer,integer)
RETURNS SETOF control.dispatch_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE selected uuid;now_at timestamptz:=clock_timestamp();guard control.usage_budget_control%ROWTYPE;
 job control.dispatch_jobs%ROWTYPE;mission_committed bigint;total_committed bigint;mission_limit bigint;
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
 IF job.usage_value_reservation_usd>0.1
    OR mission_committed+guard.run_ceiling_micro_cents>mission_limit
    OR total_committed+guard.run_ceiling_micro_cents>guard.activation_ceiling_micro_cents THEN
   UPDATE control.dispatch_jobs SET status='budget_exceeded',updated_at=now_at,
     error='USAGE_BUDGET_RESERVATION_EXCEEDED' WHERE job_id=selected;
   INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)
     VALUES(selected,'queued','budget_exceeded','USAGE_BUDGET_RESERVATION_EXCEEDED',now_at);
   RETURN;
 END IF;
 UPDATE control.dispatch_jobs SET status='leased',lease_owner=$1,
   lease_until=now_at+make_interval(secs=>$2),child_timeout_seconds=$3,
   attempts=attempts+1,usage_value_consumed_usd=guard.run_ceiling_micro_cents::numeric/100000000,
   usage_budget_state='reserved',usage_value_reservation_micro_cents=guard.run_ceiling_micro_cents,
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

CREATE OR REPLACE FUNCTION control.fail_dispatch(uuid,text,text,boolean,text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE target text;now_at timestamptz:=clock_timestamp();job control.dispatch_jobs%ROWTYPE;
 safe_error text;guard control.usage_budget_control%ROWTYPE;
BEGIN
 IF $5 NOT IN('not_started','usage_unknown')THEN RAISE EXCEPTION'INVALID_EXECUTION_STATE';END IF;
 safe_error:=CASE WHEN $3~'^[A-Z0-9_:-]{1,128}$'THEN $3 ELSE'EXECUTOR_FAILURE'END;
 SELECT*INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
 SELECT*INTO job FROM control.dispatch_jobs
   WHERE job_id=$1 AND status='leased'AND lease_owner=$2 AND lease_until>now_at FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION'DISPATCH_LEASE_CONFLICT';END IF;
 IF job.usage_budget_state<>'reserved' OR guard.probe_job_id IS DISTINCT FROM $1
    OR guard.probe_worker IS DISTINCT FROM $2 THEN RAISE EXCEPTION'USAGE_BUDGET_CAS_CONFLICT';END IF;
 target:=CASE WHEN $5='usage_unknown'THEN'usage_unknown'
              WHEN $4 AND job.attempts<job.max_attempts THEN'queued'ELSE'failed'END;
 UPDATE control.dispatch_jobs SET status=target,lease_owner=NULL,lease_until=NULL,
   child_timeout_seconds=NULL,next_attempt_at=now_at,
   usage_value_consumed_usd=CASE WHEN $5='not_started'THEN 0 ELSE usage_value_reservation_micro_cents::numeric/100000000 END,
   usage_budget_state=CASE WHEN $5='not_started'THEN'released'ELSE'held_uncertain'END,
   error=safe_error,updated_at=now_at WHERE job_id=$1;
 IF $5='not_started'THEN
   UPDATE control.usage_budget_control SET probe_job_id=NULL,probe_worker=NULL,
     probe_lease_until=NULL,updated_at=now_at WHERE control_id=1;
 ELSE
   UPDATE control.usage_budget_control SET quarantined=true,quarantine_reason=safe_error,
     probe_job_id=$1,probe_worker=NULL,probe_lease_until=NULL,updated_at=now_at WHERE control_id=1;
 END IF;
 INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)
   VALUES($1,'leased',target,safe_error,now_at);
END$$;

CREATE OR REPLACE FUNCTION control.complete_dispatch(
  uuid,text,jsonb,text,bigint,text,bigint,bigint,integer
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE target text;now_at timestamptz:=clock_timestamp();job control.dispatch_jobs%ROWTYPE;
 guard control.usage_budget_control%ROWTYPE;
BEGIN
 IF $5 NOT BETWEEN 1 AND 10000000 OR length($6) NOT BETWEEN 1 AND 256
    OR $6!~'^[A-Za-z0-9._:-]+$'
    OR $7<1 OR $8<1 OR $9<1 THEN RAISE EXCEPTION'INVALID_DISPATCH_USAGE';END IF;
 IF $3->'usage'->'cost'->>'source'<>'official_docs_snapshot'
    OR coalesce($3->'usage'->'cost'->>'pricing_snapshot_id','')=''
    OR ($3->'usage'->'cost'->>'cash_cost_usd')::numeric<>0
   THEN RAISE EXCEPTION'INVALID_PRICING_AUTHORITY';END IF;
 SELECT*INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
 SELECT*INTO job FROM control.dispatch_jobs
   WHERE job_id=$1 AND status='leased'AND lease_owner=$2 AND lease_until>now_at FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION'DISPATCH_LEASE_CONFLICT';END IF;
 IF job.usage_budget_state<>'reserved' OR job.usage_budget_version<>$7
    OR guard.probe_job_id IS DISTINCT FROM $1 OR guard.probe_worker IS DISTINCT FROM $2
   THEN RAISE EXCEPTION'USAGE_BUDGET_CAS_CONFLICT';END IF;
 target:=CASE WHEN $8>job.maximum_tokens OR $9>job.maximum_api_calls THEN'budget_exceeded'
              WHEN $3->'agent_result'->>'status'='failed'THEN'failed'ELSE'succeeded'END;
 UPDATE control.dispatch_jobs SET status=target,lease_owner=NULL,lease_until=NULL,
   child_timeout_seconds=NULL,result_envelope=$3,artifact_sha256=$4,
   usage_value_actual_usd=$5::numeric/100000000,
   usage_value_consumed_usd=$5::numeric/100000000,cash_cost_actual_usd=0,
   pricing_snapshot_id=$3->'usage'->'cost'->>'pricing_snapshot_id',tokens_used=$8,
   api_calls_used=$9,usage_budget_state='settled',usage_value_actual_micro_cents=$5,
   usage_record_id=$6,usage_value_source='opencode_usage_export',updated_at=now_at
 WHERE job_id=$1 AND usage_budget_version=$7;
 IF NOT FOUND THEN RAISE EXCEPTION'USAGE_BUDGET_CAS_CONFLICT';END IF;
 UPDATE control.usage_budget_control SET probe_job_id=NULL,probe_worker=NULL,
   probe_lease_until=NULL,updated_at=now_at WHERE control_id=1;
 INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)
   VALUES($1,'leased',target,CASE WHEN target='budget_exceeded'THEN'USAGE_RESERVATION_EXCEEDED'ELSE'USAGE_EXPORT_SETTLED'END,now_at);
 RETURN target;
END$$;

REVOKE ALL ON control.usage_budget_control FROM
  PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION
  control.recover_dispatch_leases(),control.claim_dispatch(text,integer,integer),
  control.fail_dispatch(uuid,text,text,boolean,text),
  control.complete_dispatch(uuid,text,jsonb,text,numeric,bigint,integer),
  control.complete_dispatch(uuid,text,jsonb,text,bigint,text,bigint,bigint,integer)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION
  control.recover_dispatch_leases(),control.claim_dispatch(text,integer,integer),
  control.fail_dispatch(uuid,text,text,boolean,text),
  control.complete_dispatch(uuid,text,jsonb,text,bigint,text,bigint,bigint,integer)
TO commercial_runtime;

COMMIT;
