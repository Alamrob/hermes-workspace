BEGIN;

CREATE TABLE mail.policy_v2_delivery_contracts (
  contract_id uuid PRIMARY KEY,
  preparation_authorization_id uuid NOT NULL,
  project_id text NOT NULL CHECK (project_id='proptimiza'),
  policy_version text NOT NULL CHECK (policy_version='policy-v2'),
  sender text NOT NULL CHECK (sender='ventas@proptimiza.com'),
  channel text NOT NULL CHECK (channel='email'),
  expected_recipient_count smallint NOT NULL CHECK (expected_recipient_count BETWEEN 1 AND 10),
  maximum_initial_messages_per_company smallint NOT NULL CHECK (maximum_initial_messages_per_company=1),
  tracking boolean NOT NULL CHECK (NOT tracking),
  automatic_follow_up boolean NOT NULL CHECK (NOT automatic_follow_up),
  human_approval_per_action boolean NOT NULL CHECK (human_approval_per_action),
  suppression_check_required boolean NOT NULL CHECK (suppression_check_required),
  recipient_binding_required boolean NOT NULL CHECK (recipient_binding_required),
  source_evidence_required boolean NOT NULL CHECK (source_evidence_required),
  recipient_set_sha256 text NOT NULL CHECK (recipient_set_sha256~'^[0-9a-f]{64}$'),
  contract_sha256 text NOT NULL UNIQUE CHECK (contract_sha256~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(preparation_authorization_id)
    REFERENCES control.policy_activation_authorizations(authorization_id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,policy_version)
    REFERENCES catalog.policy_versions(project_id,version) ON DELETE RESTRICT,
  UNIQUE(preparation_authorization_id)
);

CREATE INDEX policy_v2_delivery_contract_policy_idx
  ON mail.policy_v2_delivery_contracts(project_id,policy_version);

CREATE TABLE mail.policy_v2_delivery_recipients (
  contract_id uuid NOT NULL REFERENCES mail.policy_v2_delivery_contracts(contract_id) ON DELETE RESTRICT,
  company_control_ref text NOT NULL CHECK (
    length(company_control_ref) BETWEEN 1 AND 256
    AND company_control_ref~'^[A-Za-z0-9._:-]+$'
  ),
  recipient text NOT NULL CHECK (
    recipient=lower(recipient)
    AND recipient~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  recipient_role text NOT NULL CHECK (
    recipient_role IN ('ventas','sales','comercial','contacto','info','hola','hello','business','partnerships')
    AND split_part(recipient,'@',1)=recipient_role
  ),
  contact_type text NOT NULL CHECK (
    contact_type='role_based_corporate_email_published_by_the_account'
  ),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256~'^[0-9a-f]{64}$'),
  source_url_sha256 text NOT NULL CHECK (source_url_sha256~'^[0-9a-f]{64}$'),
  source_confidence text NOT NULL CHECK (source_confidence='high'),
  purpose text NOT NULL CHECK (purpose='commercial_pilot_policy_v2'),
  source_observed_at timestamptz NOT NULL,
  source_reverified_at timestamptz NOT NULL CHECK (source_reverified_at>=source_observed_at),
  expires_at timestamptz NOT NULL CHECK (
    expires_at>source_reverified_at
    AND expires_at<=source_reverified_at+interval '30 days'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(contract_id,company_control_ref),
  UNIQUE(contract_id,recipient)
);

CREATE OR REPLACE FUNCTION mail.reject_policy_v2_delivery_contract_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'POLICY_V2_DELIVERY_CONTRACT_IMMUTABLE'; END
$$;

CREATE TRIGGER policy_v2_delivery_contracts_immutable
BEFORE UPDATE OR DELETE ON mail.policy_v2_delivery_contracts
FOR EACH ROW EXECUTE FUNCTION mail.reject_policy_v2_delivery_contract_mutation();
CREATE TRIGGER policy_v2_delivery_recipients_immutable
BEFORE UPDATE OR DELETE ON mail.policy_v2_delivery_recipients
FOR EACH ROW EXECUTE FUNCTION mail.reject_policy_v2_delivery_contract_mutation();

CREATE OR REPLACE FUNCTION mail.require_policy_v2_preparation_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM control.policy_v2_pilot_preparation_gate gate
    WHERE gate.authorization_id=NEW.preparation_authorization_id
      AND gate.project_id=NEW.project_id
      AND gate.policy_version=NEW.policy_version
  ) THEN
    RAISE EXCEPTION 'POLICY_V2_PREPARATION_GATE_REQUIRED';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER policy_v2_delivery_contract_requires_preparation
BEFORE INSERT ON mail.policy_v2_delivery_contracts
FOR EACH ROW EXECUTE FUNCTION mail.require_policy_v2_preparation_gate();

CREATE OR REPLACE FUNCTION mail.enforce_policy_v2_recipient_contract()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE contract mail.policy_v2_delivery_contracts%ROWTYPE;
BEGIN
  SELECT * INTO contract
  FROM mail.policy_v2_delivery_contracts
  WHERE contract_id=NEW.contract_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'POLICY_V2_DELIVERY_CONTRACT_NOT_FOUND'; END IF;
  IF NEW.source_reverified_at>clock_timestamp() THEN
    RAISE EXCEPTION 'POLICY_V2_RECIPIENT_REVERIFICATION_IN_FUTURE';
  END IF;
  IF EXISTS(
    SELECT 1 FROM control.pilot_suppressions suppression
    WHERE suppression.control_ref=NEW.company_control_ref
  ) THEN
    RAISE EXCEPTION 'POLICY_V2_RECIPIENT_SUPPRESSED';
  END IF;
  IF (SELECT count(*) FROM mail.policy_v2_delivery_recipients existing
      WHERE existing.contract_id=NEW.contract_id)>=contract.expected_recipient_count THEN
    RAISE EXCEPTION 'POLICY_V2_RECIPIENT_LIMIT_EXCEEDED';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER policy_v2_delivery_recipient_contract_guard
BEFORE INSERT ON mail.policy_v2_delivery_recipients
FOR EACH ROW EXECUTE FUNCTION mail.enforce_policy_v2_recipient_contract();

CREATE OR REPLACE FUNCTION control.build_policy_v2_delivery_contract_state(uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
WITH contract AS (
  SELECT * FROM mail.policy_v2_delivery_contracts WHERE contract_id=$1
), facts AS (
  SELECT
    contract.*,
    (SELECT count(*) FROM mail.policy_v2_delivery_recipients recipient
      WHERE recipient.contract_id=contract.contract_id) AS recipient_count,
    NOT EXISTS(
      SELECT 1 FROM mail.policy_v2_delivery_recipients recipient
      JOIN control.pilot_suppressions suppression
        ON suppression.control_ref=recipient.company_control_ref
      WHERE recipient.contract_id=contract.contract_id
    ) AS suppression_clear,
    NOT EXISTS(
      SELECT 1 FROM mail.policy_v2_delivery_recipients recipient
      WHERE recipient.contract_id=contract.contract_id
        AND (recipient.source_reverified_at>clock_timestamp()
          OR recipient.expires_at<=clock_timestamp())
    ) AS evidence_current,
    EXISTS(SELECT 1 FROM control.kill_switches WHERE scope='global' AND scope_id='*' AND active) AS global_kill_switch_active,
    EXISTS(SELECT 1 FROM control.kill_switches WHERE scope='channel' AND scope_id='email' AND active) AS email_kill_switch_active,
    (SELECT policy_version FROM catalog.current_version_activation WHERE project_id='proptimiza') AS active_policy_version,
    (SELECT (policy->>'effective')::boolean FROM catalog.policy_versions
      WHERE project_id='proptimiza' AND version='policy-v2') AS policy_effective,
    (SELECT (policy->>'external_contact')::boolean FROM catalog.policy_versions
      WHERE project_id='proptimiza' AND version='policy-v2') AS external_contact,
    (SELECT count(*) FROM mail.delivery_policies
      WHERE project_id='proptimiza' AND policy_version='policy-v2') AS delivery_policy_count,
    (SELECT count(*) FROM mail.delivery_policy_activations
      WHERE project_id='proptimiza' AND policy_version='policy-v2') AS delivery_activation_count,
    (SELECT count(*) FROM catalog.version_activations
      WHERE project_id='proptimiza' AND policy_version='policy-v2') AS version_activation_count,
    EXISTS(
      SELECT 1
      FROM control.policy_v2_external_transport_readiness readiness
      WHERE readiness.preparation_authorization_id=contract.preparation_authorization_id
        AND readiness.project_id=contract.project_id
        AND readiness.policy_version=contract.policy_version
        AND readiness.observed_at<=clock_timestamp()
        AND readiness.expires_at>clock_timestamp()
    ) AS external_transport_ready
  FROM contract
)
SELECT jsonb_build_object(
  'contractId',contract_id,
  'projectId',project_id,
  'policyVersion',policy_version,
  'contractSha256',contract_sha256,
  'recipientSetSha256',recipient_set_sha256,
  'expectedRecipientCount',expected_recipient_count,
  'recipientCount',recipient_count,
  'recipientCountExact',recipient_count=expected_recipient_count,
  'suppressionClear',suppression_clear,
  'evidenceCurrent',evidence_current,
  'globalKillSwitchActive',global_kill_switch_active,
  'emailKillSwitchActive',email_kill_switch_active,
  'activePolicyVersion',active_policy_version,
  'policyEffective',policy_effective,
  'externalContact',external_contact,
  'deliveryPolicyCount',delivery_policy_count,
  'deliveryPolicyActivationCount',delivery_activation_count,
  'versionActivationCount',version_activation_count,
  'externalTransportReady',external_transport_ready,
  'activationAuthorizationRecorded',false,
  'activationAllowed',false,
  'targetCreationAllowed',false,
  'sendAllowed',false,
  'contractComplete',(
    recipient_count=expected_recipient_count
    AND recipient_count BETWEEN 1 AND 10
    AND suppression_clear AND evidence_current
    AND global_kill_switch_active AND email_kill_switch_active
    AND active_policy_version='policy-v1'
    AND policy_effective=false AND external_contact=false
    AND external_transport_ready
    AND delivery_policy_count=0 AND delivery_activation_count=0 AND version_activation_count=0
  ),
  'nextRequiredGate',CASE
    WHEN recipient_count=0 THEN 'recipient_contract_population'
    WHEN recipient_count<>expected_recipient_count OR NOT suppression_clear OR NOT evidence_current
      THEN 'recipient_contract_correction'
    WHEN NOT global_kill_switch_active OR NOT email_kill_switch_active
      OR active_policy_version<>'policy-v1' OR policy_effective OR external_contact
      OR delivery_policy_count<>0 OR delivery_activation_count<>0 OR version_activation_count<>0
      THEN 'closed_baseline_recovery'
    WHEN NOT external_transport_ready THEN 'external_transport_readiness'
    ELSE 'explicit_policy_activation_authorization'
  END,
  'provenance',jsonb_build_object(
    'source','control-broker',
    'sourceId','policy-v2-delivery-contract:'||contract_id::text,
    'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'synthetic',false
  )
) FROM facts
$$;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM mail.policy_v2_delivery_contracts)
     OR EXISTS(SELECT 1 FROM mail.policy_v2_delivery_recipients) THEN
    RAISE EXCEPTION 'POLICY_V2_DELIVERY_CONTRACT_MUST_START_EMPTY';
  END IF;
END
$$;

REVOKE ALL ON mail.policy_v2_delivery_contracts,mail.policy_v2_delivery_recipients
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION mail.reject_policy_v2_delivery_contract_mutation(),mail.require_policy_v2_preparation_gate(),mail.enforce_policy_v2_recipient_contract(),control.build_policy_v2_delivery_contract_state(uuid)
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.build_policy_v2_delivery_contract_state(uuid) TO commercial_runtime;

COMMIT;
