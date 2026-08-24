BEGIN;

DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM control.instruction_requests
    WHERE status<>'pending_codex_review'
       OR review_idempotency_key IS NOT NULL
       OR converted_mission_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'INSTRUCTION_REVIEW_ROLLBACK_REQUIRES_NO_REVIEWED_ROWS';
  END IF;
END$$;

DROP FUNCTION IF EXISTS control.review_instruction_request(
  uuid,text,text,text,timestamptz,text,text,text,uuid,text,jsonb
);
DROP FUNCTION IF EXISTS control.get_instruction_request(uuid);
DROP FUNCTION IF EXISTS control.list_instruction_requests();
DROP INDEX IF EXISTS control.instruction_review_idempotency_uq;
ALTER TABLE control.instruction_requests DROP CONSTRAINT IF EXISTS instruction_review_state_ck;
ALTER TABLE control.instruction_requests
  DROP COLUMN IF EXISTS converted_mission_id,
  DROP COLUMN IF EXISTS review_request_sha256,
  DROP COLUMN IF EXISTS review_idempotency_key,
  DROP COLUMN IF EXISTS review_reason,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS reviewed_by;

COMMIT;
