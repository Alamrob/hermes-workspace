BEGIN;

DO $$ BEGIN
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  PERFORM control_id FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
  IF EXISTS(SELECT 1 FROM control.a0_behavior_batch_ledger)
    OR EXISTS(
      SELECT 1 FROM control.usage_record_registry registry
      WHERE registry.provider_id<>'opencode-go'
        OR registry.authority<>'a1_dispatch'
        OR NOT EXISTS(
          SELECT 1 FROM control.dispatch_settlement_receipts receipt
          WHERE receipt.usage_record_id=registry.usage_record_id
            AND receipt.usage_value_micro_cents=registry.usage_value_micro_cents
            AND receipt.job_id=registry.job_id
            AND receipt.budget_version=registry.budget_version
            AND registry.usage_fingerprint_sha256=encode(sha256(convert_to(jsonb_build_array(
              'opencode-go',receipt.usage_record_id,receipt.usage_value_micro_cents,
              'a1_dispatch',receipt.job_id,receipt.budget_version
            )::text,'UTF8')),'hex')
        )
    )
    OR EXISTS(
      SELECT 1 FROM control.dispatch_settlement_receipts receipt
      WHERE NOT EXISTS(
        SELECT 1 FROM control.usage_record_registry registry
        WHERE registry.provider_id='opencode-go'
          AND registry.usage_record_id=receipt.usage_record_id
          AND registry.authority='a1_dispatch'
          AND registry.usage_value_micro_cents=receipt.usage_value_micro_cents
          AND registry.job_id=receipt.job_id
          AND registry.budget_version=receipt.budget_version
          AND registry.usage_fingerprint_sha256=encode(sha256(convert_to(jsonb_build_array(
            'opencode-go',receipt.usage_record_id,receipt.usage_value_micro_cents,
            'a1_dispatch',receipt.job_id,receipt.budget_version
          )::text,'UTF8')),'hex')
      )
    )
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_window_authorizations WHERE closed_at IS NULL)
    OR EXISTS(SELECT 1 FROM control.a1_dispatch_execution_control WHERE claiming_enabled)
    OR NOT control.is_global_kill_switch_active()
    OR NOT control.external_actions_blocked()
    OR (SELECT count(*) FROM control.kill_switches
        WHERE scope='channel' AND active AND scope_id=ANY(ARRAY[
          'email','whatsapp','calendar','web_chat','telephone','crm','public_web'
        ]))<>7
  THEN RAISE EXCEPTION 'A0_BEHAVIOR_AUTHORITY_ROLLBACK_REQUIRES_EMPTY_CONTAINED_LEDGER'; END IF;
END $$;

REVOKE ALL ON FUNCTION control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;
DROP FUNCTION control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text);
ALTER FUNCTION control.legacy_038_activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text)
RENAME TO activate_a1_dispatch_execution_window;
REVOKE ALL ON FUNCTION control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;
GRANT EXECUTE ON FUNCTION control.activate_a1_dispatch_execution_window(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text,text,text,integer,numeric,text,jsonb,text,text)
TO commercial_safety_operator;

REVOKE ALL ON FUNCTION control.claim_dispatch(text,integer,integer)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;
DROP FUNCTION control.claim_dispatch(text,integer,integer);
ALTER FUNCTION control.legacy_038_claim_dispatch(text,integer,integer)
RENAME TO claim_dispatch;
REVOKE ALL ON FUNCTION control.claim_dispatch(text,integer,integer)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;
GRANT EXECUTE ON FUNCTION control.claim_dispatch(text,integer,integer)
TO commercial_runtime;

REVOKE ALL ON FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;
DROP FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer);
ALTER FUNCTION control.legacy_038_stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
RENAME TO stage_dispatch_settlement;
REVOKE ALL ON FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
FROM PUBLIC,commercial_runtime,commercial_safety_operator,commercial_a1_supervisor,commercial_a0_behavior_ledger;
GRANT EXECUTE ON FUNCTION control.stage_dispatch_settlement(uuid,text,jsonb,text,bigint,text,text,bigint,bigint,integer)
TO commercial_runtime;

REVOKE ALL ON FUNCTION control.reserve_a0_behavior_batch(text,uuid,text,text,bigint,timestamptz),
  control.acquire_a0_behavior_execution_permit(uuid,text,bigint),
  control.settle_a0_behavior_batch(uuid,text,bigint,bigint,text),
  control.hold_a0_behavior_batch_unknown(uuid,text,bigint,text),
  control.get_a0_behavior_batch_settlement(uuid,text,bigint,bigint,text)
FROM commercial_a0_behavior_ledger;
DROP FUNCTION control.reserve_a0_behavior_batch(text,uuid,text,text,bigint,timestamptz),
  control.acquire_a0_behavior_execution_permit(uuid,text,bigint),
  control.settle_a0_behavior_batch(uuid,text,bigint,bigint,text),
  control.hold_a0_behavior_batch_unknown(uuid,text,bigint,text),
  control.get_a0_behavior_batch_settlement(uuid,text,bigint,bigint,text),
  control.expire_a0_behavior_reservations();

DROP TRIGGER a0_behavior_execution_permits_immutable ON control.a0_behavior_execution_permits;
DROP TABLE control.a0_behavior_execution_permits;
DROP TRIGGER a0_behavior_batch_ledger_immutable ON control.a0_behavior_batch_ledger;
DROP TABLE control.a0_behavior_batch_ledger;
DROP TRIGGER usage_record_registry_immutable ON control.usage_record_registry;
DROP TABLE control.usage_record_registry;
REVOKE USAGE ON SCHEMA control FROM commercial_a0_behavior_ledger;
DELETE FROM control.schema_migrations WHERE version='038_a0_behavior_authority';

COMMIT;
