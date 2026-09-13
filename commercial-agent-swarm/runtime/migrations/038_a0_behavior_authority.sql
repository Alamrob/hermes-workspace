BEGIN;

DO $$ BEGIN
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  PERFORM control_id FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
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
  provider_id text NOT NULL CHECK(provider_id='opencode-go'),
  usage_record_id text NOT NULL CHECK(
    length(usage_record_id) BETWEEN 1 AND 256
    AND usage_record_id~'^[A-Za-z0-9._:-]+$'
  ),
  authority text NOT NULL CHECK(authority IN('a0_behavior','a1_dispatch')),
  usage_value_micro_cents bigint NOT NULL CHECK(usage_value_micro_cents BETWEEN 1 AND 9007199254740991),
  usage_fingerprint_sha256 text NOT NULL CHECK(usage_fingerprint_sha256~'^[a-f0-9]{64}$'),
  run_id uuid,
  batch_id text,
  job_id uuid,
  budget_version bigint,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(provider_id,usage_record_id),
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
  provider_id,usage_record_id,authority,usage_value_micro_cents,
  usage_fingerprint_sha256,job_id,budget_version,recorded_at
)
SELECT 'opencode-go',usage_record_id,'a1_dispatch',usage_value_micro_cents,
  encode(sha256(convert_to(jsonb_build_array(
    'opencode-go',usage_record_id,usage_value_micro_cents,
    'a1_dispatch',job_id,budget_version
  )::text,'UTF8')),'hex'),job_id,budget_version,created_at
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
  task_contract jsonb NOT NULL CHECK(
    jsonb_typeof(task_contract)='array' AND jsonb_array_length(task_contract)=6
  ),
  task_contract_sha256 text NOT NULL CHECK(task_contract_sha256~'^[a-f0-9]{64}$'),
  reservation_micro_cents bigint NOT NULL CHECK(reservation_micro_cents=6000000),
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL CHECK(version IN(1,2,3)),
  state text NOT NULL CHECK(state IN('reserved','settled','budget_exceeded','held_unknown')),
  usage_value_micro_cents bigint CHECK(usage_value_micro_cents BETWEEN 1 AND 9007199254740991),
  usage_records jsonb,
  usage_receipt_set_sha256 text CHECK(
    usage_receipt_set_sha256 IS NULL OR usage_receipt_set_sha256~'^[a-f0-9]{64}$'
  ),
  unknown_reason text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(idempotency_key,version),
  UNIQUE(run_id,batch_id,version),
  CHECK(idempotency_key='a0:'||source_plan_sha256||':'||batch_sha256),
  CHECK(lower(batch_id) LIKE 'a0:'||run_id::text||':t%'),
  CHECK(
    (version=1 AND state='reserved' AND expires_at>recorded_at
      AND usage_value_micro_cents IS NULL
      AND usage_records IS NULL AND usage_receipt_set_sha256 IS NULL
      AND unknown_reason IS NULL)
    OR
    (version IN(2,3) AND state IN('settled','budget_exceeded')
      AND usage_value_micro_cents IS NOT NULL
      AND usage_records IS NOT NULL
      AND jsonb_typeof(usage_records)='array'
      AND jsonb_array_length(usage_records)=6
      AND usage_receipt_set_sha256 IS NOT NULL
      AND unknown_reason IS NULL
      AND (state='budget_exceeded')=(usage_value_micro_cents>reservation_micro_cents))
    OR
    (version=2 AND state='held_unknown' AND usage_value_micro_cents IS NULL
      AND usage_records IS NULL AND usage_receipt_set_sha256 IS NULL
      AND unknown_reason IN(
        'A0_USAGE_UNKNOWN','A0_RESERVATION_EXPIRED_USAGE_UNKNOWN'
      ))
  )
);
CREATE TRIGGER a0_behavior_batch_ledger_immutable
BEFORE UPDATE OR DELETE ON control.a0_behavior_batch_ledger
FOR EACH STATEMENT EXECUTE FUNCTION control.reject_audit_event_mutation();

CREATE TABLE control.a0_behavior_execution_permits(
  run_id uuid NOT NULL,
  batch_id text NOT NULL,
  reservation_version bigint NOT NULL CHECK(reservation_version=1),
  expires_at timestamptz NOT NULL,
  window_id uuid NOT NULL DEFAULT gen_random_uuid(),
  epoch_id uuid NOT NULL DEFAULT gen_random_uuid(),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(run_id,batch_id,reservation_version),
  FOREIGN KEY(run_id,batch_id,reservation_version)
    REFERENCES control.a0_behavior_batch_ledger(run_id,batch_id,version),
  CHECK(acquired_at<expires_at)
);
CREATE TRIGGER a0_behavior_execution_permits_immutable
BEFORE UPDATE OR DELETE ON control.a0_behavior_execution_permits
FOR EACH STATEMENT EXECUTE FUNCTION control.reject_audit_event_mutation();

CREATE FUNCTION control.expire_a0_behavior_reservations() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  reserved control.a0_behavior_batch_ledger%ROWTYPE;
  expired_count integer:=0;
  now_at timestamptz;
