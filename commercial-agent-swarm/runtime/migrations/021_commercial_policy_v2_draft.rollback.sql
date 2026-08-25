BEGIN;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM catalog.version_activations WHERE project_id='proptimiza' AND policy_version='policy-v2')
     OR EXISTS(SELECT 1 FROM mail.delivery_policies WHERE project_id='proptimiza' AND policy_version='policy-v2')
     OR EXISTS(SELECT 1 FROM mail.delivery_policy_activations WHERE project_id='proptimiza' AND policy_version='policy-v2')
     OR EXISTS(SELECT 1 FROM control.missions WHERE payload->>'project_id'='proptimiza' AND payload->>'policy_version'='policy-v2') THEN
    RAISE EXCEPTION 'POLICY_V2_DRAFT_ROLLBACK_REQUIRES_NO_REFERENCES';
  END IF;
END$$;

DO $$
DECLARE deleted_rows integer;
BEGIN
  ALTER TABLE catalog.policy_versions DISABLE TRIGGER policy_versions_immutable;
  DELETE FROM catalog.policy_versions
  WHERE project_id='proptimiza'
    AND version='policy-v2'
    AND policy->>'status'='draft_human_approval_required'
    AND policy->>'effective'='false'
    AND policy->>'external_contact'='false';
  GET DIAGNOSTICS deleted_rows=ROW_COUNT;
  ALTER TABLE catalog.policy_versions ENABLE TRIGGER policy_versions_immutable;
  IF deleted_rows<>1 OR EXISTS(SELECT 1 FROM catalog.policy_versions WHERE project_id='proptimiza' AND version='policy-v2') THEN
    RAISE EXCEPTION 'POLICY_V2_DRAFT_ROLLBACK_CONFLICT';
  END IF;
END$$;

DO $$
BEGIN
  IF to_regclass('control.schema_migrations') IS NOT NULL THEN
    DELETE FROM control.schema_migrations
    WHERE version='021_commercial_policy_v2_draft';
  END IF;
END$$;

COMMIT;
