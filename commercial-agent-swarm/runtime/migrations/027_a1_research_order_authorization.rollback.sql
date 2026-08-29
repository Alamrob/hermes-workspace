BEGIN;

DO $$BEGIN
  IF EXISTS(SELECT 1 FROM control.a1_research_order_authorizations) THEN
    RAISE EXCEPTION 'A1_RESEARCH_ORDER_AUTHORIZATION_HISTORY_PRESENT';
  END IF;
END$$;

REVOKE ALL ON FUNCTION control.get_a1_research_order_authorization(uuid),
  control.record_a1_research_order_authorization(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,text,text,uuid,text,jsonb,text,text)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
DROP FUNCTION control.record_a1_research_order_authorization(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,text,text,uuid,text,jsonb,text,text);
DROP FUNCTION control.get_a1_research_order_authorization(uuid);
DROP TABLE control.a1_research_order_authorizations;
DELETE FROM control.schema_migrations WHERE version='027_a1_research_order_authorization';

COMMIT;
