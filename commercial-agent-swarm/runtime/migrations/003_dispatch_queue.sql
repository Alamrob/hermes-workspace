BEGIN;
CREATE TABLE IF NOT EXISTS control.dispatch_jobs(
 job_id uuid PRIMARY KEY,
 mission_id uuid NOT NULL REFERENCES control.missions(mission_id) ON DELETE RESTRICT,
 trace_id uuid NOT NULL,
 idempotency_key text NOT NULL,
 profile_id text NOT NULL CHECK(profile_id IN('sales-orchestrator','market-account-intelligence','contact-data-steward','qualification-prioritization','outreach-draft-manager','commercial-qa-compliance')),
 instruction text NOT NULL CHECK(length(instruction) BETWEEN 1 AND 16384),
 evidence jsonb NOT NULL CHECK(evidence->>'trust'='untrusted_data' AND jsonb_typeof(evidence->'content')='string' AND length(evidence->>'content')<=131072),
 status text NOT NULL CHECK(status IN('queued','leased','succeeded','failed','budget_exceeded','usage_unknown')),
 attempts integer NOT NULL DEFAULT 0,
 max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
 mission_budget_ceiling_usd numeric(14,6) NOT NULL CHECK(mission_budget_ceiling_usd>0),
 budget_reservation_usd numeric(14,6) NOT NULL CHECK(budget_reservation_usd>0),
 maximum_tokens bigint NOT NULL CHECK(maximum_tokens BETWEEN 1 AND 1000000),
 maximum_api_calls integer NOT NULL CHECK(maximum_api_calls BETWEEN 1 AND 100),
 lease_owner text, lease_until timestamptz, child_timeout_seconds integer,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 result_envelope jsonb, artifact_sha256 text CHECK(artifact_sha256~'^[0-9a-f]{64}$'),
 cost_amount numeric(14,6), tokens_used bigint, api_calls_used integer, error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(mission_id,idempotency_key),
 CHECK((status='leased')=(lease_owner IS NOT NULL AND lease_until IS NOT NULL AND child_timeout_seconds IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS dispatch_jobs_claim_idx ON control.dispatch_jobs(status,next_attempt_at,created_at);
CREATE INDEX IF NOT EXISTS dispatch_jobs_mission_idx ON control.dispatch_jobs(mission_id);
CREATE TABLE IF NOT EXISTS control.dispatch_dependencies(job_id uuid NOT NULL REFERENCES control.dispatch_jobs(job_id) ON DELETE CASCADE,depends_on_job_id uuid NOT NULL REFERENCES control.dispatch_jobs(job_id) ON DELETE RESTRICT,PRIMARY KEY(job_id,depends_on_job_id),CHECK(job_id<>depends_on_job_id));
CREATE INDEX IF NOT EXISTS dispatch_dependencies_depends_idx ON control.dispatch_dependencies(depends_on_job_id);
CREATE TABLE IF NOT EXISTS control.dispatch_events(event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,job_id uuid NOT NULL REFERENCES control.dispatch_jobs(job_id) ON DELETE RESTRICT,from_status text,to_status text NOT NULL,reason text,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX IF NOT EXISTS dispatch_events_job_idx ON control.dispatch_events(job_id,event_id);
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='dispatch_events_append_only' AND tgrelid='control.dispatch_events'::regclass)THEN CREATE TRIGGER dispatch_events_append_only BEFORE UPDATE OR DELETE ON control.dispatch_events FOR EACH STATEMENT EXECUTE FUNCTION control.reject_audit_event_mutation();END IF;END$$;

CREATE OR REPLACE FUNCTION control.enqueue_dispatch(uuid,uuid,uuid,text,text,text,text,uuid[],numeric,bigint,integer,integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE existing control.dispatch_jobs%ROWTYPE;d uuid;stored_dependencies uuid[];requested_dependencies uuid[];initial_status text;now_at timestamptz:=clock_timestamp();ceiling numeric;currency text;active_reserved numeric;spent numeric;
BEGIN
 IF $5 NOT IN('sales-orchestrator','market-account-intelligence','contact-data-steward','qualification-prioritization','outreach-draft-manager','commercial-qa-compliance')THEN RAISE EXCEPTION'UNKNOWN_PROFILE';END IF;
 IF $9<=0 OR $10 NOT BETWEEN 1 AND 1000000 OR $11 NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION'INVALID_DISPATCH_RESERVATION';END IF;
 SELECT payload->'budget_limit'->>'currency',(payload->'budget_limit'->>'maximum')::numeric INTO currency,ceiling FROM control.missions WHERE mission_id=$2 FOR UPDATE;
 IF currency IS DISTINCT FROM'USD' OR ceiling IS NULL OR ceiling<=0 THEN RAISE EXCEPTION'MISSION_DISPATCH_BUDGET_REQUIRED';END IF;
 SELECT coalesce(sum(budget_reservation_usd),0)INTO active_reserved FROM control.dispatch_jobs WHERE mission_id=$2 AND status IN('queued','leased');SELECT coalesce(sum(cost_amount),0)INTO spent FROM control.dispatch_jobs WHERE mission_id=$2 AND cost_amount IS NOT NULL;
 initial_status:=CASE WHEN ceiling-spent-active_reserved<$9 THEN'budget_exceeded'ELSE'queued'END;
 INSERT INTO control.dispatch_jobs(job_id,mission_id,trace_id,idempotency_key,profile_id,instruction,evidence,status,mission_budget_ceiling_usd,budget_reservation_usd,maximum_tokens,maximum_api_calls,max_attempts,created_at,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,jsonb_build_object('trust','untrusted_data','content',$7),initial_status,ceiling,$9,$10,$11,$12,now_at,now_at) ON CONFLICT DO NOTHING;
 IF FOUND THEN
  FOREACH d IN ARRAY $8 LOOP IF NOT EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE job_id=d AND mission_id=$2)THEN RAISE EXCEPTION'INVALID_CROSS_MISSION_DEPENDENCY';END IF;INSERT INTO control.dispatch_dependencies VALUES($1,d);END LOOP;
  INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)VALUES($1,NULL,initial_status,CASE WHEN initial_status='budget_exceeded'THEN'INSUFFICIENT_PRE_BUDGET'ELSE'enqueued'END,now_at);
  RETURN $1;
 END IF;
 SELECT*INTO existing FROM control.dispatch_jobs WHERE mission_id=$2 AND idempotency_key=$4;
 SELECT coalesce(array_agg(depends_on_job_id ORDER BY depends_on_job_id),ARRAY[]::uuid[])INTO stored_dependencies FROM control.dispatch_dependencies WHERE job_id=existing.job_id;
 SELECT coalesce(array_agg(value ORDER BY value),ARRAY[]::uuid[])INTO requested_dependencies FROM unnest($8)value;
 IF existing.job_id=$1 AND existing.trace_id=$3 AND existing.profile_id=$5 AND existing.instruction=$6 AND existing.evidence=jsonb_build_object('trust','untrusted_data','content',$7) AND existing.budget_reservation_usd=$9 AND existing.maximum_tokens=$10 AND existing.maximum_api_calls=$11 AND existing.max_attempts=$12 AND stored_dependencies=requested_dependencies THEN RETURN existing.job_id;END IF;
 RAISE EXCEPTION'DISPATCH_IDEMPOTENCY_CONFLICT';
END$$;

CREATE OR REPLACE FUNCTION control.recover_dispatch_leases() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE n integer;now_at timestamptz:=clock_timestamp();BEGIN
 WITH changed AS(UPDATE control.dispatch_jobs SET status=CASE WHEN attempts<max_attempts THEN'queued'ELSE'failed'END,lease_owner=NULL,lease_until=NULL,child_timeout_seconds=NULL,next_attempt_at=now_at,updated_at=now_at,error='LEASE_EXPIRED' WHERE status='leased'AND lease_until<=now_at RETURNING job_id,status)
 INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)SELECT job_id,'leased',status,'LEASE_EXPIRED',now_at FROM changed;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END$$;

CREATE OR REPLACE FUNCTION control.claim_dispatch(text,integer,integer) RETURNS SETOF control.dispatch_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE selected uuid;now_at timestamptz:=clock_timestamp();BEGIN
 IF $1 IS NULL OR btrim($1)='' OR $2 NOT BETWEEN 2 AND 3600 OR $3<1 OR $3>=$2 THEN RAISE EXCEPTION'INVALID_DISPATCH_LEASE';END IF;
 PERFORM control.recover_dispatch_leases();
 SELECT j.job_id INTO selected FROM control.dispatch_jobs j JOIN control.missions m ON m.mission_id=j.mission_id WHERE j.status='queued' AND j.next_attempt_at<=now_at AND j.attempts<j.max_attempts AND (m.payload->>'expires_at')::timestamptz>now_at AND NOT control.is_kill_switch_active(j.mission_id::text,'internal') AND NOT EXISTS(SELECT 1 FROM control.dispatch_dependencies d JOIN control.dispatch_jobs p ON p.job_id=d.depends_on_job_id WHERE d.job_id=j.job_id AND p.status<>'succeeded') ORDER BY j.created_at,j.job_id FOR UPDATE OF j SKIP LOCKED LIMIT 1;
 IF selected IS NULL THEN RETURN;END IF;
 UPDATE control.dispatch_jobs SET status='leased',lease_owner=$1,lease_until=now_at+make_interval(secs=>$2),child_timeout_seconds=$3,attempts=attempts+1,updated_at=now_at WHERE job_id=selected;
 INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)VALUES(selected,'queued','leased','claimed',now_at);
 RETURN QUERY SELECT*FROM control.dispatch_jobs WHERE job_id=selected;
