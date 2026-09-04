BEGIN;
DO $$ BEGIN
 IF NOT control.is_global_kill_switch_active() OR NOT control.external_actions_blocked()
 OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
 OR EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE status='leased' OR usage_budget_state='held_uncertain')
 THEN RAISE EXCEPTION 'SETTLEMENT_MIGRATION_REQUIRES_CONTAINMENT'; END IF;
END $$;

-- Reservations remain capped. Known actual spend must not be truncated to the
-- reservation if a provider anomaly exceeds it; only budget_exceeded may do so.
CREATE TABLE control.settlement_036_constraint_restore(name text PRIMARY KEY,definition text NOT NULL);
INSERT INTO control.settlement_036_constraint_restore SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid='control.dispatch_jobs'::regclass AND conname IN('dispatch_jobs_usage_value_actual_micro_cents_check','dispatch_jobs_usage_budget_consistency_check');
ALTER TABLE control.dispatch_jobs DROP CONSTRAINT dispatch_jobs_usage_value_actual_micro_cents_check;
ALTER TABLE control.dispatch_jobs ADD CONSTRAINT dispatch_jobs_usage_value_actual_micro_cents_check CHECK(usage_value_actual_micro_cents BETWEEN 1 AND 9007199254740991);
ALTER TABLE control.dispatch_jobs DROP CONSTRAINT dispatch_jobs_usage_budget_consistency_check;
ALTER TABLE control.dispatch_jobs ADD CONSTRAINT dispatch_jobs_usage_budget_consistency_check CHECK(
 (usage_budget_state IN('unreserved','released') AND usage_value_actual_micro_cents IS NULL AND usage_record_id IS NULL AND usage_value_source IS NULL)
 OR (usage_budget_state='reserved' AND status='leased' AND usage_value_reservation_micro_cents BETWEEN 1 AND 10000000 AND usage_value_actual_micro_cents IS NULL AND usage_record_id IS NULL AND usage_value_source IS NULL AND usage_budget_version>0)
 OR (usage_budget_state='held_uncertain' AND status='usage_unknown' AND usage_value_reservation_micro_cents BETWEEN 1 AND 10000000 AND usage_value_actual_micro_cents IS NULL AND usage_record_id IS NULL AND usage_value_source IS NULL AND usage_budget_version>0)
 OR (usage_budget_state='settled' AND status IN('succeeded','failed','budget_exceeded') AND usage_value_reservation_micro_cents BETWEEN 1 AND 10000000 AND usage_value_actual_micro_cents IS NOT NULL AND usage_value_actual_micro_cents>=1
     AND (usage_value_actual_micro_cents<=usage_value_reservation_micro_cents OR status='budget_exceeded') AND usage_record_id IS NOT NULL AND usage_value_source IS NOT NULL
     AND usage_value_source IN('opencode_usage_export','opencode_go_native_telemetry','manual_conservative_estimate') AND usage_budget_version>0)
);

CREATE TABLE control.dispatch_attempt_bindings(
 job_id uuid NOT NULL REFERENCES control.dispatch_jobs(job_id),budget_version bigint NOT NULL CHECK(budget_version>0),
 mission_id uuid NOT NULL,worker_id text NOT NULL,window_id uuid NOT NULL REFERENCES control.a1_dispatch_execution_window_authorizations(window_authorization_id),
 epoch_id uuid NOT NULL,claimed_at timestamptz NOT NULL,PRIMARY KEY(job_id,budget_version)
);
CREATE TRIGGER dispatch_attempt_bindings_immutable BEFORE UPDATE OR DELETE ON control.dispatch_attempt_bindings
 FOR EACH STATEMENT EXECUTE FUNCTION control.reject_audit_event_mutation();
CREATE FUNCTION control.capture_dispatch_attempt_binding() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w control.a1_dispatch_execution_window_authorizations%ROWTYPE;
BEGIN
 SELECT * INTO w FROM control.a1_dispatch_execution_window_authorizations WHERE mission_id=NEW.mission_id AND closed_at IS NULL;
 IF NOT FOUND OR w.supervisor_epoch IS NULL OR w.worker_id IS DISTINCT FROM NEW.lease_owner THEN RAISE EXCEPTION 'DISPATCH_ATTEMPT_BINDING_REQUIRED'; END IF;
 INSERT INTO control.dispatch_attempt_bindings VALUES(NEW.job_id,NEW.usage_budget_version,NEW.mission_id,NEW.lease_owner,w.window_authorization_id,w.supervisor_epoch,clock_timestamp());
 RETURN NEW;
