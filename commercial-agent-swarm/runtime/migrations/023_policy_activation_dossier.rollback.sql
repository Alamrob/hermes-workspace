BEGIN;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM control.policy_activation_authorizations) THEN
    RAISE EXCEPTION 'POLICY_ACTIVATION_AUTHORIZATION_ROLLBACK_REQUIRES_EMPTY_LEDGER';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS control.build_policy_activation_dossier_state();
DROP TRIGGER IF EXISTS policy_activation_authorizations_immutable ON control.policy_activation_authorizations;
DROP FUNCTION IF EXISTS control.reject_policy_activation_authorization_mutation();
DROP TABLE IF EXISTS control.policy_activation_authorizations;
DELETE FROM control.schema_migrations
WHERE version='023_policy_activation_dossier';

COMMIT;
