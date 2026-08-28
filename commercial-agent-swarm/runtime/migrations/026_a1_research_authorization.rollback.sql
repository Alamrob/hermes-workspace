BEGIN;
REVOKE ALL ON FUNCTION control.build_a1_research_authorization_state(uuid,text),control.record_a1_research_authorization(uuid,uuid,text,text,text,text,timestamptz,timestamptz,text,jsonb,text,text)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
DROP FUNCTION control.record_a1_research_authorization(uuid,uuid,text,text,text,text,timestamptz,timestamptz,text,jsonb,text,text);
DROP FUNCTION control.build_a1_research_authorization_state(uuid,text);
DROP TABLE control.a1_research_authorizations;
DELETE FROM control.schema_migrations WHERE version='026_a1_research_authorization';
COMMIT;
