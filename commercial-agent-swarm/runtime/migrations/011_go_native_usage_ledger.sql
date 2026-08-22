BEGIN;

ALTER TABLE control.dispatch_jobs
  DROP CONSTRAINT IF EXISTS dispatch_jobs_usage_value_source_check;
ALTER TABLE control.dispatch_jobs
  ADD CONSTRAINT dispatch_jobs_usage_value_source_check CHECK(
    usage_value_source IS NULL OR usage_value_source IN(
      'opencode_usage_export',
      'opencode_go_native_telemetry',
      'manual_conservative_estimate'
    )
  );

ALTER TABLE control.dispatch_jobs
  DROP CONSTRAINT IF EXISTS dispatch_jobs_usage_budget_consistency_check;
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
      AND usage_value_source IN(
        'opencode_usage_export',
        'opencode_go_native_telemetry',
        'manual_conservative_estimate'
      )
      AND usage_budget_version>0)
  );

CREATE OR REPLACE FUNCTION control.complete_dispatch(
  uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE target text;now_at timestamptz:=clock_timestamp();job control.dispatch_jobs%ROWTYPE;
 guard control.usage_budget_control%ROWTYPE;
BEGIN
 IF $5 NOT BETWEEN 1 AND 10000000 OR length($6) NOT BETWEEN 1 AND 256
    OR $6!~'^[A-Za-z0-9._:-]+$'
    OR $7 NOT IN('opencode_usage_export','opencode_go_native_telemetry')
    OR $8<1 OR $9<1 OR $10<1 THEN RAISE EXCEPTION'INVALID_DISPATCH_USAGE';END IF;
 IF $3->'usage'->'cost'->>'source'<>'official_docs_snapshot'
    OR coalesce($3->'usage'->'cost'->>'pricing_snapshot_id','')=''
    OR ($3->'usage'->'cost'->>'cash_cost_usd')::numeric<>0
   THEN RAISE EXCEPTION'INVALID_PRICING_AUTHORITY';END IF;
 SELECT*INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
 SELECT*INTO job FROM control.dispatch_jobs
   WHERE job_id=$1 AND status='leased'AND lease_owner=$2 AND lease_until>now_at FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION'DISPATCH_LEASE_CONFLICT';END IF;
 IF job.usage_budget_state<>'reserved' OR job.usage_budget_version<>$8
    OR guard.probe_job_id IS DISTINCT FROM $1 OR guard.probe_worker IS DISTINCT FROM $2
   THEN RAISE EXCEPTION'USAGE_BUDGET_CAS_CONFLICT';END IF;
 target:=CASE WHEN $9>job.maximum_tokens OR $10>job.maximum_api_calls THEN'budget_exceeded'
              WHEN $3->'agent_result'->>'status'='failed'THEN'failed'ELSE'succeeded'END;
 UPDATE control.dispatch_jobs SET status=target,lease_owner=NULL,lease_until=NULL,
   child_timeout_seconds=NULL,result_envelope=$3,artifact_sha256=$4,
   usage_value_actual_usd=$5::numeric/100000000,
   usage_value_consumed_usd=$5::numeric/100000000,cash_cost_actual_usd=0,
   pricing_snapshot_id=$3->'usage'->'cost'->>'pricing_snapshot_id',tokens_used=$9,
   api_calls_used=$10,usage_budget_state='settled',usage_value_actual_micro_cents=$5,
   usage_record_id=$6,usage_value_source=$7,updated_at=now_at
 WHERE job_id=$1 AND usage_budget_version=$8;
 IF NOT FOUND THEN RAISE EXCEPTION'USAGE_BUDGET_CAS_CONFLICT';END IF;
 UPDATE control.usage_budget_control SET probe_job_id=NULL,probe_worker=NULL,
   probe_lease_until=NULL,updated_at=now_at WHERE control_id=1;
 INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)
   VALUES($1,'leased',target,CASE WHEN target='budget_exceeded'THEN'USAGE_RESERVATION_EXCEEDED'
     WHEN $7='opencode_go_native_telemetry'THEN'GO_NATIVE_USAGE_SETTLED'
     ELSE'USAGE_EXPORT_SETTLED'END,now_at);
 RETURN target;
END$$;

REVOKE ALL ON FUNCTION
  control.complete_dispatch(uuid,text,jsonb,text,bigint,text,bigint,bigint,integer),
  control.complete_dispatch(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION
  control.complete_dispatch(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
TO commercial_runtime;

COMMIT;