END $$;
CREATE TRIGGER capture_dispatch_attempt_binding AFTER UPDATE OF status ON control.dispatch_jobs
 FOR EACH ROW WHEN(NEW.status='leased' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION control.capture_dispatch_attempt_binding();

CREATE TABLE control.dispatch_settlement_receipts(
 receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL,budget_version bigint NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256~'^[0-9a-f]{64}$'),worker_id text NOT NULL,
 submitted_artifact_sha256 text NOT NULL,submitted_envelope jsonb,
 usage_value_micro_cents bigint NOT NULL CHECK(usage_value_micro_cents BETWEEN 1 AND 9007199254740991),
 usage_record_id text NOT NULL,usage_source text NOT NULL,total_tokens bigint NOT NULL,api_calls integer NOT NULL,
 usage jsonb NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','succeeded','failed','budget_exceeded')),
 result_accepted boolean NOT NULL DEFAULT false,reason text,decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(job_id,budget_version),
 FOREIGN KEY(job_id,budget_version) REFERENCES control.dispatch_attempt_bindings(job_id,budget_version),
 CHECK((status='pending' AND submitted_envelope IS NOT NULL AND decided_at IS NULL) OR
       (status<>'pending' AND submitted_envelope IS NULL AND decided_at IS NOT NULL AND reason IS NOT NULL)),
 CHECK(result_accepted=(status='succeeded'))
);

-- Every public budget/job mutation takes the same guard before legacy code or
-- its recontainment trigger can acquire a row lock. Fixed signatures only.
DO $$
DECLARE f record;sig text;args text;body text;
BEGIN
 FOR f IN SELECT * FROM (VALUES
  ('claim_dispatch','text,integer,integer','SETOF control.dispatch_jobs','RETURN QUERY SELECT * FROM',3),
  ('recover_dispatch_leases','','integer','RETURN',0),
  ('fail_dispatch','uuid,text,text,boolean,text,bigint','void','PERFORM',6),
  ('complete_dispatch','uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer','text','RETURN',10),
  ('activate_a1_dispatch_execution_window','uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text','jsonb','RETURN',22)
 ) AS functions(name,types,result,prefix,n)
 LOOP
  sig:=format('control.%I(%s)',f.name,f.types);
  EXECUTE format('ALTER FUNCTION %s RENAME TO %I',sig,'legacy_036_'||f.name);
  EXECUTE format('REVOKE ALL ON FUNCTION control.%I(%s) FROM PUBLIC,commercial_runtime,commercial_safety_operator','legacy_036_'||f.name,f.types);
  SELECT coalesce(string_agg('$'||n,',' ORDER BY n),'') INTO args FROM generate_series(1,f.n) n;
  body:='BEGIN PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE; ';
  IF f.name='complete_dispatch' THEN
   body:=body||'IF EXISTS(SELECT 1 FROM control.dispatch_jobs j JOIN control.a1_dispatch_execution_window_authorizations w USING(mission_id) WHERE j.job_id=$1) THEN RAISE EXCEPTION ''ATOMIC_SETTLEMENT_REQUIRED''; END IF; ';
  END IF;
  body:=body||format('%s control.%I(%s); END',f.prefix,'legacy_036_'||f.name,args);
  EXECUTE format('CREATE FUNCTION %s RETURNS %s LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS %L',sig,f.result,body);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',sig);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',sig,CASE WHEN f.name='activate_a1_dispatch_execution_window' THEN 'commercial_safety_operator' ELSE 'commercial_runtime' END);
 END LOOP;
END $$;

