BEGIN;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM control.policy_v2_external_transport_readiness) THEN
    RAISE EXCEPTION 'POLICY_V2_TRANSPORT_READINESS_HISTORY_PRESENT';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS control.build_policy_v2_pilot_preparation_state();
DROP VIEW IF EXISTS control.policy_v2_pilot_preparation_gate;
DROP TRIGGER IF EXISTS policy_v2_external_transport_readiness_immutable
  ON control.policy_v2_external_transport_readiness;
DROP FUNCTION IF EXISTS control.reject_policy_v2_transport_readiness_mutation();
DROP TABLE control.policy_v2_external_transport_readiness;
DELETE FROM control.schema_migrations
WHERE version='040_policy_v2_pilot_preparation_gate';

COMMIT;
