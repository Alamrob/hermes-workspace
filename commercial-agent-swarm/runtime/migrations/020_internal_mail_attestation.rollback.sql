BEGIN;

DO $$
BEGIN
  IF to_regclass('mail.internal_mail_attestations') IS NOT NULL
    AND EXISTS(SELECT 1 FROM mail.internal_mail_attestations)
  THEN RAISE EXCEPTION 'INTERNAL_MAIL_ATTESTATION_ROLLBACK_REQUIRES_EMPTY_LEDGER'; END IF;
END
$$;

REVOKE ALL ON FUNCTION
  mail.attest_internal_mail_test(uuid,text,uuid,text,uuid,text,text,text)
FROM PUBLIC,commercial_runtime,commercial_observer,commercial_safety_operator;
REVOKE ALL ON mail.internal_mail_attestation_summaries
FROM PUBLIC,commercial_runtime,commercial_observer,commercial_safety_operator;

DROP VIEW IF EXISTS mail.internal_mail_attestation_summaries;
DROP FUNCTION IF EXISTS mail.attest_internal_mail_test(uuid,text,uuid,text,uuid,text,text,text);
DROP TRIGGER IF EXISTS internal_mail_attestations_immutable ON mail.internal_mail_attestations;
DROP FUNCTION IF EXISTS mail.reject_internal_mail_attestation_mutation();
DROP TABLE IF EXISTS mail.internal_mail_attestations;
DELETE FROM control.schema_migrations WHERE version='020_internal_mail_attestation';

COMMIT;