BEGIN
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  PERFORM control_id FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
  now_at:=clock_timestamp();
  FOR reserved IN
    SELECT original.* FROM control.a0_behavior_batch_ledger original
    WHERE original.version=1 AND original.state='reserved'
      AND original.expires_at<=now_at
      AND NOT EXISTS(
        SELECT 1 FROM control.a0_behavior_batch_ledger terminal
        WHERE terminal.run_id=original.run_id
          AND terminal.batch_id=original.batch_id AND terminal.version>1
      )
    ORDER BY original.run_id,original.batch_id
  LOOP
    INSERT INTO control.a0_behavior_batch_ledger(
      idempotency_key,source_plan_sha256,run_id,batch_id,batch_sha256,
      task_contract,task_contract_sha256,
      reservation_micro_cents,expires_at,version,state,unknown_reason
    ) VALUES(
      reserved.idempotency_key,reserved.source_plan_sha256,reserved.run_id,
      reserved.batch_id,reserved.batch_sha256,reserved.task_contract,
      reserved.task_contract_sha256,reserved.reservation_micro_cents,
      reserved.expires_at,2,'held_unknown','A0_RESERVATION_EXPIRED_USAGE_UNKNOWN'
    ) ON CONFLICT(run_id,batch_id,version) DO NOTHING;
    IF FOUND THEN
      expired_count:=expired_count+1;
      INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
        'event','a0_behavior_batch_expired_unknown','run_id',reserved.run_id,
        'batch_id',reserved.batch_id,'reservation_micro_cents',reserved.reservation_micro_cents,
        'reason','A0_RESERVATION_EXPIRED_USAGE_UNKNOWN','external_action',false,
        'recorded_at',now_at
      ));
    END IF;
  END LOOP;
  IF expired_count>0 THEN
    UPDATE control.usage_budget_control SET quarantined=true,
      quarantine_reason='A0_RESERVATION_EXPIRED_USAGE_UNKNOWN',updated_at=now_at
    WHERE control_id=1;
  END IF;
  RETURN expired_count;
END $$;