CREATE FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE binding control.dispatch_attempt_bindings%ROWTYPE;job control.dispatch_jobs%ROWTYPE;
 receipt control.dispatch_settlement_receipts%ROWTYPE;fingerprint text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SETTLEMENT_ISOLATION_INVALID'; END IF;
 IF current_query() IS DISTINCT FROM 'CALL control.commit_dispatch_settlement($1::uuid,$2::text,$3::jsonb,$4::text,$5::bigint,$6::text,$7::text,$8::bigint,$9::bigint,$10::integer,NULL::uuid)'
 THEN RAISE EXCEPTION 'SETTLEMENT_SERVER_COMMIT_REQUIRED'; END IF;
 IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL OR $5 IS NULL OR $6 IS NULL OR $7 IS NULL OR $8 IS NULL OR $9 IS NULL OR $10 IS NULL
 OR $4!~'^[0-9a-f]{64}$' OR $5 NOT BETWEEN 1 AND 9007199254740991 OR $8<1 OR $9 NOT BETWEEN 1 AND 9007199254740991 OR $10<1
 OR length($6) NOT BETWEEN 1 AND 256 OR $6!~'^[A-Za-z0-9._:-]+$' OR $7 NOT IN('opencode_usage_export','opencode_go_native_telemetry')
 OR octet_length($3::text)>2097152 OR $3->>'schema_version' IS DISTINCT FROM '1.0'
 OR $3->'usage'->>'completed' IS DISTINCT FROM 'true' OR $3->'usage'->>'failed' IS DISTINCT FROM 'false'
 OR $3->'usage'->>'provider' IS DISTINCT FROM 'opencode-go' OR $3->'usage'->>'model' IS DISTINCT FROM 'deepseek-v4-flash'
 OR $3->'usage'->'cost'->>'status' IS DISTINCT FROM 'known' OR $3->'usage'->'cost'->>'source' IS DISTINCT FROM 'official_docs_snapshot'
 OR coalesce($3->'usage'->'cost'->>'pricing_snapshot_id','')='' OR $3->'usage'->'cost'->>'cash_cost_usd' IS DISTINCT FROM '0'
 OR $3->'agent_result'->>'mission_id' IS NULL OR $3->'agent_result'->>'agent_id' IS NULL
 OR coalesce($3->'agent_result'->>'status','') NOT IN('completed','partial','blocked','failed','approval_required')
 OR ($3->'usage'->'tokens'->>'total')::bigint IS DISTINCT FROM $9 OR ($3->'usage'->>'api_calls')::integer IS DISTINCT FROM $10
 THEN RAISE EXCEPTION 'SETTLEMENT_INPUT_INVALID'; END IF;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)::text,'UTF8')),'hex');
 PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
 SELECT * INTO receipt FROM control.dispatch_settlement_receipts WHERE job_id=$1 AND budget_version=$8;
 IF FOUND THEN
  IF receipt.request_sha256 IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'SETTLEMENT_IMMUTABLE_CONFLICT'; END IF;
  RETURN receipt.receipt_id;
 END IF;
 SELECT * INTO binding FROM control.dispatch_attempt_bindings WHERE job_id=$1 AND budget_version=$8;
 SELECT * INTO job FROM control.dispatch_jobs WHERE job_id=$1;
 IF binding.job_id IS NULL OR binding.worker_id IS DISTINCT FROM $2 OR job.usage_budget_version IS DISTINCT FROM $8
 OR $3->'agent_result'->>'mission_id' IS DISTINCT FROM binding.mission_id::text
 OR $3->'agent_result'->>'agent_id' IS DISTINCT FROM job.profile_id
 OR $3->'agent_result'->>'assignment_id' IS DISTINCT FROM job.job_id::text
 OR $3->'agent_result'->>'trace_id' IS DISTINCT FROM job.trace_id::text
 THEN RAISE EXCEPTION 'SETTLEMENT_ATTEMPT_CONFLICT'; END IF;
 INSERT INTO control.dispatch_settlement_receipts(job_id,budget_version,request_sha256,worker_id,submitted_artifact_sha256,submitted_envelope,usage_value_micro_cents,usage_record_id,usage_source,total_tokens,api_calls,usage)
 VALUES($1,$8,fingerprint,$2,$4,$3,$5,$6,$7,$9,$10,$3->'usage') RETURNING receipt_id INTO receipt.receipt_id;
 -- UUID is only a staging receipt, never an acceptance decision.
 RETURN receipt.receipt_id;
