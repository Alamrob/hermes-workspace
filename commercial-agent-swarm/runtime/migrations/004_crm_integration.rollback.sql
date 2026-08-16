BEGIN;

UPDATE integration.sync_control
SET enabled=false,updated_at=clock_timestamp()
WHERE control_id=1;

REVOKE ALL ON SCHEMA integration FROM commercial_runtime,commercial_crm_sync,commercial_crm_observer,commercial_safety_operator;
REVOKE ALL ON FUNCTION control.record_approval_channel_evidence(uuid,text,text,text,text,timestamptz),control.list_approval_channel_evidence(uuid) FROM commercial_approval_evidence;
REVOKE ALL ON control.pilot_cohort_summaries FROM commercial_crm_observer;
REVOKE ALL ON integration.crm_sync_summaries FROM commercial_crm_observer;
REVOKE ALL ON FUNCTION control.create_pilot_cohort(uuid,text,text),control.add_pilot_target(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz,text),integration.enqueue_crm_change(uuid,uuid,uuid,text,jsonb,bigint) FROM commercial_runtime;
REVOKE ALL ON FUNCTION control.add_pilot_suppression(text,text,text),integration.set_crm_sync_enabled(boolean) FROM commercial_safety_operator;
REVOKE ALL ON FUNCTION integration.claim_crm_outbox(text,integer),integration.complete_crm_outbox(uuid,text,text,text),integration.mark_crm_outbox_outcome_unknown(uuid,text,text),integration.store_crm_inbox(text,text,text,text,text,jsonb),integration.advance_crm_cursor(text,text,bigint,text) FROM commercial_crm_sync;

-- Preserve approval evidence, control pilots, suppressions, entity links, outbox/inbox history,
-- cursors, functions, roles, and receipts for audit and deterministic recovery.

COMMIT;