CREATE FUNCTION control.reserve_a0_behavior_batch(text,uuid,text,text,bigint,timestamptz,jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  source_sha text:=split_part($1,':',2);
  existing control.a0_behavior_batch_ledger%ROWTYPE;
  guard control.usage_budget_control%ROWTYPE;
  plan_committed bigint;
  a0_committed bigint;
  a1_committed bigint;
  task_entry jsonb;
  task_index integer:=0;
  task_contract_sha text;
  expected_profiles text[]:=ARRAY[
    'sales-orchestrator','market-account-intelligence','contact-data-steward',
    'qualification-prioritization','outreach-draft-manager','commercial-qa-compliance'
  ];
BEGIN
  IF $1!~'^a0:[a-f0-9]{64}:[a-f0-9]{64}$'
    OR $4!~'^[a-f0-9]{64}$' OR split_part($1,':',3) IS DISTINCT FROM $4
    OR $3!~*'^a0:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:t(0[1-9]|1[0-6])$'
    OR lower($3) NOT LIKE 'a0:'||$2::text||':t%' OR $5<>6000000
    OR $6>clock_timestamp()+interval '30 minutes'
    OR $7 IS NULL OR jsonb_typeof($7)<>'array' OR jsonb_array_length($7)<>6
  THEN RAISE EXCEPTION 'A0_RESERVATION_INPUT_INVALID'; END IF;
  FOR task_entry IN SELECT value FROM jsonb_array_elements($7) LOOP
    task_index:=task_index+1;
    IF jsonb_typeof(task_entry)<>'object'
      OR (SELECT count(*) FROM jsonb_object_keys(task_entry))<>10
      OR NOT task_entry ?& ARRAY[
        'sequence','task_id','fixture_id','agent_id','critical','expected_status','fixture_sha256',
        'maximum_tokens','maximum_model_calls','reservation_micro_cents'
      ]
      OR task_entry->>'sequence'<>task_index::text
      OR task_entry->>'task_id'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR task_entry->>'fixture_id'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR task_entry->>'agent_id'<>expected_profiles[task_index]
      OR jsonb_typeof(task_entry->'critical')<>'boolean'
      OR task_entry->>'expected_status' NOT IN('completed','blocked_or_partial','approval_required')
      OR task_entry->>'fixture_sha256'!~'^[a-f0-9]{64}$'
      OR task_entry->>'maximum_tokens'<>'4096'
      OR task_entry->>'maximum_model_calls'<>'1'
      OR task_entry->>'reservation_micro_cents'<>'1000000'
    THEN RAISE EXCEPTION 'A0_TASK_CONTRACT_INVALID'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT item->>'task_id') FROM jsonb_array_elements($7) item)<>6
    OR (SELECT count(DISTINCT item->>'fixture_id') FROM jsonb_array_elements($7) item)<>6
  THEN RAISE EXCEPTION 'A0_TASK_CONTRACT_INVALID'; END IF;
  task_contract_sha:=encode(sha256(convert_to($7::text,'UTF8')),'hex');

  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  SELECT * INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('a0:'||$2::text));
  PERFORM control.expire_a0_behavior_reservations();
  SELECT * INTO guard FROM control.usage_budget_control WHERE control_id=1;
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
        OR reservation_micro_cents IS DISTINCT FROM $5
        OR task_contract IS DISTINCT FROM $7
        OR task_contract_sha256 IS DISTINCT FROM task_contract_sha
        OR expires_at IS DISTINCT FROM $6)
  ) THEN RAISE EXCEPTION 'A0_RESERVATION_IMMUTABLE_CONFLICT'; END IF;
  SELECT * INTO existing FROM control.a0_behavior_batch_ledger
  WHERE idempotency_key=$1 AND run_id=$2 AND batch_id=$3
  ORDER BY version DESC LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object(
    'disposition','replayed','state',existing.state,'version',existing.version
  ); END IF;

  IF $6<=clock_timestamp()
  THEN RETURN jsonb_build_object('disposition','denied','reason','expired'); END IF;

  IF guard.control_id IS NULL
    OR guard.activation_ceiling_micro_cents<>1000000000
    OR guard.quarantined OR guard.probe_worker IS NOT NULL
  THEN RETURN jsonb_build_object('disposition','denied','reason','shared_quarantine'); END IF;
  IF EXISTS(
    SELECT 1 FROM control.a0_behavior_batch_ledger active
    WHERE active.version IN(1,2) AND active.state IN('reserved','held_unknown')
      AND NOT EXISTS(
        SELECT 1 FROM control.a0_behavior_batch_ledger later
        WHERE later.run_id=active.run_id AND later.batch_id=active.batch_id
          AND later.version>active.version
      )
  ) THEN RETURN jsonb_build_object('disposition','denied','reason','active_attempt'); END IF;
  IF EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE usage_budget_state='reserved')
  THEN RETURN jsonb_build_object('disposition','denied','reason','a1_active'); END IF;

  IF EXISTS(
    SELECT 1 FROM control.a0_behavior_batch_ledger
    WHERE run_id=$2 AND source_plan_sha256<>source_sha
  ) THEN RAISE EXCEPTION 'A0_RUN_PLAN_IMMUTABLE_CONFLICT'; END IF;
  IF (SELECT count(*) FROM control.a0_behavior_batch_ledger WHERE run_id=$2 AND version=1)>=16
  THEN RETURN jsonb_build_object('disposition','denied','reason','batch_limit'); END IF;
  SELECT coalesce(sum(CASE
    WHEN latest.state IN('settled','budget_exceeded') THEN latest.usage_value_micro_cents
    ELSE latest.reservation_micro_cents END),0)::bigint INTO plan_committed
  FROM (
    SELECT DISTINCT ON(batch_id) * FROM control.a0_behavior_batch_ledger
    WHERE run_id=$2 ORDER BY batch_id,version DESC
  ) latest;
  IF plan_committed+$5>96000000
  THEN RETURN jsonb_build_object('disposition','denied','reason','plan_limit'); END IF;
  SELECT coalesce(sum(CASE
    WHEN latest.state IN('settled','budget_exceeded') THEN latest.usage_value_micro_cents
    ELSE latest.reservation_micro_cents END),0)::bigint INTO a0_committed
  FROM (
    SELECT DISTINCT ON(run_id,batch_id) * FROM control.a0_behavior_batch_ledger
    ORDER BY run_id,batch_id,version DESC
  ) latest;
  SELECT coalesce(sum(CASE usage_budget_state
    WHEN 'settled' THEN usage_value_actual_micro_cents
    WHEN 'reserved' THEN usage_value_reservation_micro_cents
    WHEN 'held_uncertain' THEN usage_value_reservation_micro_cents ELSE 0 END),0)::bigint
  INTO a1_committed FROM control.dispatch_jobs;
  IF a0_committed+a1_committed+$5>guard.activation_ceiling_micro_cents
  THEN RETURN jsonb_build_object('disposition','denied','reason','activation_limit'); END IF;

  INSERT INTO control.a0_behavior_batch_ledger(
    idempotency_key,source_plan_sha256,run_id,batch_id,batch_sha256,
    task_contract,task_contract_sha256,reservation_micro_cents,expires_at,version,state
  ) VALUES($1,source_sha,$2,$3,$4,$7,task_contract_sha,$5,$6,1,'reserved');
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a0_behavior_batch_reserved','run_id',$2,'batch_id',$3,
    'batch_sha256',$4,'reservation_micro_cents',$5,'expires_at',$6,'external_action',false,
    'recorded_at',clock_timestamp()
  ));
  RETURN jsonb_build_object('disposition','created','state','reserved','version',1);
END $$;

CREATE FUNCTION control.get_a0_behavior_task_execution_permit(uuid,text,bigint,uuid,text,text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  reserved control.a0_behavior_batch_ledger%ROWTYPE;
  permit control.a0_behavior_execution_permits%ROWTYPE;
  task_entry jsonb;
  remaining_ms bigint;
BEGIN
  IF $6<>'a0-manual-runner-1' OR NOT control.acquire_a0_behavior_execution_permit($1,$2,$3)
  THEN RETURN NULL; END IF;
  SELECT * INTO reserved FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 AND version=$3;
  SELECT value INTO task_entry FROM jsonb_array_elements(reserved.task_contract)
  WHERE value->>'task_id'=$4::text AND value->>'agent_id'=$5;
  IF task_entry IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO permit FROM control.a0_behavior_execution_permits
  WHERE run_id=$1 AND batch_id=$2 AND reservation_version=$3;
  remaining_ms:=floor(extract(epoch FROM (least(reserved.expires_at,clock_timestamp()+interval '5 seconds')-clock_timestamp()))*1000);
  IF remaining_ms<1 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'allowed',true,'job_id',$4,'mission_id',$1,'worker_id',$6,
    'window_id',permit.window_id,'epoch_id',permit.epoch_id,
    'budget_version',$3,'valid_for_ms',least(5000,remaining_ms)
  );
