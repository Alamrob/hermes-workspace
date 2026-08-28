BEGIN;
REVOKE ALL ON FUNCTION control.build_a1_research_dossier(uuid)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
DROP FUNCTION control.build_a1_research_dossier(uuid);
DELETE FROM control.schema_migrations WHERE version='025_a1_research_dossier';
COMMIT;
