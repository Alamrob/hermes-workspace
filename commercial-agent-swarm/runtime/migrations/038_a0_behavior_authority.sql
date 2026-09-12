BEGIN;

DO $$ BEGIN
  IF NOT control.is_global_kill_switch_active()
    OR NOT control.external_actions_blocked()
    OR (SELECT count(*) FROM control.kill_switches
        WHERE scope='channel' AND active AND scope_id=ANY(ARRAY[
          'email','whatsapp','calendar','web_chat','telephone','crm','public_web'
        ]))<>7
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control WHERE claiming_enabled)
    OR EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE status='leased' OR usage_budget_state='held_uncertain')
    OR EXISTS(SELECT 1 FROM integration.crm_outbox WHERE status IN('pending','leased','outcome_unknown'))
  THEN RAISE EXCEPTION 'A0_BEHAVIOR_AUTHORITY_MIGRATION_REQUIRES_CONTAINMENT'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commercial_a0_behavior_ledger') THEN
    CREATE ROLE commercial_a0_behavior_ledger NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF EXISTS(
    SELECT 1 FROM pg_roles WHERE rolname='commercial_a0_behavior_ledger'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) OR EXISTS(
    SELECT 1 FROM pg_auth_members
    WHERE member=(SELECT oid FROM pg_roles WHERE rolname='commercial_a0_behavior_ledger')
  ) THEN RAISE EXCEPTION 'UNSAFE_A0_BEHAVIOR_LEDGER_CAPABILITY'; END IF;
END $$;

-- One registry prevents a provider usage receipt from being consumed once by
-- A1 and again by A0. It is derived from, but does not replace, either ledger.
CREATE TABLE control.usage_record_registry(
  usage_record_id text PRIMARY KEY CHECK(
    length(usage_record_id) BETWEEN 1 AND 256
    AND usage_record_id~'^[A-Za-z0-9._:-]+$'
  ),
  authority text NOT NULL CHECK(authority IN('a0_behavior','a1_dispatch')),
  run_id uuid,
  batch_id text,
  job_id uuid,
  budget_version bigint,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(
    (authority='a0_behavior' AND run_id IS NOT NULL AND batch_id IS NOT NULL
      AND job_id IS NULL AND budget_version IS NULL)
    OR
    (authority='a1_dispatch' AND run_id IS NULL AND batch_id IS NULL
      AND job_id IS NOT NULL AND budget_version>0)
  )
);
CREATE TRIGGER usage_record_registry_immutable
BEFORE UPDATE OR DELETE ON control.usage_record_registry
FOR EACH STATEMENT EXECUTE FUNCTION control.reject_audit_event_mutation();