END $$;

CREATE FUNCTION control.get_a0_behavior_usage_budget_state(uuid,text,bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  a0_committed bigint;
  a1_committed bigint;
BEGIN
  IF NOT control.acquire_a0_behavior_execution_permit($1,$2,$3)
  THEN RETURN NULL; END IF;
  SELECT coalesce(sum(CASE
    WHEN latest.state IN('settled','budget_exceeded') THEN latest.usage_value_micro_cents
    ELSE latest.reservation_micro_cents END),0)::bigint INTO a0_committed
  FROM (
    SELECT DISTINCT ON(run_id,batch_id) * FROM control.a0_behavior_batch_ledger
    WHERE NOT(run_id=$1 AND batch_id=$2)
    ORDER BY run_id,batch_id,version DESC
  ) latest;
  SELECT coalesce(sum(CASE usage_budget_state
    WHEN 'settled' THEN usage_value_actual_micro_cents
    WHEN 'reserved' THEN usage_value_reservation_micro_cents
    WHEN 'held_uncertain' THEN usage_value_reservation_micro_cents ELSE 0 END),0)::bigint
  INTO a1_committed FROM control.dispatch_jobs;
  RETURN jsonb_build_object(
    'total_committed_excluding_batch_micro_cents',a0_committed+a1_committed
  );
END $$;

CREATE FUNCTION control.acquire_a0_behavior_execution_permit(uuid,text,bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  reserved control.a0_behavior_batch_ledger%ROWTYPE;
  latest control.a0_behavior_batch_ledger%ROWTYPE;
  guard control.usage_budget_control%ROWTYPE;
BEGIN
  IF $2!~*'^a0:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:t(0[1-9]|1[0-6])$'
    OR lower($2) NOT LIKE 'a0:'||$1::text||':t%' OR $3<>1
  THEN RAISE EXCEPTION 'A0_EXECUTION_PERMIT_INPUT_INVALID'; END IF;
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  SELECT * INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('a0:'||$1::text));
  PERFORM control.expire_a0_behavior_reservations();
  SELECT * INTO guard FROM control.usage_budget_control WHERE control_id=1;
  SELECT * INTO reserved FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 AND version=1;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO latest FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 ORDER BY version DESC LIMIT 1;
  IF latest.version<>1 OR latest.state<>'reserved' OR reserved.expires_at<=clock_timestamp()
    OR guard.control_id IS NULL OR guard.activation_ceiling_micro_cents<>1000000000
    OR guard.quarantined OR guard.probe_worker IS NOT NULL
    OR NOT control.is_global_kill_switch_active()
    OR NOT control.external_actions_blocked()
    OR (SELECT count(*) FROM control.kill_switches
        WHERE scope='channel' AND active AND scope_id=ANY(ARRAY[
          'email','whatsapp','calendar','web_chat','telephone','crm','public_web'
        ]))<>7
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control WHERE claiming_enabled)
    OR EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE usage_budget_state='reserved')
    OR EXISTS(SELECT 1 FROM integration.crm_outbox WHERE status IN('pending','leased','outcome_unknown'))
  THEN RETURN false; END IF;
  INSERT INTO control.a0_behavior_execution_permits(
    run_id,batch_id,reservation_version,expires_at
  ) VALUES($1,$2,$3,reserved.expires_at)
  ON CONFLICT(run_id,batch_id,reservation_version) DO NOTHING;
  RETURN true;
END $$;

CREATE FUNCTION control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  reserved control.a0_behavior_batch_ledger%ROWTYPE;
  terminal control.a0_behavior_batch_ledger%ROWTYPE;
  registered control.usage_record_registry%ROWTYPE;
  usage_entry jsonb;
  record_id text;
  record_value bigint;
  seen_ids text[]:='{}'::text[];
  receipt_count integer:=0;
  receipt_sum numeric:=0;
  canonical_records jsonb;
  receipt_set_sha256 text;
  fingerprint text;
  target text;
  next_version bigint:=2;
  superseded_state text;
