BEGIN;

REVOKE ALL ON FUNCTION control.external_actions_blocked(),control.get_mission_execution(uuid),control.get_dispatch_dependency_evidence(uuid)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,
  commercial_safety_operator,commercial_observer;
DROP FUNCTION IF EXISTS control.external_actions_blocked(),control.get_mission_execution(uuid),control.get_dispatch_dependency_evidence(uuid);

DELETE FROM control.schema_migrations WHERE version='009_internal_automation';

COMMIT;
