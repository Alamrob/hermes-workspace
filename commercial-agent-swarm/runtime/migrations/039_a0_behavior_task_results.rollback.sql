BEGIN;

DO $$ BEGIN
  PERFORM guard_id FROM control.kill_switch_guard WHERE guard_id=1 FOR UPDATE;
  PERFORM control_id FROM control.usage_budget_control WHERE control_id=1 FOR UPDATE;
  IF EXISTS(SELECT 1 FROM control.a0_behavior_task_results)
    OR EXISTS(SELECT 1 FROM control.a0_behavior_batch_ledger)
    OR NOT control.is_global_kill_switch_active()
    OR NOT control.external_actions_blocked()
    OR (SELECT count(*) FROM control.kill_switches
        WHERE scope='channel' AND active AND scope_id=ANY(ARRAY[
          'email','whatsapp','calendar','web_chat','telephone','crm','public_web'
        ]))<>7
  THEN RAISE EXCEPTION 'A0_TASK_RESULT_ROLLBACK_REQUIRES_EMPTY_CONTAINED_LEDGER'; END IF;
END $$;

REVOKE ALL ON FUNCTION control.record_a0_behavior_task_result(
  uuid,text,bigint,uuid,uuid,text,text,boolean,text,text,jsonb,boolean,text,text,bigint,integer,integer
),control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_a1_supervisor,
  commercial_a1_chain_runner,commercial_a0_behavior_ledger;
DROP FUNCTION control.record_a0_behavior_task_result(
  uuid,text,bigint,uuid,uuid,text,text,boolean,text,text,jsonb,boolean,text,text,bigint,integer,integer
),control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb);
ALTER FUNCTION control.legacy_039_settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)
RENAME TO settle_a0_behavior_batch;
REVOKE ALL ON FUNCTION control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer,commercial_a1_supervisor,
  commercial_a1_chain_runner,commercial_a0_behavior_ledger;
GRANT EXECUTE ON FUNCTION control.settle_a0_behavior_batch(uuid,text,bigint,bigint,jsonb)
TO commercial_a0_behavior_ledger;

DROP TRIGGER a0_behavior_task_results_immutable ON control.a0_behavior_task_results;
DROP TABLE control.a0_behavior_task_results;
DELETE FROM control.schema_migrations WHERE version='039_a0_behavior_task_results';

COMMIT;