BEGIN
  IF $2!~*'^a0:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:t(0[1-9]|1[0-6])$'
    OR lower($2) NOT LIKE 'a0:'||$1::text||':t%' OR $3<>1
    OR $4 NOT BETWEEN 1 AND 9007199254740991
    OR $5 IS NULL OR jsonb_typeof($5)<>'array' OR jsonb_array_length($5)<>6
  THEN RAISE EXCEPTION 'A0_SETTLEMENT_INPUT_INVALID'; END IF;
  FOR usage_entry IN SELECT value FROM jsonb_array_elements($5)
  LOOP
    IF jsonb_typeof(usage_entry)<>'object'
      OR (SELECT count(*) FROM jsonb_object_keys(usage_entry))<>2
      OR NOT usage_entry?'usage_record_id'
      OR NOT usage_entry?'usage_value_micro_cents'
      OR jsonb_typeof(usage_entry->'usage_record_id')<>'string'
      OR jsonb_typeof(usage_entry->'usage_value_micro_cents')<>'number'
      OR length(usage_entry->>'usage_record_id') NOT BETWEEN 1 AND 200
      OR usage_entry->>'usage_record_id'!~'^[A-Za-z0-9._:-]+$'
      OR usage_entry->>'usage_value_micro_cents'!~'^[1-9][0-9]{0,15}$'
    THEN RAISE EXCEPTION 'A0_SETTLEMENT_INPUT_INVALID'; END IF;
    record_id:=usage_entry->>'usage_record_id';
    record_value:=(usage_entry->>'usage_value_micro_cents')::bigint;
    IF record_value>9007199254740991 OR record_id=ANY(seen_ids)
    THEN RAISE EXCEPTION 'A0_SETTLEMENT_INPUT_INVALID'; END IF;
    seen_ids:=array_append(seen_ids,record_id);
    receipt_count:=receipt_count+1;
    receipt_sum:=receipt_sum+record_value;
  END LOOP;
  IF receipt_count<>6 OR receipt_sum<>$4
  THEN RAISE EXCEPTION 'A0_SETTLEMENT_INPUT_INVALID'; END IF;
  SELECT jsonb_agg(jsonb_build_object(
    'usage_record_id',entry->>'usage_record_id',
    'usage_value_micro_cents',(entry->>'usage_value_micro_cents')::bigint
  ) ORDER BY entry->>'usage_record_id') INTO canonical_records
  FROM jsonb_array_elements($5) AS records(entry);
  receipt_set_sha256:=encode(sha256(convert_to(jsonb_build_array(
    'opencode-go',canonical_records,$4,'a0_behavior',$1,$2,$3
  )::text,'UTF8')),'hex');
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  PERFORM control_id FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('a0:'||$1::text));
  PERFORM control.expire_a0_behavior_reservations();
  SELECT * INTO reserved FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 AND version=1;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM control.a0_behavior_execution_permits
    WHERE run_id=$1 AND batch_id=$2 AND reservation_version=$3
  ) THEN RETURN false; END IF;
  SELECT * INTO terminal FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 AND version>1
  ORDER BY version DESC LIMIT 1;
  IF FOUND AND terminal.state IN('settled','budget_exceeded') THEN
    IF terminal.usage_value_micro_cents IS DISTINCT FROM $4
      OR terminal.usage_records IS DISTINCT FROM canonical_records
      OR terminal.usage_receipt_set_sha256 IS DISTINCT FROM receipt_set_sha256
    THEN RETURN false; END IF;
    FOR usage_entry IN SELECT value FROM jsonb_array_elements(canonical_records)
    LOOP
      record_id:=usage_entry->>'usage_record_id';
      record_value:=(usage_entry->>'usage_value_micro_cents')::bigint;
      fingerprint:=encode(sha256(convert_to(jsonb_build_array(
        'opencode-go',record_id,record_value,'a0_behavior',$1,$2,$3
      )::text,'UTF8')),'hex');
      SELECT * INTO registered FROM control.usage_record_registry
      WHERE provider_id='opencode-go' AND usage_record_id=record_id;
      IF NOT FOUND OR registered.authority IS DISTINCT FROM 'a0_behavior'
        OR registered.usage_value_micro_cents IS DISTINCT FROM record_value
        OR registered.usage_fingerprint_sha256 IS DISTINCT FROM fingerprint
        OR registered.run_id IS DISTINCT FROM $1 OR registered.batch_id IS DISTINCT FROM $2
      THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  ELSIF FOUND THEN
    IF terminal.version<>2 OR terminal.state<>'held_unknown'
      OR terminal.unknown_reason<>'A0_RESERVATION_EXPIRED_USAGE_UNKNOWN'
    THEN RETURN false; END IF;
    next_version:=3;superseded_state:=terminal.state;
  END IF;
  FOR usage_entry IN SELECT value FROM jsonb_array_elements(canonical_records)
  LOOP
    record_id:=usage_entry->>'usage_record_id';
    record_value:=(usage_entry->>'usage_value_micro_cents')::bigint;
    fingerprint:=encode(sha256(convert_to(jsonb_build_array(
      'opencode-go',record_id,record_value,'a0_behavior',$1,$2,$3
    )::text,'UTF8')),'hex');
    INSERT INTO control.usage_record_registry(
      provider_id,usage_record_id,authority,usage_value_micro_cents,
      usage_fingerprint_sha256,run_id,batch_id
    ) VALUES(
      'opencode-go',record_id,'a0_behavior',record_value,fingerprint,$1,$2
    ) ON CONFLICT(provider_id,usage_record_id) DO NOTHING;
    SELECT * INTO registered FROM control.usage_record_registry
    WHERE provider_id='opencode-go' AND usage_record_id=record_id;
    IF registered.authority IS DISTINCT FROM 'a0_behavior'
      OR registered.usage_value_micro_cents IS DISTINCT FROM record_value
      OR registered.usage_fingerprint_sha256 IS DISTINCT FROM fingerprint
      OR registered.run_id IS DISTINCT FROM $1 OR registered.batch_id IS DISTINCT FROM $2
    THEN RAISE EXCEPTION 'SHARED_USAGE_RECORD_CONFLICT'; END IF;
  END LOOP;

  target:=CASE WHEN $4>reserved.reservation_micro_cents
    THEN 'budget_exceeded' ELSE 'settled' END;
  INSERT INTO control.a0_behavior_batch_ledger(
    idempotency_key,source_plan_sha256,run_id,batch_id,batch_sha256,
    task_contract,task_contract_sha256,
    reservation_micro_cents,expires_at,version,state,usage_value_micro_cents,
    usage_records,usage_receipt_set_sha256
  ) VALUES(
    reserved.idempotency_key,reserved.source_plan_sha256,reserved.run_id,
    reserved.batch_id,reserved.batch_sha256,reserved.task_contract,
    reserved.task_contract_sha256,reserved.reservation_micro_cents,
    reserved.expires_at,next_version,target,$4,canonical_records,receipt_set_sha256
  );
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a0_behavior_batch_settled','run_id',$1,'batch_id',$2,
    'state',target,'terminal_version',next_version,
    'superseded_state',superseded_state,'usage_value_micro_cents',$4,
    'usage_receipt_count',receipt_count,
    'usage_receipt_set_sha256',receipt_set_sha256,
    'reservation_micro_cents',reserved.reservation_micro_cents,
    'quarantine_retained',superseded_state='held_unknown',
    'external_action',false,'recorded_at',clock_timestamp()
  ));
  IF target='budget_exceeded' THEN
    UPDATE control.usage_budget_control SET quarantined=true,
      quarantine_reason='A0_KNOWN_USAGE_BUDGET_EXCEEDED',updated_at=clock_timestamp()
    WHERE control_id=1;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION control.get_a0_behavior_batch_settlement(uuid,text,bigint,bigint,jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  terminal control.a0_behavior_batch_ledger%ROWTYPE;
  registered control.usage_record_registry%ROWTYPE;
  usage_entry jsonb;
  record_id text;
  record_value bigint;
  seen_ids text[]:='{}'::text[];
  receipt_count integer:=0;
  receipt_sum numeric:=0;
  canonical_records jsonb;
  receipt_set_sha256 text;
  fingerprint text;
BEGIN
  IF $2!~*'^a0:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:t(0[1-9]|1[0-6])$'
    OR lower($2) NOT LIKE 'a0:'||$1::text||':t%' OR $3<>1
    OR $4 NOT BETWEEN 1 AND 9007199254740991
    OR $5 IS NULL OR jsonb_typeof($5)<>'array' OR jsonb_array_length($5)<>6
  THEN RAISE EXCEPTION 'A0_SETTLEMENT_LOOKUP_INPUT_INVALID'; END IF;
  FOR usage_entry IN SELECT value FROM jsonb_array_elements($5)
  LOOP
    IF jsonb_typeof(usage_entry)<>'object'
      OR (SELECT count(*) FROM jsonb_object_keys(usage_entry))<>2
      OR NOT usage_entry?'usage_record_id'
      OR NOT usage_entry?'usage_value_micro_cents'
      OR jsonb_typeof(usage_entry->'usage_record_id')<>'string'
      OR jsonb_typeof(usage_entry->'usage_value_micro_cents')<>'number'
      OR length(usage_entry->>'usage_record_id') NOT BETWEEN 1 AND 200
      OR usage_entry->>'usage_record_id'!~'^[A-Za-z0-9._:-]+$'
      OR usage_entry->>'usage_value_micro_cents'!~'^[1-9][0-9]{0,15}$'
    THEN RAISE EXCEPTION 'A0_SETTLEMENT_LOOKUP_INPUT_INVALID'; END IF;
    record_id:=usage_entry->>'usage_record_id';
    record_value:=(usage_entry->>'usage_value_micro_cents')::bigint;
    IF record_value>9007199254740991 OR record_id=ANY(seen_ids)
    THEN RAISE EXCEPTION 'A0_SETTLEMENT_LOOKUP_INPUT_INVALID'; END IF;
    seen_ids:=array_append(seen_ids,record_id);
    receipt_count:=receipt_count+1;
    receipt_sum:=receipt_sum+record_value;
  END LOOP;
  IF receipt_count<>6 OR receipt_sum<>$4
  THEN RAISE EXCEPTION 'A0_SETTLEMENT_LOOKUP_INPUT_INVALID'; END IF;
  SELECT jsonb_agg(jsonb_build_object(
    'usage_record_id',entry->>'usage_record_id',
    'usage_value_micro_cents',(entry->>'usage_value_micro_cents')::bigint
  ) ORDER BY entry->>'usage_record_id') INTO canonical_records
  FROM jsonb_array_elements($5) AS records(entry);
  receipt_set_sha256:=encode(sha256(convert_to(jsonb_build_array(
    'opencode-go',canonical_records,$4,'a0_behavior',$1,$2,$3
  )::text,'UTF8')),'hex');
  SELECT ledger.* INTO terminal FROM control.a0_behavior_batch_ledger ledger
  WHERE ledger.run_id=$1 AND ledger.batch_id=$2 AND ledger.version>$3
    AND ledger.state IN('settled','budget_exceeded')
    AND ledger.usage_value_micro_cents=$4
    AND ledger.usage_records=canonical_records
    AND ledger.usage_receipt_set_sha256=receipt_set_sha256
  ORDER BY ledger.version DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unconfirmed'); END IF;
  FOR usage_entry IN SELECT value FROM jsonb_array_elements(canonical_records)
  LOOP
    record_id:=usage_entry->>'usage_record_id';
    record_value:=(usage_entry->>'usage_value_micro_cents')::bigint;
    fingerprint:=encode(sha256(convert_to(jsonb_build_array(
      'opencode-go',record_id,record_value,'a0_behavior',$1,$2,$3
    )::text,'UTF8')),'hex');
    SELECT * INTO registered FROM control.usage_record_registry
    WHERE provider_id='opencode-go' AND usage_record_id=record_id;
    IF NOT FOUND OR registered.authority IS DISTINCT FROM 'a0_behavior'
      OR registered.usage_value_micro_cents IS DISTINCT FROM record_value
      OR registered.usage_fingerprint_sha256 IS DISTINCT FROM fingerprint
      OR registered.run_id IS DISTINCT FROM $1 OR registered.batch_id IS DISTINCT FROM $2
    THEN RETURN jsonb_build_object('status','unconfirmed'); END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'status','confirmed','state',terminal.state,'version',terminal.version
  );
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
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  PERFORM control_id FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('a0:'||$1::text));
  PERFORM control.expire_a0_behavior_reservations();
  SELECT * INTO reserved FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 AND version=1;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO terminal FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 AND version>1
  ORDER BY version DESC LIMIT 1;
  IF FOUND THEN
    -- Expiry may have durably held the reservation before this explicit hold.
    -- Either held reason is terminal and safe; never rewrite its provenance.
    IF terminal.state='held_unknown' THEN RETURN true; END IF;
    RETURN false;
  END IF;
  INSERT INTO control.a0_behavior_batch_ledger(
    idempotency_key,source_plan_sha256,run_id,batch_id,batch_sha256,
    task_contract,task_contract_sha256,
    reservation_micro_cents,expires_at,version,state,unknown_reason
  ) VALUES(
    reserved.idempotency_key,reserved.source_plan_sha256,reserved.run_id,
    reserved.batch_id,reserved.batch_sha256,reserved.task_contract,
    reserved.task_contract_sha256,reserved.reservation_micro_cents,
    reserved.expires_at,2,'held_unknown',$4
  );
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a0_behavior_batch_usage_held','run_id',$1,'batch_id',$2,
    'reason',$4,'reservation_micro_cents',reserved.reservation_micro_cents,
    'external_action',false,'recorded_at',clock_timestamp()
  ));
  UPDATE control.usage_budget_control SET quarantined=true,
    quarantine_reason='A0_USAGE_UNKNOWN',updated_at=clock_timestamp()
  WHERE control_id=1;
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
  fingerprint text;
