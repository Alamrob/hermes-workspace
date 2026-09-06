BEGIN;

DO $$ BEGIN
  IF NOT control.is_global_kill_switch_active()
    OR NOT control.external_actions_blocked()
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control WHERE claiming_enabled)
    OR EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE status='leased' OR usage_budget_state='held_uncertain')
  THEN RAISE EXCEPTION 'A1_SINGLE_APPROVAL_MIGRATION_REQUIRES_CONTAINMENT'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commercial_a1_chain_runner') THEN
    CREATE ROLE commercial_a1_chain_runner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF EXISTS(
    SELECT 1 FROM pg_roles WHERE rolname='commercial_a1_chain_runner'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) OR EXISTS(
    SELECT 1 FROM pg_auth_members
    WHERE member=(SELECT oid FROM pg_roles WHERE rolname='commercial_a1_chain_runner')
  ) THEN RAISE EXCEPTION 'UNSAFE_A1_SINGLE_APPROVAL_CAPABILITY'; END IF;
END $$;

CREATE TABLE control.a1_single_approval_parent_consumptions(
  request_id uuid PRIMARY KEY,
  mission_id uuid NOT NULL UNIQUE REFERENCES control.missions(mission_id) ON DELETE RESTRICT,
  trace_id uuid NOT NULL,
  authorization_digest_sha256 text NOT NULL UNIQUE CHECK(authorization_digest_sha256~'^[0-9a-f]{64}$'),
  user_authorization_sha256 text NOT NULL UNIQUE CHECK(user_authorization_sha256~'^[0-9a-f]{64}$'),
  expected_mission_sha256 text NOT NULL CHECK(expected_mission_sha256~'^[0-9a-f]{64}$'),
  assignment_plan_sha256 text NOT NULL CHECK(assignment_plan_sha256~'^[0-9a-f]{64}$'),
  job_set_sha256 text NOT NULL CHECK(job_set_sha256~'^[0-9a-f]{64}$'),
  assignment_ids uuid[] NOT NULL CHECK(cardinality(assignment_ids)=6),
  worker_id text NOT NULL CHECK(worker_id='broker-dispatcher-1'),
  maximum_dispatch_ticks integer NOT NULL CHECK(maximum_dispatch_ticks=6),
  maximum_provider_credit_spend_usd numeric NOT NULL
    CHECK(maximum_provider_credit_spend_usd BETWEEN 0.06 AND 0.5),
  reviewer_id text NOT NULL CHECK(reviewer_id='user:proptimizaspa@gmail.com'),
  reviewer_email text NOT NULL CHECK(reviewer_email='proptimizaspa@gmail.com'),
  reviewed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  stage_receipt_keys jsonb NOT NULL,
  consume_stage_receipt_key text NOT NULL CHECK(consume_stage_receipt_key~'^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key~'^[0-9a-f]{64}$'),
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(expires_at>reviewed_at+interval '2 minutes' AND expires_at<=reviewed_at+interval '30 minutes'),
  CHECK(consume_stage_receipt_key=idempotency_key)
);

CREATE TRIGGER a1_single_approval_parent_immutable
BEFORE UPDATE OR DELETE ON control.a1_single_approval_parent_consumptions
FOR EACH STATEMENT EXECUTE FUNCTION control.reject_audit_event_mutation();

CREATE FUNCTION control.consume_a1_single_approval_parent(jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  parent_input alias for $1;
  actual_keys text[];
  receipt_keys text[];
  ids uuid[];
  mission_payload jsonb;
  reviewed timestamptz;
  expires timestamptz;
  now_at timestamptz:=clock_timestamp();
BEGIN
  IF parent_input IS NULL OR jsonb_typeof(parent_input)<>'object' THEN
    RAISE EXCEPTION 'A1_SINGLE_APPROVAL_PARENT_INVALID';
  END IF;
  SELECT array_agg(key ORDER BY key) INTO actual_keys FROM jsonb_object_keys(parent_input) key;
  IF actual_keys IS DISTINCT FROM ARRAY[
    'assignment_ids','assignment_plan_sha256','authorization_digest_sha256','expected_mission_sha256',
    'expires_at','idempotency_key','job_set_sha256','maximum_dispatch_ticks',
    'maximum_provider_credit_spend_usd','mission_id','request_id','reviewed_at','reviewer_email',
    'reviewer_id','stage_receipt_key','stage_receipt_keys','trace_id','user_authorization_sha256','worker_id'
  ]::text[] THEN RAISE EXCEPTION 'A1_SINGLE_APPROVAL_PARENT_INVALID'; END IF;
  IF jsonb_typeof(parent_input->'assignment_ids') IS DISTINCT FROM 'array'
    OR jsonb_typeof(parent_input->'stage_receipt_keys') IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'A1_SINGLE_APPROVAL_PARENT_INVALID'; END IF;
  SELECT array_agg(value::uuid ORDER BY ordinality) INTO ids
  FROM jsonb_array_elements_text(parent_input->'assignment_ids') WITH ORDINALITY item(value,ordinality);
  SELECT array_agg(key ORDER BY key) INTO receipt_keys
  FROM jsonb_object_keys(parent_input->'stage_receipt_keys') key;
  IF cardinality(ids)<>6 OR (SELECT count(DISTINCT id) FROM unnest(ids) id)<>6
    OR receipt_keys IS DISTINCT FROM ARRAY[
      'audit_terminal_state','consume_parent_authorization','create_execution_arm',
      'dispatch_bounded_dag','materialize_exact_job_set','open_execution_window',
      'recontain_execution_window','register_assignment_plan_authorization',
      'register_enqueue_authorization','register_execution_authorization'
    ]::text[]
    OR EXISTS(
      SELECT 1 FROM jsonb_each_text(parent_input->'stage_receipt_keys') entry
      WHERE entry.value!~'^[0-9a-f]{64}$'
    )
    OR parent_input->>'stage_receipt_key' IS DISTINCT FROM
      parent_input->'stage_receipt_keys'->>'consume_parent_authorization'
    OR parent_input->>'idempotency_key' IS DISTINCT FROM parent_input->>'stage_receipt_key'
    OR NOT coalesce(parent_input->>'authorization_digest_sha256'~'^[0-9a-f]{64}$',false)
    OR NOT coalesce(parent_input->>'user_authorization_sha256'~'^[0-9a-f]{64}$',false)
    OR NOT coalesce(parent_input->>'expected_mission_sha256'~'^[0-9a-f]{64}$',false)
    OR NOT coalesce(parent_input->>'assignment_plan_sha256'~'^[0-9a-f]{64}$',false)
    OR NOT coalesce(parent_input->>'job_set_sha256'~'^[0-9a-f]{64}$',false)
    OR parent_input->>'worker_id' IS DISTINCT FROM 'broker-dispatcher-1'
    OR (parent_input->>'maximum_dispatch_ticks')::integer IS DISTINCT FROM 6
    OR NOT coalesce((parent_input->>'maximum_provider_credit_spend_usd')::numeric BETWEEN 0.06 AND 0.5,false)
    OR parent_input->>'reviewer_id' IS DISTINCT FROM 'user:proptimizaspa@gmail.com'
    OR parent_input->>'reviewer_email' IS DISTINCT FROM 'proptimizaspa@gmail.com'
  THEN RAISE EXCEPTION 'A1_SINGLE_APPROVAL_PARENT_INVALID'; END IF;
  reviewed:=(parent_input->>'reviewed_at')::timestamptz;
  expires:=(parent_input->>'expires_at')::timestamptz;
  IF reviewed IS NULL OR expires IS NULL OR abs(extract(epoch FROM now_at-reviewed))>300 OR expires<=now_at
    OR expires<=reviewed+interval '2 minutes' OR expires>reviewed+interval '30 minutes'
  THEN RAISE EXCEPTION 'A1_SINGLE_APPROVAL_PARENT_EXPIRED'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext(parent_input->>'request_id'));
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  IF EXISTS(
      SELECT 1 FROM control.a1_single_approval_parent_consumptions
      WHERE request_id=(parent_input->>'request_id')::uuid
        OR mission_id=(parent_input->>'mission_id')::uuid
        OR user_authorization_sha256=parent_input->>'user_authorization_sha256'
        OR idempotency_key=parent_input->>'idempotency_key'
    )
  THEN RAISE EXCEPTION 'A1_SINGLE_APPROVAL_PARENT_ALREADY_CONSUMED'; END IF;
  SELECT mission.payload INTO mission_payload FROM control.missions mission
  WHERE mission.mission_id=(parent_input->>'mission_id')::uuid FOR SHARE;
  IF mission_payload IS NULL
    OR mission_payload->>'trace_id' IS DISTINCT FROM parent_input->>'trace_id'
    OR mission_payload->>'autonomy_level' IS DISTINCT FROM 'A1'
    OR mission_payload->>'dry_run' IS DISTINCT FROM 'true'
    OR mission_payload->'contact_policy'->>'contact_permitted' IS DISTINCT FROM 'false'
    OR mission_payload->'volume_limits'->>'maximum_external_actions' IS DISTINCT FROM '0'
    OR (mission_payload->>'expires_at')::timestamptz<expires
    OR NOT control.is_global_kill_switch_active()
    OR NOT control.external_actions_blocked()
    OR (SELECT count(*) FROM control.kill_switches
        WHERE scope='channel' AND active AND scope_id=ANY(ARRAY[
          'email','whatsapp','calendar','web_chat','telephone','crm','public_web'
        ]))<>7
    OR EXISTS(SELECT 1 FROM control.dispatch_jobs WHERE mission_id=(parent_input->>'mission_id')::uuid)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_authorizations WHERE mission_id=(parent_input->>'mission_id')::uuid)
    OR EXISTS(SELECT 1 FROM control.a1_assignment_enqueue_authorizations WHERE mission_id=(parent_input->>'mission_id')::uuid)
    OR EXISTS(SELECT 1 FROM control.a1_assignment_execution_authorizations WHERE mission_id=(parent_input->>'mission_id')::uuid)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_arms WHERE mission_id=(parent_input->>'mission_id')::uuid)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE mission_id=(parent_input->>'mission_id')::uuid)
    OR EXISTS(SELECT 1 FROM mail.external_actions WHERE mission_id=(parent_input->>'mission_id')::uuid)
    OR EXISTS(SELECT 1 FROM integration.crm_outbox WHERE status IN('pending','leased','outcome_unknown'))
  THEN RAISE EXCEPTION 'A1_SINGLE_APPROVAL_PARENT_GATE_CLOSED'; END IF;

  INSERT INTO control.a1_single_approval_parent_consumptions(
    request_id,mission_id,trace_id,authorization_digest_sha256,user_authorization_sha256,
    expected_mission_sha256,assignment_plan_sha256,job_set_sha256,assignment_ids,worker_id,
    maximum_dispatch_ticks,maximum_provider_credit_spend_usd,reviewer_id,reviewer_email,
    reviewed_at,expires_at,stage_receipt_keys,consume_stage_receipt_key,idempotency_key,consumed_at
  ) VALUES(
    (parent_input->>'request_id')::uuid,(parent_input->>'mission_id')::uuid,(parent_input->>'trace_id')::uuid,
    parent_input->>'authorization_digest_sha256',parent_input->>'user_authorization_sha256',
    parent_input->>'expected_mission_sha256',parent_input->>'assignment_plan_sha256',parent_input->>'job_set_sha256',
    ids,parent_input->>'worker_id',(parent_input->>'maximum_dispatch_ticks')::integer,
    (parent_input->>'maximum_provider_credit_spend_usd')::numeric,parent_input->>'reviewer_id',
    parent_input->>'reviewer_email',reviewed,expires,parent_input->'stage_receipt_keys',
    parent_input->>'stage_receipt_key',parent_input->>'idempotency_key',now_at
  );
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a1_single_approval_parent_consumed','request_id',parent_input->>'request_id',
    'mission_id',parent_input->>'mission_id','authorization_digest_sha256',parent_input->>'authorization_digest_sha256',
    'user_authorization_sha256',parent_input->>'user_authorization_sha256','reviewer_id',parent_input->>'reviewer_id',
    'expires_at',expires,'maximum_dispatch_ticks',6,'maximum_external_actions',0,
    'external_action',false,'recorded_at',now_at
  ));
  RETURN jsonb_build_object('consumed',true);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
  RAISE EXCEPTION 'A1_SINGLE_APPROVAL_PARENT_INVALID';
