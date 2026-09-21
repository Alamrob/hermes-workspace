BEGIN;

CREATE OR REPLACE VIEW control.policy_v2_pilot_preparation_gate
WITH (security_barrier=true) AS
SELECT
  authorization_id,
  project_id,
  policy_version,
  policy_digest,
  request_sha256,
  recorded_at
FROM control.policy_activation_authorizations
WHERE project_id='proptimiza'
  AND policy_version='policy-v2'
  AND policy_digest='888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19'
  AND request_sha256='fc14a614af12611fc287fc4581cce819f05eaedab13d2882505034616e210954'
  AND authorization_scope=$scope${
    "channel":"email",
    "offer_id":"operacion-sin-planillas",
    "tracking":false,
    "a3_enabled":false,
    "project_id":"proptimiza",
    "icp_version":"icp-v1",
    "offer_version":"offer-v1",
    "policy_version":"policy-v2",
    "preparation_only":true,
    "maximum_companies":10,
    "kill_switch_active":true,
    "automatic_follow_up":false,
    "external_actions_authorized":false,
    "maximum_initial_messages_per_company":1
  }$scope$::jsonb;

CREATE TABLE control.policy_v2_external_transport_readiness (
  attestation_id uuid PRIMARY KEY,
  preparation_authorization_id uuid NOT NULL,
  project_id text NOT NULL CHECK (project_id='proptimiza'),
  policy_version text NOT NULL CHECK (policy_version='policy-v2'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256~'^[0-9a-f]{64}$'),
  dns_ready boolean NOT NULL CHECK (dns_ready),
  smtp_configuration_present boolean NOT NULL CHECK (smtp_configuration_present),
  imap_configuration_present boolean NOT NULL CHECK (imap_configuration_present),
  webhook_configuration_present boolean NOT NULL CHECK (webhook_configuration_present),
  credential_separation_verified boolean NOT NULL CHECK (credential_separation_verified),
  provider_calls integer NOT NULL CHECK (provider_calls=0),
  secret_values_disclosed boolean NOT NULL CHECK (NOT secret_values_disclosed),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (
    expires_at>observed_at AND expires_at<=observed_at+interval '24 hours'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(preparation_authorization_id)
    REFERENCES control.policy_activation_authorizations(authorization_id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,policy_version)
    REFERENCES catalog.policy_versions(project_id,version) ON DELETE RESTRICT,
  UNIQUE(preparation_authorization_id,evidence_sha256)
);

CREATE OR REPLACE FUNCTION control.reject_policy_v2_transport_readiness_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'POLICY_V2_TRANSPORT_READINESS_IMMUTABLE'; END
$$;

CREATE TRIGGER policy_v2_external_transport_readiness_immutable
BEFORE UPDATE OR DELETE ON control.policy_v2_external_transport_readiness
FOR EACH ROW EXECUTE FUNCTION control.reject_policy_v2_transport_readiness_mutation();

CREATE OR REPLACE FUNCTION control.build_policy_v2_pilot_preparation_state()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
WITH facts AS (
  SELECT
    (SELECT count(*)=1 FROM control.policy_v2_pilot_preparation_gate) AS preparation_gate_recorded,
    EXISTS(
      SELECT 1
      FROM control.policy_v2_external_transport_readiness readiness
      JOIN control.policy_v2_pilot_preparation_gate gate
        ON gate.authorization_id=readiness.preparation_authorization_id
      WHERE readiness.project_id='proptimiza'
        AND readiness.policy_version='policy-v2'
        AND readiness.observed_at<=clock_timestamp()
        AND readiness.expires_at>clock_timestamp()
    ) AS external_transport_ready,
    (SELECT count(*) FROM control.pilot_cohorts WHERE project_id='proptimiza') AS pilot_cohort_count,
    (SELECT count(*) FROM control.pilot_targets WHERE project_id='proptimiza') AS pilot_target_count,
    (SELECT count(*) FROM mail.delivery_policies WHERE project_id='proptimiza' AND policy_version='policy-v2') AS delivery_policy_count,
    (SELECT count(*) FROM mail.delivery_policy_activations WHERE project_id='proptimiza' AND policy_version='policy-v2') AS delivery_activation_count,
    (SELECT count(*) FROM catalog.version_activations WHERE project_id='proptimiza' AND policy_version='policy-v2') AS version_activation_count,
    (SELECT count(*) FROM mail.external_actions WHERE completed_at IS NULL) AS pending_external_action_count,
    EXISTS(SELECT 1 FROM control.kill_switches WHERE scope='global' AND scope_id='*' AND active) AS global_kill_switch_active,
    EXISTS(SELECT 1 FROM control.kill_switches WHERE scope='channel' AND scope_id='email' AND active) AS email_kill_switch_active,
    (SELECT policy_version FROM catalog.current_version_activation WHERE project_id='proptimiza') AS active_policy_version,
    (SELECT (policy->>'effective')::boolean FROM catalog.policy_versions WHERE project_id='proptimiza' AND version='policy-v2') AS policy_effective,
    (SELECT (policy->>'external_contact')::boolean FROM catalog.policy_versions WHERE project_id='proptimiza' AND version='policy-v2') AS external_contact
), state AS (
  SELECT *,(
    preparation_gate_recorded
    AND pilot_cohort_count=0 AND pilot_target_count=0
    AND delivery_policy_count=0 AND delivery_activation_count=0 AND version_activation_count=0
    AND pending_external_action_count=0
    AND global_kill_switch_active AND email_kill_switch_active
    AND active_policy_version='policy-v1'
    AND policy_effective=false AND external_contact=false
  ) AS preparation_satisfied
  FROM facts
)
SELECT jsonb_build_object(
  'projectId','proptimiza',
  'policyVersion','policy-v2',
  'policyDigest','888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19',
  'preparationGateRecorded',preparation_gate_recorded,
  'preparationSatisfied',preparation_satisfied,
  'externalTransportReady',external_transport_ready,
  'activationAuthorizationRecorded',false,
  'activePolicyVersion',active_policy_version,
  'policyEffective',policy_effective,
  'externalContact',external_contact,
  'pilotCohortCount',pilot_cohort_count,
  'pilotTargetCount',pilot_target_count,
  'deliveryPolicyCount',delivery_policy_count,
  'deliveryPolicyActivationCount',delivery_activation_count,
  'versionActivationCount',version_activation_count,
  'pendingExternalActionCount',pending_external_action_count,
  'globalKillSwitchActive',global_kill_switch_active,
  'emailKillSwitchActive',email_kill_switch_active,
  'maximumCompanies',10,
  'channel','email',
  'tracking',false,
  'automaticFollowUp',false,
  'a3Enabled',false,
  'targetCreationAllowed',false,
  'sendAllowed',false,
  'activationAllowed',false,
  'nextRequiredGate',CASE
    WHEN NOT preparation_gate_recorded THEN 'explicit_preparation_gate'
    WHEN NOT preparation_satisfied THEN 'closed_baseline_recovery'
    WHEN NOT external_transport_ready THEN 'external_transport_readiness'
    ELSE 'explicit_policy_activation_authorization'
  END,
  'provenance',jsonb_build_object(
    'source','control-broker',
    'sourceId','policy-v2-pilot-preparation:proptimiza',
    'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'synthetic',false
  )
) FROM state
$$;

DO $$
DECLARE state jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM control.policy_v2_external_transport_readiness) THEN
    RAISE EXCEPTION 'POLICY_V2_TRANSPORT_READINESS_MUST_START_EMPTY';
  END IF;
  state:=control.build_policy_v2_pilot_preparation_state();
  IF state->>'activationAllowed'<>'false'
     OR state->>'targetCreationAllowed'<>'false'
     OR state->>'sendAllowed'<>'false'
     OR state->>'a3Enabled'<>'false' THEN
    RAISE EXCEPTION 'POLICY_V2_PREPARATION_GATE_MUST_REMAIN_INERT';
  END IF;
END
$$;

REVOKE ALL ON control.policy_v2_external_transport_readiness
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION control.reject_policy_v2_transport_readiness_mutation(),control.build_policy_v2_pilot_preparation_state()
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON control.policy_v2_pilot_preparation_gate
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT SELECT ON control.policy_v2_pilot_preparation_gate TO commercial_runtime,commercial_observer;
GRANT EXECUTE ON FUNCTION control.build_policy_v2_pilot_preparation_state() TO commercial_runtime;

COMMIT;