END $$;

CREATE FUNCTION control.finalize_dispatch_settlement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r control.dispatch_settlement_receipts%ROWTYPE;a control.dispatch_attempt_bindings%ROWTYPE;j control.dispatch_jobs%ROWTYPE;
 g control.usage_budget_control%ROWTYPE;permit jsonb;accepted boolean;exceeded boolean;target text;why text;observed timestamptz;deadline timestamptz;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'SETTLEMENT_ISOLATION_INVALID'; END IF;
 PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
 SELECT * INTO r FROM control.dispatch_settlement_receipts WHERE receipt_id=NEW.receipt_id FOR UPDATE;
 IF r.status<>'pending' THEN RETURN NEW; END IF;
 SELECT * INTO a FROM control.dispatch_attempt_bindings WHERE job_id=r.job_id AND budget_version=r.budget_version;
 PERFORM 1 FROM control.a1_dispatch_execution_window_authorizations WHERE window_authorization_id=a.window_id FOR UPDATE;
 PERFORM 1 FROM control.a1_dispatch_execution_control WHERE control_id=1 FOR UPDATE;
 SELECT * INTO g FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
 SELECT * INTO j FROM control.dispatch_jobs WHERE job_id=r.job_id FOR UPDATE;
 PERFORM 1 FROM control.a1_window_supervisor_lease WHERE singleton=1 FOR SHARE;
 IF j.usage_budget_version IS DISTINCT FROM r.budget_version OR a.worker_id IS DISTINCT FROM r.worker_id
 OR ((j.status='leased' AND j.usage_budget_state='reserved' AND j.lease_owner=r.worker_id AND g.probe_job_id=j.job_id AND g.probe_worker=r.worker_id)
      OR (j.status='usage_unknown' AND j.usage_budget_state='held_uncertain')) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'SETTLEMENT_BUDGET_CAS_CONFLICT'; END IF;
 observed:=clock_timestamp();
 permit:=control.get_a1_job_execution_permit(j.job_id,r.worker_id,r.budget_version);
 accepted:=coalesce(permit->>'allowed'='true' AND permit->>'epoch_id'=a.epoch_id::text AND permit->>'window_id'=a.window_id::text,false);
 deadline:=observed+make_interval(secs=>coalesce((permit->>'valid_for_ms')::integer,0)::double precision/1000);
 exceeded:=r.usage_value_micro_cents>j.usage_value_reservation_micro_cents OR r.total_tokens>j.maximum_tokens OR r.api_calls>j.maximum_api_calls;
 target:=CASE WHEN exceeded THEN 'budget_exceeded' WHEN NOT accepted OR r.submitted_envelope->'agent_result'->>'status'<>'completed' THEN 'failed' ELSE 'succeeded' END;
 why:=CASE WHEN exceeded THEN 'KNOWN_USAGE_BUDGET_EXCEEDED' WHEN NOT accepted THEN 'SETTLEMENT_AUTHORITY_LOST' WHEN target='failed' THEN 'AGENT_RESULT_NOT_COMPLETED' ELSE 'ATOMIC_USAGE_SETTLED' END;
 UPDATE control.dispatch_jobs SET status=target,lease_owner=NULL,lease_until=NULL,child_timeout_seconds=NULL,
  result_envelope=CASE WHEN target='succeeded' THEN r.submitted_envelope ELSE NULL END,
  artifact_sha256=CASE WHEN target='succeeded' THEN r.submitted_artifact_sha256 ELSE NULL END,
  usage_value_actual_usd=r.usage_value_micro_cents::numeric/100000000,usage_value_consumed_usd=r.usage_value_micro_cents::numeric/100000000,cash_cost_actual_usd=0,
  pricing_snapshot_id=r.usage->'cost'->>'pricing_snapshot_id',tokens_used=r.total_tokens,api_calls_used=r.api_calls,
  usage_budget_state='settled',usage_value_actual_micro_cents=r.usage_value_micro_cents,usage_record_id=r.usage_record_id,usage_value_source=r.usage_source,
  error=CASE WHEN target='succeeded' THEN NULL ELSE why END,updated_at=clock_timestamp() WHERE job_id=j.job_id;
 -- Recheck after terminal-transition triggers and their potential waits. The
 -- window may now be closed by this very successful terminal transition.
 IF target='succeeded' AND (clock_timestamp()>=deadline OR NOT control.a1_window_supervisor_live()
   OR NOT EXISTS(SELECT 1 FROM control.a1_window_supervisor_lease WHERE singleton=1 AND epoch_id=a.epoch_id)) THEN
  target:='failed';why:='SETTLEMENT_AUTHORITY_LOST';
  UPDATE control.dispatch_jobs SET status=target,result_envelope=NULL,artifact_sha256=NULL,error=why,updated_at=clock_timestamp() WHERE job_id=j.job_id;
 END IF;
 IF target<>'succeeded' THEN PERFORM control.recontain_a1_dispatch_execution_window(j.mission_id,why); END IF;
 -- Resolving known usage never unquarantines the system, nor clears a probe
 -- owned by a different attempt. No provider retry is introduced here.
 UPDATE control.usage_budget_control SET probe_job_id=NULL,probe_worker=NULL,probe_lease_until=NULL,updated_at=clock_timestamp()
 WHERE control_id=1 AND probe_job_id=j.job_id;
 IF exceeded THEN UPDATE control.usage_budget_control SET quarantined=true,quarantine_reason='KNOWN_USAGE_BUDGET_EXCEEDED' WHERE control_id=1; END IF;
 UPDATE control.dispatch_settlement_receipts SET status=target,result_accepted=(target='succeeded'),reason=why,decided_at=clock_timestamp(),submitted_envelope=NULL WHERE receipt_id=r.receipt_id;
 INSERT INTO control.dispatch_events(job_id,from_status,to_status,reason) VALUES(j.job_id,j.status,target,why);
 INSERT INTO control.audit_events(event) VALUES(jsonb_build_object('event','dispatch_settlement_finalized','receipt_id',r.receipt_id,'mission_id',j.mission_id,'job_id',j.job_id,'budget_version',r.budget_version,'status',target,'result_accepted',target='succeeded','usage_value_micro_cents',r.usage_value_micro_cents,'reason',why,'external_action',false,'recorded_at',clock_timestamp()));
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER dispatch_settlement_commit AFTER INSERT ON control.dispatch_settlement_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control.finalize_dispatch_settlement();

