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
    OR EXISTS(SELECT 1 FROM control.a0_behavior_batch_ledger)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control WHERE claiming_enabled)
  THEN RAISE EXCEPTION 'A0_TASK_RESULT_MIGRATION_REQUIRES_EMPTY_CONTAINED_LEDGER'; END IF;
END $$;

CREATE TABLE control.a0_behavior_task_results(
  result_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  batch_id text NOT NULL CHECK(
    batch_id~*'^a0:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:t(0[1-9]|1[0-6])$'
  ),
  reservation_version bigint NOT NULL CHECK(reservation_version=1),
  task_id uuid NOT NULL,
  fixture_id uuid NOT NULL,
  agent_id text NOT NULL CHECK(agent_id IN(
    'sales-orchestrator','market-account-intelligence','contact-data-steward',
    'qualification-prioritization','outreach-draft-manager','commercial-qa-compliance'
  )),
  test_case text NOT NULL CHECK(test_case~'^T(0[1-9]|1[0-6])$'),
  critical boolean NOT NULL,
  expected_status text NOT NULL CHECK(expected_status IN(
    'completed','blocked_or_partial','approval_required'
  )),
  actual_status text NOT NULL CHECK(actual_status IN(
    'completed','partial','blocked','failed','approval_required'
  )),
  agent_result jsonb NOT NULL CHECK(jsonb_typeof(agent_result)='object'),
  behavior_passed boolean NOT NULL,
  result_sha256 text NOT NULL CHECK(result_sha256~'^[a-f0-9]{64}$'),
  usage_record_id text NOT NULL UNIQUE CHECK(
    length(usage_record_id) BETWEEN 1 AND 200
    AND usage_record_id~'^[A-Za-z0-9._:-]+$'
  ),
  usage_value_micro_cents bigint NOT NULL CHECK(
    usage_value_micro_cents BETWEEN 1 AND 1000000
  ),
  external_actions integer NOT NULL CHECK(external_actions=0),
  real_connector_calls integer NOT NULL CHECK(real_connector_calls=0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(run_id,batch_id,reservation_version,task_id),
  FOREIGN KEY(run_id,batch_id,reservation_version)
    REFERENCES control.a0_behavior_batch_ledger(run_id,batch_id,version),
  CHECK(lower(batch_id) LIKE 'a0:'||run_id::text||':t%'),
  CHECK(test_case='T'||right(batch_id,2)),
  CHECK(behavior_passed=(CASE expected_status
    WHEN 'completed' THEN actual_status='completed'
    WHEN 'blocked_or_partial' THEN actual_status IN('blocked','partial')
    WHEN 'approval_required' THEN actual_status='approval_required'
    ELSE false END))
);
CREATE TRIGGER a0_behavior_task_results_immutable
BEFORE UPDATE OR DELETE ON control.a0_behavior_task_results
FOR EACH STATEMENT EXECUTE FUNCTION control.reject_audit_event_mutation();

CREATE FUNCTION control.record_a0_behavior_task_result(
  uuid,text,bigint,uuid,uuid,text,text,boolean,text,text,jsonb,boolean,text,text,bigint,integer,integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  reserved control.a0_behavior_batch_ledger%ROWTYPE;
  latest control.a0_behavior_batch_ledger%ROWTYPE;
  task_entry jsonb;
  existing control.a0_behavior_task_results%ROWTYPE;
BEGIN
  IF $2!~*'^a0:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:t(0[1-9]|1[0-6])$'
    OR lower($2) NOT LIKE 'a0:'||$1::text||':t%' OR $3<>1
    OR $6 NOT IN(
      'sales-orchestrator','market-account-intelligence','contact-data-steward',
      'qualification-prioritization','outreach-draft-manager','commercial-qa-compliance'
    )
    OR $7!~'^T(0[1-9]|1[0-6])$' OR $7<>'T'||right($2,2)
    OR $9 NOT IN('completed','blocked_or_partial','approval_required')
    OR $10 NOT IN('completed','partial','blocked','failed','approval_required')
    OR $11 IS NULL OR jsonb_typeof($11)<>'object'
    OR octet_length($11::text)>262144
    OR $13!~'^[a-f0-9]{64}$'
    OR length($14) NOT BETWEEN 1 AND 200 OR $14!~'^[A-Za-z0-9._:-]+$'
    OR $15 NOT BETWEEN 1 AND 1000000 OR $16<>0 OR $17<>0
    OR $12 IS DISTINCT FROM (CASE $9
      WHEN 'completed' THEN $10='completed'
      WHEN 'blocked_or_partial' THEN $10 IN('blocked','partial')
      WHEN 'approval_required' THEN $10='approval_required'
      ELSE false END)
  THEN RAISE EXCEPTION 'A0_TASK_RESULT_INPUT_INVALID'; END IF;

  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  PERFORM control_id FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('a0:'||$1::text));
  PERFORM control.expire_a0_behavior_reservations();
  IF NOT control.is_global_kill_switch_active()
    OR NOT control.external_actions_blocked()
    OR (SELECT count(*) FROM control.kill_switches
        WHERE scope='channel' AND active AND scope_id=ANY(ARRAY[
          'email','whatsapp','calendar','web_chat','telephone','crm','public_web'
        ]))<>7
  THEN RAISE EXCEPTION 'A0_TASK_RESULT_REQUIRES_CONTAINMENT'; END IF;

  SELECT * INTO reserved FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 AND version=$3;
  IF NOT FOUND OR reserved.state<>'reserved' OR reserved.expires_at<=clock_timestamp()
  THEN RETURN 'unconfirmed'; END IF;
  SELECT * INTO latest FROM control.a0_behavior_batch_ledger
  WHERE run_id=$1 AND batch_id=$2 ORDER BY version DESC LIMIT 1;
  IF latest.version<>$3 OR latest.state<>'reserved'
    OR NOT EXISTS(
      SELECT 1 FROM control.a0_behavior_execution_permits
      WHERE run_id=$1 AND batch_id=$2 AND reservation_version=$3
    )
  THEN RETURN 'unconfirmed'; END IF;

  SELECT value INTO task_entry FROM jsonb_array_elements(reserved.task_contract)
  WHERE value->>'task_id'=$4::text;
  IF task_entry IS NULL
    OR task_entry->>'fixture_id'<>$5::text
    OR task_entry->>'agent_id'<>$6
    OR (task_entry->>'critical')::boolean IS DISTINCT FROM $8
    OR task_entry->>'expected_status'<>$9
  THEN RAISE EXCEPTION 'A0_TASK_RESULT_CONTRACT_DRIFT'; END IF;
  IF EXISTS(
    SELECT 1 FROM control.usage_record_registry
    WHERE provider_id='opencode-go' AND usage_record_id=$14
  ) THEN RAISE EXCEPTION 'SHARED_USAGE_RECORD_CONFLICT'; END IF;

  SELECT * INTO existing FROM control.a0_behavior_task_results
  WHERE run_id=$1 AND batch_id=$2 AND reservation_version=$3 AND task_id=$4;
  IF FOUND THEN
    IF existing.fixture_id IS DISTINCT FROM $5 OR existing.agent_id IS DISTINCT FROM $6
      OR existing.test_case IS DISTINCT FROM $7 OR existing.critical IS DISTINCT FROM $8
      OR existing.expected_status IS DISTINCT FROM $9 OR existing.actual_status IS DISTINCT FROM $10
      OR existing.agent_result IS DISTINCT FROM $11 OR existing.behavior_passed IS DISTINCT FROM $12
      OR existing.result_sha256 IS DISTINCT FROM $13 OR existing.usage_record_id IS DISTINCT FROM $14
      OR existing.usage_value_micro_cents IS DISTINCT FROM $15
      OR existing.external_actions IS DISTINCT FROM $16 OR existing.real_connector_calls IS DISTINCT FROM $17
    THEN RAISE EXCEPTION 'A0_TASK_RESULT_IMMUTABLE_CONFLICT'; END IF;
    RETURN 'existing';
  END IF;
  IF EXISTS(
    SELECT 1 FROM control.a0_behavior_task_results WHERE usage_record_id=$14
  ) THEN RAISE EXCEPTION 'A0_TASK_RESULT_USAGE_RECORD_CONFLICT'; END IF;

  INSERT INTO control.a0_behavior_task_results(
    run_id,batch_id,reservation_version,task_id,fixture_id,agent_id,test_case,
    critical,expected_status,actual_status,agent_result,behavior_passed,
    result_sha256,usage_record_id,usage_value_micro_cents,external_actions,
    real_connector_calls
  ) VALUES(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
  );
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a0_behavior_task_result_recorded','run_id',$1,'batch_id',$2,
    'task_id',$4,'agent_id',$6,'test_case',$7,'behavior_passed',$12,
    'result_sha256',$13,'usage_record_id',$14,
    'usage_value_micro_cents',$15,'external_action',false,
    'recorded_at',clock_timestamp()
  ));
  RETURN 'inserted';
