BEGIN;

UPDATE integration.sync_control
SET enabled = false, updated_at = clock_timestamp()
WHERE control_id = 1;

REVOKE ALL ON SCHEMA integration FROM commercial_runtime, commercial_crm_sync,
  commercial_crm_observer, commercial_safety_operator;
REVOKE ALL ON ALL TABLES IN SCHEMA integration FROM commercial_runtime,
  commercial_crm_sync, commercial_crm_observer, commercial_safety_operator;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA integration FROM commercial_runtime,
  commercial_crm_sync, commercial_crm_observer, commercial_safety_operator;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA integration FROM commercial_runtime,
  commercial_crm_sync, commercial_crm_observer, commercial_safety_operator;

-- Intentionally preserve the integration schema, all rows, receipts, cursors,
-- idempotency history, functions, and roles for audit and deterministic recovery.

COMMIT;