BEGIN
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  PERFORM control_id FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
  receipt:=control.legacy_038_stage_dispatch_settlement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);
  fingerprint:=encode(sha256(convert_to(jsonb_build_array(
    'opencode-go',$6,$5,'a1_dispatch',$1,$8
  )::text,'UTF8')),'hex');
  INSERT INTO control.usage_record_registry(
    provider_id,usage_record_id,authority,usage_value_micro_cents,
    usage_fingerprint_sha256,job_id,budget_version
  ) VALUES(
    'opencode-go',$6,'a1_dispatch',$5,fingerprint,$1,$8
  ) ON CONFLICT(provider_id,usage_record_id) DO NOTHING;
  SELECT * INTO registered FROM control.usage_record_registry
  WHERE provider_id='opencode-go' AND usage_record_id=$6;
  IF registered.authority IS DISTINCT FROM 'a1_dispatch'
    OR registered.usage_value_micro_cents IS DISTINCT FROM $5
    OR registered.usage_fingerprint_sha256 IS DISTINCT FROM fingerprint
    OR registered.job_id IS DISTINCT FROM $1 OR registered.budget_version IS DISTINCT FROM $8
  THEN RAISE EXCEPTION 'SHARED_USAGE_RECORD_CONFLICT'; END IF;
  RETURN receipt;
