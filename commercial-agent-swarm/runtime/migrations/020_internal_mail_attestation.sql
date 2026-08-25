BEGIN;

CREATE TABLE IF NOT EXISTS mail.internal_mail_attestations (
  attestation_id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES catalog.projects(project_id) ON DELETE RESTRICT,
  mission_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  approval_id uuid NOT NULL REFERENCES control.approvals(approval_id) ON DELETE RESTRICT,
  mailbox_key text NOT NULL,
  provider_event_id text NOT NULL,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  verification_status text NOT NULL CHECK (verification_status = 'verified'),
  attested_by text NOT NULL CHECK (
    length(attested_by) BETWEEN 1 AND 128
    AND attested_by ~ '^[A-Za-z0-9._:@-]+$'
  ),
  attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT internal_mail_attestation_action_fkey
    FOREIGN KEY(mission_id,idempotency_key)
    REFERENCES mail.external_actions(mission_id,idempotency_key) ON DELETE RESTRICT,
  CONSTRAINT internal_mail_attestation_webhook_fkey
    FOREIGN KEY(mailbox_key,provider_event_id)
    REFERENCES mail.webhook_events(mailbox_key,provider_event_id) ON DELETE RESTRICT,
  UNIQUE(project_id),
  UNIQUE(mission_id,idempotency_key),
  UNIQUE(mailbox_key,provider_event_id)
);