DO $$ BEGIN
  IF EXISTS(
    SELECT usage_record_id FROM control.dispatch_settlement_receipts
    GROUP BY usage_record_id HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'SHARED_USAGE_RECORD_HISTORY_CONFLICT'; END IF;
END $$;
INSERT INTO control.usage_record_registry(
  usage_record_id,authority,job_id,budget_version,recorded_at
)
SELECT usage_record_id,'a1_dispatch',job_id,budget_version,created_at
FROM control.dispatch_settlement_receipts;

CREATE TABLE control.a0_behavior_batch_ledger(
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL CHECK(idempotency_key~'^a0:[a-f0-9]{64}:[a-f0-9]{64}$'),
  source_plan_sha256 text NOT NULL CHECK(source_plan_sha256~'^[a-f0-9]{64}$'),
  run_id uuid NOT NULL,
  batch_id text NOT NULL CHECK(
    batch_id~*'^a0:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:t(0[1-9]|1[0-6])$'
  ),
  batch_sha256 text NOT NULL CHECK(batch_sha256~'^[a-f0-9]{64}$'),
  reservation_micro_cents bigint NOT NULL CHECK(reservation_micro_cents=6000000),
  version bigint NOT NULL CHECK(version IN(1,2)),
  state text NOT NULL CHECK(state IN('reserved','settled','budget_exceeded','held_unknown')),
  usage_value_micro_cents bigint CHECK(usage_value_micro_cents BETWEEN 1 AND 9007199254740991),
  usage_record_id text,
  unknown_reason text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(idempotency_key,version),
  UNIQUE(run_id,batch_id,version),
  CHECK(idempotency_key='a0:'||source_plan_sha256||':'||batch_sha256),
  CHECK(lower(batch_id) LIKE 'a0:'||run_id::text||':t%'),
  CHECK(
    (version=1 AND state='reserved' AND usage_value_micro_cents IS NULL
      AND usage_record_id IS NULL AND unknown_reason IS NULL)
    OR
    (version=2 AND state IN('settled','budget_exceeded')
      AND usage_value_micro_cents IS NOT NULL AND usage_record_id IS NOT NULL
      AND unknown_reason IS NULL
      AND (state='budget_exceeded')=(usage_value_micro_cents>reservation_micro_cents))
    OR
    (version=2 AND state='held_unknown' AND usage_value_micro_cents IS NULL
      AND usage_record_id IS NULL AND unknown_reason='A0_USAGE_UNKNOWN')
  )
);
CREATE TRIGGER a0_behavior_batch_ledger_immutable
BEFORE UPDATE OR DELETE ON control.a0_behavior_batch_ledger
FOR EACH STATEMENT EXECUTE FUNCTION control.reject_audit_event_mutation();

CREATE FUNCTION control.reserve_a0_behavior_batch(text,uuid,text,text,bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  source_sha text:=split_part($1,':',2);
  existing control.a0_behavior_batch_ledger%ROWTYPE;
  committed bigint;
BEGIN
  IF $1!~'^a0:[a-f0-9]{64}:[a-f0-9]{64}$'
    OR $4!~'^[a-f0-9]{64}$' OR split_part($1,':',3) IS DISTINCT FROM $4
    OR $3!~*'^a0:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:t(0[1-9]|1[0-6])$'
    OR lower($3) NOT LIKE 'a0:'||$2::text||':t%' OR $5<>6000000
  THEN RAISE EXCEPTION 'A0_RESERVATION_INPUT_INVALID'; END IF;

  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('a0:'||$2::text));
  IF NOT control.is_global_kill_switch_active()
    OR NOT control.external_actions_blocked()
    OR (SELECT count(*) FROM control.kill_switches
        WHERE scope='channel' AND active AND scope_id=ANY(ARRAY[
          'email','whatsapp','calendar','web_chat','telephone','crm','public_web'
        ]))<>7
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control WHERE claiming_enabled)
    OR EXISTS(SELECT 1 FROM integration.crm_outbox WHERE status IN('pending','leased','outcome_unknown'))
  THEN RAISE EXCEPTION 'A0_RESERVATION_REQUIRES_CONTAINMENT'; END IF;

  IF EXISTS(
    SELECT 1 FROM control.a0_behavior_batch_ledger
    WHERE (idempotency_key=$1 OR (run_id=$2 AND batch_id=$3))
      AND (idempotency_key IS DISTINCT FROM $1 OR run_id IS DISTINCT FROM $2
        OR batch_id IS DISTINCT FROM $3 OR batch_sha256 IS DISTINCT FROM $4
        OR reservation_micro_cents IS DISTINCT FROM $5)
  ) THEN RAISE EXCEPTION 'A0_RESERVATION_IMMUTABLE_CONFLICT'; END IF;
  SELECT * INTO existing FROM control.a0_behavior_batch_ledger
  WHERE idempotency_key=$1 AND run_id=$2 AND batch_id=$3
  ORDER BY version DESC LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object(
    'disposition','replayed','state',existing.state,'version',existing.version
  ); END IF;

  IF EXISTS(
    SELECT 1 FROM control.a0_behavior_batch_ledger
    WHERE run_id=$2 AND source_plan_sha256<>source_sha
  ) THEN RAISE EXCEPTION 'A0_RUN_PLAN_IMMUTABLE_CONFLICT'; END IF;
  IF (SELECT count(*) FROM control.a0_behavior_batch_ledger WHERE run_id=$2 AND version=1)>=16
  THEN RETURN jsonb_build_object('disposition','denied','reason','batch_limit'); END IF;
  SELECT coalesce(sum(CASE
    WHEN latest.state IN('settled','budget_exceeded') THEN latest.usage_value_micro_cents
    ELSE latest.reservation_micro_cents END),0)::bigint INTO committed
  FROM (
    SELECT DISTINCT ON(batch_id) * FROM control.a0_behavior_batch_ledger
    WHERE run_id=$2 ORDER BY batch_id,version DESC
  ) latest;
  IF committed+$5>96000000
  THEN RETURN jsonb_build_object('disposition','denied','reason','activation_limit'); END IF;

  INSERT INTO control.a0_behavior_batch_ledger(
    idempotency_key,source_plan_sha256,run_id,batch_id,batch_sha256,
    reservation_micro_cents,version,state
  ) VALUES($1,source_sha,$2,$3,$4,$5,1,'reserved');
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a0_behavior_batch_reserved','run_id',$2,'batch_id',$3,
    'batch_sha256',$4,'reservation_micro_cents',$5,'external_action',false,
    'recorded_at',clock_timestamp()
  ));
  RETURN jsonb_build_object('disposition','created','state','reserved','version',1);