END $$;

-- A1 gates use the same singleton locks before checking A0. The retained 036
-- wrappers remain the only path to the legacy implementations and are restored
-- byte-for-byte by rollback.
ALTER FUNCTION control.claim_dispatch(text,integer,integer)
RENAME TO legacy_038_claim_dispatch;
REVOKE ALL ON FUNCTION control.legacy_038_claim_dispatch(text,integer,integer)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;

CREATE FUNCTION control.claim_dispatch(text,integer,integer)
RETURNS SETOF control.dispatch_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  claimed control.dispatch_jobs%ROWTYPE;
  guard control.usage_budget_control%ROWTYPE;
  a0_committed bigint;
  a1_committed bigint;
BEGIN
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  SELECT * INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
  PERFORM control.expire_a0_behavior_reservations();
  SELECT * INTO guard FROM control.usage_budget_control WHERE control_id=1;
  IF guard.control_id IS NULL OR guard.activation_ceiling_micro_cents<>1000000000
  THEN RAISE EXCEPTION 'SHARED_BUDGET_CONTROL_INVALID'; END IF;
  IF guard.quarantined OR EXISTS(
    SELECT 1 FROM control.a0_behavior_batch_ledger active
    WHERE active.state IN('reserved','held_unknown')
      AND NOT EXISTS(
        SELECT 1 FROM control.a0_behavior_batch_ledger later
        WHERE later.run_id=active.run_id AND later.batch_id=active.batch_id
          AND later.version>active.version
      )
  ) THEN RAISE EXCEPTION 'A0_ACTIVE_ATTEMPT_EXCLUDES_A1'; END IF;
  SELECT * INTO claimed FROM control.legacy_038_claim_dispatch($1,$2,$3);
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(sum(CASE
    WHEN latest.state IN('settled','budget_exceeded') THEN latest.usage_value_micro_cents
    ELSE latest.reservation_micro_cents END),0)::bigint INTO a0_committed
  FROM (
    SELECT DISTINCT ON(run_id,batch_id) * FROM control.a0_behavior_batch_ledger
    ORDER BY run_id,batch_id,version DESC
  ) latest;
  SELECT coalesce(sum(CASE usage_budget_state
    WHEN 'settled' THEN usage_value_actual_micro_cents
    WHEN 'reserved' THEN usage_value_reservation_micro_cents
    WHEN 'held_uncertain' THEN usage_value_reservation_micro_cents ELSE 0 END),0)::bigint
  INTO a1_committed FROM control.dispatch_jobs;
  IF a0_committed+a1_committed>guard.activation_ceiling_micro_cents
  THEN RAISE EXCEPTION 'SHARED_ACTIVATION_CEILING_EXCEEDED'; END IF;
  RETURN NEXT claimed;