CREATE OR REPLACE FUNCTION mail.reject_internal_mail_attestation_mutation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'INTERNAL_MAIL_ATTESTATION_IMMUTABLE';
END
$$;

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_trigger
    WHERE tgname='internal_mail_attestations_immutable'
      AND tgrelid='mail.internal_mail_attestations'::regclass
  ) THEN
    CREATE TRIGGER internal_mail_attestations_immutable
    BEFORE UPDATE OR DELETE ON mail.internal_mail_attestations
    FOR EACH STATEMENT EXECUTE FUNCTION mail.reject_internal_mail_attestation_mutation();
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION mail.attest_internal_mail_test(
  uuid,text,uuid,text,uuid,text,text,text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  action_record record;
  webhook_record record;
  existing mail.internal_mail_attestations%ROWTYPE;
  project_action_count integer;
  mailbox_event_count integer;
  approval_evidence_count integer;
BEGIN
  IF $2 IS NULL OR $2 !~ '^[a-z][a-z0-9-]{1,63}$'
    OR $4 IS NULL OR length($4) NOT BETWEEN 8 AND 200
    OR $6 IS NULL OR length($6) NOT BETWEEN 1 AND 128
    OR $7 IS NULL OR length($7) NOT BETWEEN 1 AND 256
    OR $8 IS NULL OR $8 !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'INVALID_INTERNAL_MAIL_ATTESTATION_INPUT'; END IF;

  IF NOT control.external_actions_blocked()
  THEN RAISE EXCEPTION 'EXTERNAL_ACTIONS_NOT_BLOCKED'; END IF;

  SELECT
    external_action.action_hash,
    external_action.completed_at,
    approval.action,
    approval.approved_by,
    policy.sender,
    policy.recipient,
    policy.maximum_volume
  INTO action_record
  FROM mail.external_actions external_action
  JOIN control.missions mission ON mission.mission_id=external_action.mission_id
  JOIN control.approvals approval ON approval.approval_id=external_action.approval_id
  JOIN mail.current_delivery_policy_activation activation ON activation.project_id=$2
  JOIN mail.delivery_policies policy
    ON policy.project_id=activation.project_id
   AND policy.policy_version=activation.policy_version
  WHERE external_action.mission_id=$3
    AND external_action.idempotency_key=$4
    AND external_action.approval_id=$5
    AND external_action.channel='email'
    AND external_action.receipt_id IS NOT NULL
    AND external_action.completed_at IS NOT NULL
    AND mission.payload->>'project_id'=$2
    AND mission.payload->>'autonomy_level'='A3'
    AND mission.payload->>'a3_enabled'='true'
    AND approval.status='approved'
    AND approval.consumed_at IS NOT NULL
    AND approval.action_hash=external_action.action_hash
    AND approval.action->>'mission_id'=$3::text
    AND approval.action->>'project_id'=$2
    AND approval.action->>'action_type'='mail.send'
    AND approval.action->>'channel'='email'
    AND approval.action->>'sender'=policy.sender
    AND jsonb_typeof(approval.action->'recipients')='array'
    AND jsonb_array_length(approval.action->'recipients')=1
    AND approval.action->'recipients'->>0=policy.recipient
    AND approval.action->>'policy_version'=policy.policy_version
    AND approval.action->>'idempotency_key'=$4
    AND approval.action->>'volume'=policy.maximum_volume::text
    AND policy.maximum_volume=1
    AND policy.active
    AND policy.valid_from<=clock_timestamp()
    AND(policy.valid_until IS NULL OR policy.valid_until>clock_timestamp());
  IF NOT FOUND THEN RAISE EXCEPTION 'INTERNAL_MAIL_ACTION_NOT_VERIFIABLE'; END IF;

  SELECT count(*)::integer INTO project_action_count
  FROM mail.external_actions external_action
  JOIN control.missions mission ON mission.mission_id=external_action.mission_id
  WHERE mission.payload->>'project_id'=$2;
  IF project_action_count<>1
  THEN RAISE EXCEPTION 'INTERNAL_MAIL_ACTION_COUNT_INVALID'; END IF;

  SELECT count(*)::integer INTO approval_evidence_count
  FROM control.approval_channel_evidence evidence
  WHERE evidence.approval_id=$5
    AND evidence.action_hash=action_record.action_hash
    AND evidence.decision='approved';
  IF approval_evidence_count NOT BETWEEN 1 AND 2
  THEN RAISE EXCEPTION 'INTERNAL_MAIL_APPROVAL_EVIDENCE_INVALID'; END IF;

  SELECT received_at,trust_classification,instruction_eligible
  INTO webhook_record
  FROM mail.webhook_events
  WHERE mailbox_key=$6 AND provider_event_id=$7;
  IF NOT FOUND
    OR webhook_record.trust_classification<>'untrusted_external'
    OR webhook_record.instruction_eligible
    OR webhook_record.received_at<action_record.completed_at
    OR webhook_record.received_at>action_record.completed_at+interval '7 days'
  THEN RAISE EXCEPTION 'INTERNAL_MAIL_WEBHOOK_NOT_VERIFIABLE'; END IF;

  SELECT count(*)::integer INTO mailbox_event_count
  FROM mail.webhook_events WHERE mailbox_key=$6;
  IF mailbox_event_count<>1
  THEN RAISE EXCEPTION 'INTERNAL_MAIL_WEBHOOK_COUNT_INVALID'; END IF;

  INSERT INTO mail.internal_mail_attestations(
    attestation_id,project_id,mission_id,idempotency_key,approval_id,
    mailbox_key,provider_event_id,evidence_sha256,verification_status,attested_by
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'verified',action_record.approved_by)
  ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN $1; END IF;

  SELECT * INTO existing
  FROM mail.internal_mail_attestations
  WHERE attestation_id=$1 OR project_id=$2;
  IF existing.attestation_id=$1
    AND existing.project_id=$2
    AND existing.mission_id=$3
    AND existing.idempotency_key=$4
    AND existing.approval_id=$5
    AND existing.mailbox_key=$6
    AND existing.provider_event_id=$7
    AND existing.evidence_sha256=$8
    AND existing.verification_status='verified'
  THEN RETURN existing.attestation_id; END IF;
  RAISE EXCEPTION 'INTERNAL_MAIL_ATTESTATION_CONFLICT';
END
$$;

CREATE OR REPLACE VIEW mail.internal_mail_attestation_summaries
WITH(security_barrier=true) AS
SELECT attestation_id,project_id,mission_id,verification_status,attested_at
FROM mail.internal_mail_attestations;

REVOKE ALL ON mail.internal_mail_attestations
FROM PUBLIC,commercial_runtime,commercial_observer,commercial_safety_operator;
REVOKE ALL ON FUNCTION
  mail.reject_internal_mail_attestation_mutation(),
  mail.attest_internal_mail_test(uuid,text,uuid,text,uuid,text,text,text)
FROM PUBLIC,commercial_runtime,commercial_observer,commercial_safety_operator;
REVOKE ALL ON mail.internal_mail_attestation_summaries
FROM PUBLIC,commercial_runtime,commercial_observer,commercial_safety_operator;

GRANT USAGE ON SCHEMA mail TO commercial_safety_operator;
GRANT EXECUTE ON FUNCTION
  mail.attest_internal_mail_test(uuid,text,uuid,text,uuid,text,text,text)
TO commercial_safety_operator;
GRANT SELECT ON mail.internal_mail_attestation_summaries TO commercial_observer;

COMMIT;
