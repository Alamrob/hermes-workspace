BEGIN;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM control.policy_human_reviews) THEN
    RAISE EXCEPTION 'POLICY_HUMAN_REVIEW_ROLLBACK_REQUIRES_EMPTY_LEDGER';
  END IF;
END $$;

DROP FUNCTION IF EXISTS control.record_policy_human_review(text,text,text,text,text,timestamptz,text,jsonb,text,text);
DROP FUNCTION IF EXISTS control.build_policy_review_state();
DROP TRIGGER IF EXISTS policy_human_reviews_immutable ON control.policy_human_reviews;
DROP FUNCTION IF EXISTS control.reject_policy_human_review_mutation();
DROP TABLE IF EXISTS control.policy_human_reviews;
DELETE FROM control.schema_migrations WHERE version='022_policy_human_review';

COMMIT;