END $$;

ALTER FUNCTION control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text)
RENAME TO legacy_038_activate_a1_dispatch_execution_window;
REVOKE ALL ON FUNCTION control.legacy_038_activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;

CREATE FUNCTION control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE guard control.usage_budget_control%ROWTYPE;
BEGIN
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  SELECT * INTO guard FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
  PERFORM control.expire_a0_behavior_reservations();
  SELECT * INTO guard FROM control.usage_budget_control WHERE control_id=1;
  IF guard.control_id IS NULL OR guard.activation_ceiling_micro_cents<>1000000000
  THEN RAISE EXCEPTION 'SHARED_BUDGET_CONTROL_INVALID'; END IF;
  IF guard.quarantined OR EXISTS(
    SELECT 1 FROM control.a0_behavior_batch_ledger active
    WHERE active.state IN('reserved','held_unknown')
      AND NOT EXISTS(
        SELECT 1 FROM control.a0_behavior_batch_ledger later
        WHERE later.run_id=active.run_id AND later.batch_id=active.batch_id
          AND later.version>active.version
      )
  ) THEN RAISE EXCEPTION 'A0_ACTIVE_ATTEMPT_EXCLUDES_A1'; END IF;
  RETURN control.legacy_038_activate_a1_dispatch_execution_window(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
  );
END $$;

REVOKE ALL ON control.a0_behavior_batch_ledger,control.a0_behavior_execution_permits,control.usage_record_registry
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_a1_supervisor,
  commercial_a1_chain_runner,commercial_a0_behavior_ledger;
REVOKE ALL ON FUNCTION control.expire_a0_behavior_reservations(),
  control.reserve_a0_behavior_batch(text,uuid,text,text,bigint,timestamptz,jsonb),
  control.acquire_a0_behavior_execution_permit(uuid,text,bigint),
  control.get_a0_behavior_task_execution_permit(uuid,text,bigint,uuid,text,text),
  control.get_a0_behavior_usage_budget_state(uuid,text,bigint),
  control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb),
  control.hold_a0_behavior_batch_unknown(uuid,text,bigint,text),
  control.get_a0_behavior_batch_settlement(uuid,text,bigint,bigint,jsonb)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_a1_supervisor,
  commercial_a1_chain_runner,commercial_a0_behavior_ledger;
REVOKE ALL ON FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;
REVOKE ALL ON FUNCTION control.claim_dispatch(text,integer,integer)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;
REVOKE ALL ON FUNCTION control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;
GRANT EXECUTE ON FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
TO commercial_runtime;
GRANT EXECUTE ON FUNCTION control.claim_dispatch(text,integer,integer)
TO commercial_runtime;
GRANT EXECUTE ON FUNCTION control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text)
TO commercial_safety_operator;
GRANT USAGE ON SCHEMA control TO commercial_a0_behavior_ledger;
GRANT EXECUTE ON FUNCTION control.reserve_a0_behavior_batch(text,uuid,text,text,bigint,timestamptz,jsonb),
  control.acquire_a0_behavior_execution_permit(uuid,text,bigint),
  control.get_a0_behavior_task_execution_permit(uuid,text,bigint,uuid,text,text),
  control.get_a0_behavior_usage_budget_state(uuid,text,bigint),
  control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb),
  control.hold_a0_behavior_batch_unknown(uuid,text,bigint,text),
  control.get_a0_behavior_batch_settlement(uuid,text,bigint,bigint,jsonb)
TO commercial_a0_behavior_ledger;

COMMIT;
