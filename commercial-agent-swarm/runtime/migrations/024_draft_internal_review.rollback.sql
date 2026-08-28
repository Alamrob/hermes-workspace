BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM control.draft_review_commands) THEN RAISE EXCEPTION 'DRAFT_REVIEW_COMMANDS_EXIST'; END IF;
END $$;
REVOKE ALL ON FUNCTION control.build_draft_review(uuid),control.list_draft_reviews(),control.get_draft_review(uuid),control.record_draft_review_item(uuid,integer,text,text,text,text,integer,text,text,text),control.complete_draft_review(uuid,integer,text,text,text) FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
DROP FUNCTION control.complete_draft_review(uuid,integer,text,text,text);
DROP FUNCTION control.record_draft_review_item(uuid,integer,text,text,text,text,integer,text,text,text);
DROP FUNCTION control.get_draft_review(uuid);
DROP FUNCTION control.list_draft_reviews();
DROP FUNCTION control.build_draft_review(uuid);
DROP TABLE control.draft_review_commands;
DROP TABLE control.draft_review_items;
DROP TABLE control.draft_review_sessions;
DELETE FROM control.schema_migrations WHERE version='024_draft_internal_review';
COMMIT;
