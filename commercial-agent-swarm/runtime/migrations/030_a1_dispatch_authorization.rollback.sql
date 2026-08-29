BEGIN;

DO $$BEGIN
  IF EXISTS(SELECT 1 FROM control.a1_dispatch_authorizations) THEN
    RAISE EXCEPTION 'A1_DISPATCH_AUTHORIZATION_HISTORY_PRESENT';
  END IF;
END$$;

REVOKE ALL ON FUNCTION control.is_global_kill_switch_active(),
  control.get_a1_dispatch_authorization(uuid),
  control.record_a1_dispatch_authorization(uuid,uuid,uuid,text,text,text,text,text,timestamptz,timestamptz,text,text,text,jsonb,text,text)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
DROP FUNCTION control.record_a1_dispatch_authorization(uuid,uuid,uuid,text,text,text,text,text,timestamptz,timestamptz,text,text,text,jsonb,text,text);
DROP FUNCTION control.get_a1_dispatch_authorization(uuid);
DROP FUNCTION control.is_global_kill_switch_active();
DROP TABLE control.a1_dispatch_authorizations;
DELETE FROM control.schema_migrations WHERE version='030_a1_dispatch_authorization';

COMMIT;
