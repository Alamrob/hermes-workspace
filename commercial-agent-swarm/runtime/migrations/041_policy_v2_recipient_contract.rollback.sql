BEGIN;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM mail.policy_v2_delivery_contracts)
     OR EXISTS(SELECT 1 FROM mail.policy_v2_delivery_recipients) THEN
    RAISE EXCEPTION 'POLICY_V2_DELIVERY_CONTRACT_HISTORY_PRESENT';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS control.build_policy_v2_delivery_contract_state(uuid);
DROP TRIGGER IF EXISTS policy_v2_delivery_recipient_contract_guard
  ON mail.policy_v2_delivery_recipients;
DROP FUNCTION IF EXISTS mail.enforce_policy_v2_recipient_contract();
DROP TRIGGER IF EXISTS policy_v2_delivery_contract_requires_preparation
  ON mail.policy_v2_delivery_contracts;
DROP FUNCTION IF EXISTS mail.require_policy_v2_preparation_gate();
DROP TRIGGER IF EXISTS policy_v2_delivery_recipients_immutable
  ON mail.policy_v2_delivery_recipients;
DROP TRIGGER IF EXISTS policy_v2_delivery_contracts_immutable
  ON mail.policy_v2_delivery_contracts;
DROP FUNCTION IF EXISTS mail.reject_policy_v2_delivery_contract_mutation();
DROP TABLE mail.policy_v2_delivery_recipients;
DROP TABLE mail.policy_v2_delivery_contracts;
DELETE FROM control.schema_migrations
WHERE version='041_policy_v2_recipient_contract';

COMMIT;