END $$;

CREATE FUNCTION control.get_a1_single_approval_chain_state(uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'mission_id',$1,
    'channel_kills',(SELECT count(*) FROM control.kill_switches WHERE scope='channel' AND active
      AND scope_id=ANY(ARRAY['email','whatsapp','calendar','web_chat','telephone','crm','public_web'])),
    'external_actions_blocked',control.external_actions_blocked(),
    'external_actions',(SELECT count(*) FROM mail.external_actions WHERE mission_id=$1),
    'crm_writes',0,
    'crm_outbox',(SELECT count(*) FROM integration.crm_outbox WHERE status IN('pending','leased','outcome_unknown')),
    'global_kill',control.is_global_kill_switch_active(),
    'execution_window_open',EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations
      WHERE mission_id=$1 AND closed_at IS NULL),
    'dispatch_claiming_permitted',EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control
      WHERE control_id=1 AND claiming_enabled AND mission_id=$1),
    'active_or_uncertain_jobs',(SELECT count(*) FROM control.dispatch_jobs WHERE mission_id=$1
      AND(status='leased' OR usage_budget_state='held_uncertain')),
    'parent_authorization_consumed',EXISTS(SELECT 1 FROM control.a1_single_approval_parent_consumptions
      WHERE mission_id=$1),
    'completed_jobs',(SELECT count(*) FROM control.dispatch_jobs WHERE mission_id=$1 AND status='succeeded'),
    'usage_value_consumed_usd',(SELECT coalesce(sum(usage_value_actual_micro_cents),0)::numeric/100000000
      FROM control.dispatch_jobs WHERE mission_id=$1 AND usage_budget_state='settled')
  )