-- INVOKER and no SET clause are required for server-owned transaction control.
-- All identifiers are qualified. The SD helper only admits this exact CALL.
CREATE PROCEDURE control.commit_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer,INOUT id uuid)
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
 IF id IS NOT NULL THEN RAISE EXCEPTION 'SETTLEMENT_RECEIPT_INPUT_INVALID'; END IF;
 id:=control.stage_dispatch_settlement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);
 COMMIT;
END $$;

CREATE FUNCTION control.get_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('receipt_id',receipt_id,'job_id',job_id,'budget_version',budget_version,'status',status,'result_accepted',result_accepted,'reason',reason,'usage_value_micro_cents',usage_value_micro_cents)
 FROM control.dispatch_settlement_receipts WHERE job_id=$1 AND budget_version=$8 AND status<>'pending'
 AND request_sha256=encode(sha256(convert_to(jsonb_build_array($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)::text,'UTF8')),'hex')
$$;
REVOKE ALL ON control.dispatch_attempt_bindings,control.dispatch_settlement_receipts,control.settlement_036_constraint_restore FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor;
REVOKE ALL ON FUNCTION control.capture_dispatch_attempt_binding(),control.finalize_dispatch_settlement(),control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer),control.get_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer) FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor;
GRANT EXECUTE ON FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer),control.get_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer) TO commercial_runtime;
REVOKE ALL ON PROCEDURE control.commit_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer,uuid) FROM PUBLIC,commercial_safety_operator,commercial_a1_supervisor;
GRANT EXECUTE ON PROCEDURE control.commit_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer,uuid) TO commercial_runtime;
REVOKE ALL ON FUNCTION control.complete_dispatch(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer) FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor;
COMMIT;
