BEGIN;

CREATE SCHEMA IF NOT EXISTS control;
CREATE SCHEMA IF NOT EXISTS mail;

REVOKE ALL ON SCHEMA control FROM PUBLIC;
REVOKE ALL ON SCHEMA mail FROM PUBLIC;

CREATE TABLE IF NOT EXISTS control.missions (
  mission_id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS control.approvals (
  approval_id uuid PRIMARY KEY,
  action jsonb NOT NULL,
  action_hash text NOT NULL CHECK (action_hash ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  approved_by text,
  expires_at timestamptz,
  nonce text,
  token text UNIQUE,
  consumed_at timestamptz,
  CHECK (
    (status = 'pending' AND approved_by IS NULL AND expires_at IS NULL AND nonce IS NULL AND token IS NULL AND consumed_at IS NULL)
    OR status = 'denied'
    OR (status = 'approved' AND approved_by IS NOT NULL AND expires_at IS NOT NULL AND nonce IS NOT NULL AND token IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS approvals_approved_mission_action_nonce_uq
ON control.approvals ((action ->> 'mission_id'), action_hash, nonce)
WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS control.kill_switch_guard (
  guard_id smallint PRIMARY KEY CHECK (guard_id = 1)
);

INSERT INTO control.kill_switch_guard (guard_id)
VALUES (1)
ON CONFLICT (guard_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS control.kill_switches (
  scope text NOT NULL CHECK (scope IN ('global', 'mission', 'channel')),
  scope_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE IF NOT EXISTS control.audit_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION control.reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_EVENTS_APPEND_ONLY';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'audit_events_append_only'
      AND tgrelid = 'control.audit_events'::regclass
  ) THEN
    CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON control.audit_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION control.reject_audit_event_mutation();
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS mail.webhook_events (
  mailbox_key text NOT NULL,
  provider_event_id text NOT NULL,
  received_at timestamptz NOT NULL,
  trust_classification text NOT NULL CHECK (trust_classification = 'untrusted_external'),
  instruction_eligible boolean NOT NULL CHECK (instruction_eligible = false),
  untrusted_payload jsonb NOT NULL,
  PRIMARY KEY (mailbox_key, provider_event_id)
);

CREATE TABLE IF NOT EXISTS mail.external_actions (
  mission_id uuid NOT NULL REFERENCES control.missions (mission_id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  action_hash text NOT NULL,
  channel text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  receipt_id text,
  approval_id uuid REFERENCES control.approvals (approval_id) ON DELETE RESTRICT,
  completed_at timestamptz,
  PRIMARY KEY (mission_id, idempotency_key),
  CONSTRAINT external_actions_action_hash_format CHECK (action_hash ~ '^[0-9a-f]{64}$'),
  CHECK (
    (receipt_id IS NULL AND approval_id IS NULL AND completed_at IS NULL)
    OR (receipt_id IS NOT NULL AND approval_id IS NOT NULL AND completed_at IS NOT NULL)
  )
);

ALTER TABLE mail.external_actions
ADD COLUMN IF NOT EXISTS action_hash text;

UPDATE mail.external_actions AS external_action
SET action_hash = approval.action_hash
FROM control.approvals AS approval
WHERE external_action.action_hash IS NULL
  AND external_action.approval_id = approval.approval_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM mail.external_actions WHERE action_hash IS NULL) THEN
    RAISE EXCEPTION 'EXTERNAL_ACTION_HASH_BACKFILL_REQUIRED';
  END IF;
END;
$$;

ALTER TABLE mail.external_actions
ALTER COLUMN action_hash SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'external_actions_action_hash_format'
      AND conrelid = 'mail.external_actions'::regclass
  ) THEN
    ALTER TABLE mail.external_actions
    ADD CONSTRAINT external_actions_action_hash_format
    CHECK (action_hash ~ '^[0-9a-f]{64}$');
  END IF;
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA control FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA mail FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA control REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA mail REVOKE ALL ON TABLES FROM PUBLIC;

COMMIT;