END $$;

ALTER FUNCTION control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)
RENAME TO legacy_039_settle_a0_behavior_batch;
REVOKE ALL ON FUNCTION control.legacy_039_settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_a1_supervisor,
  commercial_a1_chain_runner,commercial_a0_behavior_ledger;

CREATE FUNCTION control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result_count integer; result_sum numeric;
BEGIN
  IF $5 IS NULL OR jsonb_typeof($5)<>'array' OR jsonb_array_length($5)<>6
  THEN RAISE EXCEPTION 'A0_SETTLEMENT_REQUIRES_DURABLE_TASK_RESULTS'; END IF;
  SELECT count(*),coalesce(sum(usage_value_micro_cents),0)
    INTO result_count,result_sum
  FROM control.a0_behavior_task_results
  WHERE run_id=$1 AND batch_id=$2 AND reservation_version=$3;
  IF result_count<>6 OR result_sum<>$4
    OR EXISTS(
      SELECT 1 FROM control.a0_behavior_task_results result
      WHERE result.run_id=$1 AND result.batch_id=$2 AND result.reservation_version=$3
        AND NOT EXISTS(
          SELECT 1 FROM jsonb_array_elements($5) receipt
          WHERE receipt->>'usage_record_id'=result.usage_record_id
            AND (receipt->>'usage_value_micro_cents')::bigint=result.usage_value_micro_cents
        )
    )
    OR EXISTS(
      SELECT 1 FROM jsonb_array_elements($5) receipt
      WHERE NOT EXISTS(
        SELECT 1 FROM control.a0_behavior_task_results result
        WHERE result.run_id=$1 AND result.batch_id=$2 AND result.reservation_version=$3
          AND result.usage_record_id=receipt->>'usage_record_id'
          AND result.usage_value_micro_cents=(receipt->>'usage_value_micro_cents')::bigint
      )
    )
  THEN RAISE EXCEPTION 'A0_SETTLEMENT_REQUIRES_DURABLE_TASK_RESULTS'; END IF;
  RETURN control.legacy_039_settle_a0_behavior_batch($1,$2,$3,$4,$5);
END $$;

REVOKE ALL ON control.a0_behavior_task_results
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_a1_supervisor,
  commercial_a1_chain_runner,commercial_a0_behavior_ledger;
REVOKE ALL ON FUNCTION control.record_a0_behavior_task_result(
  uuid,text,bigint,uuid,uuid,text,text,boolean,text,text,jsonb,boolean,text,text,bigint,integer,integer
),control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_a1_supervisor,
  commercial_a1_chain_runner,commercial_a0_behavior_ledger;
GRANT EXECUTE ON FUNCTION control.record_a0_behavior_task_result(
  uuid,text,bigint,uuid,uuid,text,text,boolean,text,text,jsonb,boolean,text,text,bigint,integer,integer
),control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)
TO commercial_a0_behavior_ledger;

COMMIT;