$$;

CREATE FUNCTION control.recontain_a1_single_approval_chain(uuid,text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE contained boolean;now_at timestamptz:=clock_timestamp();
BEGIN
  IF $2!~'^A1_SINGLE_APPROVAL_(CHAIN_COMPLETED|FAILED:[a-z_]+)$'
    OR NOT EXISTS(SELECT 1 FROM control.a1_single_approval_parent_consumptions WHERE mission_id=$1)
  THEN RAISE EXCEPTION 'A1_SINGLE_APPROVAL_RECONTAIN_INVALID'; END IF;
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  SELECT control.recontain_a1_dispatch_execution_window($1,$2) INTO contained;
  IF NOT contained THEN
    PERFORM control.set_kill_switch('global','*',true);
    UPDATE control.a1_dispatch_execution_control SET claiming_enabled=false,mission_id=NULL,arm_id=NULL,
      worker_id=NULL,opened_at=NULL,expires_at=NULL,updated_at=now_at
    WHERE control_id=1 AND mission_id=$1;
  END IF;
  IF NOT control.is_global_kill_switch_active()
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE mission_id=$1 AND closed_at IS NULL)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control WHERE control_id=1 AND claiming_enabled AND mission_id=$1)
  THEN RAISE EXCEPTION 'A1_SINGLE_APPROVAL_RECONTAINMENT_UNPROVEN'; END IF;
  INSERT INTO control.audit_events(event) VALUES(jsonb_build_object(
    'event','a1_single_approval_chain_recontained','mission_id',$1,'reason',$2,
    'global_kill_switch_active',true,'external_action',false,'recorded_at',now_at
  ));
  RETURN jsonb_build_object('recontained',true);
END $$;

REVOKE ALL ON control.a1_single_approval_parent_consumptions
  FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
    commercial_safety_operator,commercial_observer,commercial_a1_supervisor,commercial_a1_chain_runner;
REVOKE ALL ON FUNCTION control.consume_a1_single_approval_parent(jsonb),
  control.get_a1_single_approval_chain_state(uuid),control.recontain_a1_single_approval_chain(uuid,text)
  FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
    commercial_safety_operator,commercial_observer,commercial_a1_supervisor,commercial_a1_chain_runner;
GRANT USAGE ON SCHEMA control TO commercial_a1_chain_runner;
GRANT EXECUTE ON FUNCTION control.consume_a1_single_approval_parent(jsonb),
  control.get_a1_single_approval_chain_state(uuid),control.recontain_a1_single_approval_chain(uuid,text)
  TO commercial_a1_chain_runner;

COMMIT;