END$$;

CREATE OR REPLACE FUNCTION control.fail_dispatch(uuid,text,text,boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE target text;now_at timestamptz:=clock_timestamp();BEGIN
 SELECT CASE WHEN $4 AND attempts<max_attempts THEN'queued'ELSE'failed'END INTO target FROM control.dispatch_jobs WHERE job_id=$1 AND status='leased'AND lease_owner=$2 AND lease_until>now_at FOR UPDATE;
 IF target IS NULL THEN RAISE EXCEPTION'DISPATCH_LEASE_CONFLICT';END IF;
 UPDATE control.dispatch_jobs SET status=target,lease_owner=NULL,lease_until=NULL,child_timeout_seconds=NULL,next_attempt_at=now_at,error=left($3,1000),updated_at=now_at WHERE job_id=$1;
 INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)VALUES($1,'leased',target,left($3,1000),now_at);
END$$;

CREATE OR REPLACE FUNCTION control.complete_dispatch(uuid,text,jsonb,text,numeric,bigint,integer) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,control AS $$
DECLARE target text;now_at timestamptz:=clock_timestamp();job control.dispatch_jobs%ROWTYPE;BEGIN
 IF $5 IS NULL OR $5<0 OR $6 IS NULL OR $6<1 OR $7 IS NULL OR $7<1 THEN RAISE EXCEPTION'INVALID_DISPATCH_USAGE';END IF;
 SELECT*INTO job FROM control.dispatch_jobs WHERE job_id=$1 AND status='leased'AND lease_owner=$2 AND lease_until>now_at FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION'DISPATCH_LEASE_CONFLICT';END IF;
 target:=CASE WHEN $5>job.budget_reservation_usd OR $6>job.maximum_tokens OR $7>job.maximum_api_calls THEN'budget_exceeded'ELSE'succeeded'END;
 UPDATE control.dispatch_jobs SET status=target,lease_owner=NULL,lease_until=NULL,child_timeout_seconds=NULL,result_envelope=$3,artifact_sha256=$4,cost_amount=$5,tokens_used=$6,api_calls_used=$7,updated_at=now_at WHERE job_id=$1;
 INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason,occurred_at)VALUES($1,'leased',target,CASE WHEN target='budget_exceeded'THEN'USAGE_RESERVATION_EXCEEDED'ELSE'completed'END,now_at);
 RETURN target;
END$$;

REVOKE ALL ON control.dispatch_jobs,control.dispatch_dependencies,control.dispatch_events FROM PUBLIC,commercial_runtime,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON SEQUENCE control.dispatch_events_event_id_seq FROM PUBLIC,commercial_runtime,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION control.enqueue_dispatch(uuid,uuid,uuid,text,text,text,text,uuid[],numeric,bigint,integer,integer),control.recover_dispatch_leases(),control.claim_dispatch(text,integer,integer),control.fail_dispatch(uuid,text,text,boolean),control.complete_dispatch(uuid,text,jsonb,text,numeric,bigint,integer) FROM PUBLIC,commercial_runtime,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.enqueue_dispatch(uuid,uuid,uuid,text,text,text,text,uuid[],numeric,bigint,integer,integer),control.recover_dispatch_leases(),control.claim_dispatch(text,integer,integer),control.fail_dispatch(uuid,text,text,boolean),control.complete_dispatch(uuid,text,jsonb,text,numeric,bigint,integer) TO commercial_runtime;
COMMIT;