END $$;

CREATE FUNCTION control.settle_a0_behavior_batch(uuid,text,bigint,bigint,text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  reserved control.a0_behavior_batch_ledger%ROWTYPE;
  terminal control.a0_behavior_batch_ledger%ROWTYPE;
  registered control.usage_record_registry%ROWTYPE;
  target text;
BEGIN
  IF $2!~*'^a0:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:t(0[1-9]|1[0-6])$'
    OR lower($2) NOT LIKE 'a0:'||$1::text||':t%' OR $3<>1
    OR $4 NOT BETWEEN 1 AND 9007199254740991
    OR length($5) NOT BETWEEN 1 AND 200 OR $5!~'^[A-Za-z0-9._:-]+$'
  THEN RAISE EXCEPTION 'A0_SETTLEMENT_INPUT_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('a0:'||$1::text));
  SELECT * INTO reserved FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 AND version=1;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO terminal FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 AND version=2;
  IF FOUND THEN RETURN terminal.state IN('settled','budget_exceeded')
    AND terminal.usage_value_micro_cents=$4 AND terminal.usage_record_id=$5;
  END IF;

  INSERT INTO control.usage_record_registry(
    usage_record_id,authority,run_id,batch_id
  ) VALUES($5,'a0_behavior',$1,$2) ON CONFLICT(usage_record_id) DO NOTHING;
  SELECT * INTO registered FROM control.usage_record_registry WHERE usage_record_id=$5;
  IF registered.authority IS DISTINCT FROM 'a0_behavior'
    OR registered.run_id IS DISTINCT FROM $1 OR registered.batch_id IS DISTINCT FROM $2
  THEN RAISE EXCEPTION 'SHARED_USAGE_RECORD_CONFLICT'; END IF;

  target:=CASE WHEN $4>reserved.reservation_micro_cents
    THEN 'budget_exceeded' ELSE 'settled' END;
  INSERT INTO control.a0_behavior_batch_ledger(
    idempotency_key,source_plan_sha256,run_id,batch_id,batch_sha256,
    reservation_micro_cents,version,state,usage_value_micro_cents,usage_record_id
  ) VALUES(
    reserved.idempotency_key,reserved.source_plan_sha256,reserved.run_id,
    reserved.batch_id,reserved.batch_sha256,reserved.reservation_micro_cents,
    2,target,$4,$5
  );
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a0_behavior_batch_settled','run_id',$1,'batch_id',$2,
    'state',target,'usage_value_micro_cents',$4,
    'reservation_micro_cents',reserved.reservation_micro_cents,
    'external_action',false,'recorded_at',clock_timestamp()
  ));
  RETURN true;
