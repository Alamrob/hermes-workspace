BEGIN;

CREATE TABLE control.policy_activation_authorizations (
  authorization_id uuid PRIMARY KEY,
  project_id text NOT NULL CHECK (project_id='proptimiza'),
  policy_version text NOT NULL CHECK (policy_version='policy-v2'),
  decision text NOT NULL CHECK (decision='approved'),
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 20 AND 2000),
  authorized_by text NOT NULL CHECK (authorized_by ~ '^[A-Za-z0-9._:@+-]{3,254}$'),
  authorized_email text NOT NULL CHECK (authorized_email='proptimizaspa@gmail.com'),
  authorized_at timestamptz NOT NULL,
  policy_digest text NOT NULL CHECK (policy_digest='888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19'),
  authorization_scope jsonb NOT NULL CHECK (jsonb_typeof(authorization_scope)='object'),
  idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key ~ '^policy-activation:[A-Za-z0-9._:-]{8,103}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,policy_version),
  FOREIGN KEY(project_id,policy_version) REFERENCES catalog.policy_versions(project_id,version) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION control.reject_policy_activation_authorization_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'POLICY_ACTIVATION_AUTHORIZATION_IMMUTABLE'; END
$$;

CREATE TRIGGER policy_activation_authorizations_immutable
BEFORE UPDATE OR DELETE ON control.policy_activation_authorizations
FOR EACH ROW EXECUTE FUNCTION control.reject_policy_activation_authorization_mutation();

CREATE OR REPLACE FUNCTION control.build_policy_activation_dossier_state() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
WITH review AS (
  SELECT control.build_policy_review_state() AS state
), policy AS (
  SELECT p.policy
  FROM catalog.policy_versions p
  WHERE p.project_id='proptimiza' AND p.version='policy-v2'
), active AS (
  SELECT policy_version FROM catalog.current_version_activation WHERE project_id='proptimiza'
), facts AS (
  SELECT
    EXISTS(SELECT 1 FROM control.policy_activation_authorizations WHERE project_id='proptimiza' AND policy_version='policy-v2') AS authorization_recorded,
    EXISTS(SELECT 1 FROM mail.internal_mail_attestations WHERE project_id='proptimiza' AND verification_status='verified') AS internal_mail_attested,
    EXISTS(SELECT 1 FROM catalog.version_activations WHERE project_id='proptimiza' AND policy_version='policy-v2') AS version_activation_created,
    EXISTS(SELECT 1 FROM mail.delivery_policies WHERE project_id='proptimiza' AND policy_version='policy-v2') AS delivery_policy_created,
    EXISTS(SELECT 1 FROM mail.delivery_policy_activations WHERE project_id='proptimiza' AND policy_version='policy-v2') AS delivery_activation_created,
    EXISTS(SELECT 1 FROM control.kill_switches WHERE scope='global' AND scope_id='*' AND active) AS global_kill_switch_active,
    EXISTS(SELECT 1 FROM control.kill_switches WHERE scope='channel' AND scope_id='email' AND active) AS email_kill_switch_active
), state AS (
  SELECT
    (review.state->>'reviewCompleted')::boolean AS review_completed,
    active.policy_version AS active_policy_version,
    (policy.policy->>'effective')::boolean AS policy_effective,
    (policy.policy->>'external_contact')::boolean AS external_contact,
    facts.*
  FROM review CROSS JOIN policy CROSS JOIN active CROSS JOIN facts
)
SELECT jsonb_build_object(
  'projectId','proptimiza',
  'policyVersion','policy-v2',
  'policyDigest','888988d6359694300e9d0970d7ad7166b989727b08000d5969d61a66c920ff19',
  'reviewCompleted',state.review_completed,
  'authorizationRecorded',state.authorization_recorded,
  'internalMailAttested',state.internal_mail_attested,
  'activePolicyVersion',state.active_policy_version,
  'policyEffective',state.policy_effective,
  'externalContact',state.external_contact,
  'versionActivationCreated',state.version_activation_created,
  'deliveryPolicyCreated',state.delivery_policy_created,
  'deliveryPolicyActivationCreated',state.delivery_activation_created,
  'globalKillSwitchActive',state.global_kill_switch_active,
  'emailKillSwitchActive',state.email_kill_switch_active,
  'databaseGateSatisfied',(
    state.review_completed AND state.authorization_recorded AND state.internal_mail_attested
    AND state.active_policy_version='policy-v1' AND state.policy_effective=false AND state.external_contact=false
    AND NOT state.version_activation_created AND NOT state.delivery_policy_created AND NOT state.delivery_activation_created
    AND state.global_kill_switch_active AND state.email_kill_switch_active
  ),
  'activationAllowed',false,
  'nextRequiredGate',CASE
    WHEN NOT state.review_completed THEN 'human_reviews'
    WHEN NOT state.internal_mail_attested THEN 'internal_mail_attestation'
    WHEN NOT state.authorization_recorded THEN 'explicit_activation_authorization'
    ELSE 'external_transport_readiness'
  END,
  'provenance',jsonb_build_object(
    'source','control-broker',
    'sourceId','policy-activation-dossier:proptimiza:policy-v2',
    'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'synthetic',false
  )
)
FROM state
$$;

DO $$
DECLARE state jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM control.policy_activation_authorizations) THEN
    RAISE EXCEPTION 'POLICY_ACTIVATION_AUTHORIZATION_MUST_START_EMPTY';
  END IF;
  state:=control.build_policy_activation_dossier_state();
  IF state->>'authorizationRecorded'<>'false' OR state->>'policyEffective'<>'false' OR
     state->>'externalContact'<>'false' OR state->>'activePolicyVersion'<>'policy-v1' OR
     state->>'versionActivationCreated'<>'false' OR state->>'deliveryPolicyCreated'<>'false' OR
     state->>'deliveryPolicyActivationCreated'<>'false' OR state->>'activationAllowed'<>'false' THEN
    RAISE EXCEPTION 'POLICY_ACTIVATION_DOSSIER_INITIAL_STATE_INVALID';
  END IF;
END
$$;

REVOKE ALL ON control.policy_activation_authorizations
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
REVOKE ALL ON FUNCTION control.reject_policy_activation_authorization_mutation(),control.build_policy_activation_dossier_state()
FROM PUBLIC,commercial_runtime,commercial_work_order_ingestor,commercial_approver,commercial_safety_operator,commercial_observer;
GRANT EXECUTE ON FUNCTION control.build_policy_activation_dossier_state() TO commercial_runtime;

COMMIT;