END $$;

CREATE FUNCTION control.hold_a0_behavior_batch_unknown(uuid,text,bigint,text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  reserved control.a0_behavior_batch_ledger%ROWTYPE;
  terminal control.a0_behavior_batch_ledger%ROWTYPE;
BEGIN
  IF $2!~*'^a0:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:t(0[1-9]|1[0-6])$'
    OR lower($2) NOT LIKE 'a0:'||$1::text||':t%' OR $3<>1 OR $4<>'A0_USAGE_UNKNOWN'
  THEN RAISE EXCEPTION 'A0_HOLD_INPUT_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('a0:'||$1::text));
  SELECT * INTO reserved FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 AND version=1;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO terminal FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 AND version=2;
  IF FOUND THEN RETURN terminal.state='held_unknown' AND terminal.unknown_reason=$4; END IF;
  INSERT INTO control.a0_behavior_batch_ledger(
    idempotency_key,source_plan_sha256,run_id,batch_id,batch_sha256,
    reservation_micro_cents,version,state,unknown_reason
  ) VALUES(
    reserved.idempotency_key,reserved.source_plan_sha256,reserved.run_id,
    reserved.batch_id,reserved.batch_sha256,reserved.reservation_micro_cents,
    2,'held_unknown',$4
  );
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a0_behavior_batch_usage_held','run_id',$1,'batch_id',$2,
    'reason',$4,'reservation_micro_cents',reserved.reservation_micro_cents,
    'external_action',false,'recorded_at',clock_timestamp()
  ));
  RETURN true;
END $$;

-- Extend the existing A1 settlement boundary so all future A1 receipts enter
-- the same registry. The original function is retained verbatim for rollback.
ALTER FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
RENAME TO legacy_038_stage_dispatch_settlement;
REVOKE ALL ON FUNCTION control.legacy_038_stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;

CREATE FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  receipt uuid;
  registered control.usage_record_registry%ROWTYPE;
BEGIN
  receipt:=control.legacy_038_stage_dispatch_settlement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);
  INSERT INTO control.usage_record_registry(
    usage_record_id,authority,job_id,budget_version
  ) VALUES($6,'a1_dispatch',$1,$8) ON CONFLICT(usage_record_id) DO NOTHING;
  SELECT * INTO registered FROM control.usage_record_registry WHERE usage_record_id=$6;
  IF registered.authority IS DISTINCT FROM 'a1_dispatch'
    OR registered.job_id IS DISTINCT FROM $1 OR registered.budget_version IS DISTINCT FROM $8
  THEN RAISE EXCEPTION 'SHARED_USAGE_RECORD_CONFLICT'; END IF;
  RETURN receipt;
END $$;

REVOKE ALL ON control.a0_behavior_batch_ledger,control.usage_record_registry
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_a1_supervisor,
  commercial_a1_chain_runner,commercial_a0_behavior_ledger;
REVOKE ALL ON FUNCTION control.reserve_a0_behavior_batch(text,uuid,text,text,bigint),
  control.settle_a0_behavior_batch(uuid,text,bigint,bigint,text),
  control.hold_a0_behavior_batch_unknown(uuid,text,bigint,text)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_a1_supervisor,
  commercial_a1_chain_runner,commercial_a0_behavior_ledger;
REVOKE ALL ON FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;
GRANT EXECUTE ON FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
TO commercial_runtime;
GRANT USAGE ON SCHEMA control TO commercial_a0_behavior_ledger;
GRANT EXECUTE ON FUNCTION control.reserve_a0_behavior_batch(text,uuid,text,text,bigint),
  control.settle_a0_behavior_batch(uuid,text,bigint,bigint,text),
  control.hold_a0_behavior_batch_unknown(uuid,text,bigint,text)
TO commercial_a0_behavior_ledger;

COMMIT;
