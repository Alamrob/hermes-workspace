BEGIN;

CREATE SCHEMA IF NOT EXISTS integration;
REVOKE ALL ON SCHEMA integration FROM PUBLIC;

CREATE TABLE IF NOT EXISTS integration.sync_control (
  control_id smallint PRIMARY KEY CHECK (control_id = 1),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO integration.sync_control(control_id, enabled)
VALUES (1, false)
ON CONFLICT (control_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS integration.pilot_cohorts (
  cohort_id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES catalog.projects(project_id) ON DELETE RESTRICT,
  cohort_name text NOT NULL CHECK (length(btrim(cohort_name)) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'shadow' CHECK (status IN ('simulation', 'shadow', 'closed')),
  maximum_targets smallint NOT NULL DEFAULT 10 CHECK (maximum_targets BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id, cohort_name)
);

CREATE INDEX IF NOT EXISTS pilot_cohorts_project_id_idx
ON integration.pilot_cohorts(project_id);

CREATE TABLE IF NOT EXISTS integration.pilot_targets (
  target_id uuid PRIMARY KEY,
  cohort_id uuid NOT NULL REFERENCES integration.pilot_cohorts(cohort_id) ON DELETE RESTRICT,
  external_key text NOT NULL CHECK (length(btrim(external_key)) BETWEEN 1 AND 256),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 256),
  attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(cohort_id, external_key),
  UNIQUE(cohort_id, target_id)
);

CREATE INDEX IF NOT EXISTS pilot_targets_cohort_id_idx
ON integration.pilot_targets(cohort_id);

CREATE TABLE IF NOT EXISTS integration.crm_outbox (
  outbox_id uuid PRIMARY KEY,
  cohort_id uuid NOT NULL,
  target_id uuid NOT NULL,
  connector_id text NOT NULL DEFAULT 'twenty' CHECK (connector_id = 'twenty'),
  operation text NOT NULL CHECK (operation IN ('upsert_account', 'upsert_contact', 'append_note')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  source_version bigint NOT NULL CHECK (source_version > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'confirmed', 'failed', 'outcome_unknown')),
  lease_owner text,
  lease_until timestamptz,
  remote_record_id text,
  remote_version text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT crm_outbox_target_fkey FOREIGN KEY(cohort_id, target_id)
    REFERENCES integration.pilot_targets(cohort_id, target_id) ON DELETE RESTRICT,
  UNIQUE(cohort_id, target_id, source_version),
  CHECK ((status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status = 'confirmed') = (remote_record_id IS NOT NULL AND remote_version IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS crm_outbox_target_idx
ON integration.crm_outbox(cohort_id, target_id);
CREATE INDEX IF NOT EXISTS crm_outbox_pending_idx
ON integration.crm_outbox(created_at, outbox_id)
WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS integration.crm_inbox (
  inbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connector_id text NOT NULL CHECK (connector_id = 'twenty'),
  remote_event_id text NOT NULL CHECK (length(btrim(remote_event_id)) BETWEEN 1 AND 256),
  record_type text NOT NULL CHECK (record_type IN ('account', 'contact', 'note')),
  remote_record_id text NOT NULL CHECK (length(btrim(remote_record_id)) BETWEEN 1 AND 256),
  remote_version text NOT NULL CHECK (length(btrim(remote_version)) BETWEEN 1 AND 256),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(connector_id, remote_event_id)
);

CREATE INDEX IF NOT EXISTS crm_inbox_record_idx
ON integration.crm_inbox(connector_id, record_type, remote_record_id);

CREATE TABLE IF NOT EXISTS integration.crm_cursors (
  connector_id text NOT NULL CHECK (connector_id = 'twenty'),
  stream text NOT NULL CHECK (stream IN ('accounts', 'contacts', 'notes')),
  cursor_value text NOT NULL CHECK (length(cursor_value) BETWEEN 1 AND 2048),
  cursor_version bigint NOT NULL CHECK (cursor_version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(connector_id, stream)
);

CREATE OR REPLACE FUNCTION integration.create_pilot_cohort(uuid,text,text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE existing integration.pilot_cohorts%ROWTYPE;
BEGIN
  INSERT INTO integration.pilot_cohorts(cohort_id, project_id, cohort_name)
  VALUES($1, $2, $3)
  ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN $1; END IF;
  SELECT * INTO existing
  FROM integration.pilot_cohorts
  WHERE cohort_id = $1 OR (project_id = $2 AND cohort_name = $3);
  IF existing.cohort_id = $1 AND existing.project_id = $2 AND existing.cohort_name = $3
  THEN RETURN existing.cohort_id;
  END IF;
  RAISE EXCEPTION 'PILOT_COHORT_IDEMPOTENCY_CONFLICT';
END;
$$;

CREATE OR REPLACE FUNCTION integration.add_pilot_target(uuid,uuid,text,text,jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE cohort integration.pilot_cohorts%ROWTYPE;
DECLARE existing integration.pilot_targets%ROWTYPE;
BEGIN
  SELECT * INTO cohort FROM integration.pilot_cohorts WHERE cohort_id = $1 FOR UPDATE;
  IF NOT FOUND OR cohort.status = 'closed' THEN RAISE EXCEPTION 'PILOT_COHORT_UNAVAILABLE'; END IF;
  SELECT * INTO existing
  FROM integration.pilot_targets
  WHERE target_id = $2 OR (cohort_id = $1 AND external_key = $3);
  IF FOUND THEN
    IF existing.target_id = $2 AND existing.cohort_id = $1
       AND existing.external_key = $3 AND existing.display_name = $4
       AND existing.attributes = $5
    THEN RETURN existing.target_id;
    END IF;
    RAISE EXCEPTION 'PILOT_TARGET_IDEMPOTENCY_CONFLICT';
  END IF;
  IF (SELECT count(*) FROM integration.pilot_targets WHERE cohort_id = $1) >= cohort.maximum_targets
  THEN RAISE EXCEPTION 'PILOT_TARGET_LIMIT_EXCEEDED';
  END IF;
  INSERT INTO integration.pilot_targets(target_id, cohort_id, external_key, display_name, attributes)
  VALUES($2, $1, $3, $4, $5);
  RETURN $2;
END;
$$;

CREATE OR REPLACE FUNCTION integration.enqueue_crm_change(uuid,uuid,uuid,text,jsonb,bigint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE existing integration.crm_outbox%ROWTYPE;
BEGIN
  INSERT INTO integration.crm_outbox(outbox_id, cohort_id, target_id, operation, payload, source_version)
  VALUES($1, $2, $3, $4, $5, $6)
  ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN $1; END IF;
  SELECT * INTO existing
  FROM integration.crm_outbox
  WHERE cohort_id = $2 AND target_id = $3 AND source_version = $6;
  IF existing.operation = $4 AND existing.payload = $5 THEN RETURN existing.outbox_id; END IF;
  RAISE EXCEPTION 'CRM_IDEMPOTENCY_CONFLICT';
END;
$$;

CREATE OR REPLACE FUNCTION integration.set_crm_sync_enabled(boolean)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
UPDATE integration.sync_control SET enabled = $1, updated_at = clock_timestamp() WHERE control_id = 1
$$;

CREATE OR REPLACE FUNCTION integration.claim_crm_outbox(text,integer)
RETURNS SETOF integration.crm_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE selected uuid;
DECLARE now_at timestamptz := clock_timestamp();
BEGIN
  IF $1 IS NULL OR btrim($1) = '' OR $2 NOT BETWEEN 5 AND 300
  THEN RAISE EXCEPTION 'INVALID_CRM_LEASE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM integration.sync_control WHERE control_id = 1 AND enabled)
  THEN RAISE EXCEPTION 'CRM_SYNC_DISABLED'; END IF;
  UPDATE integration.crm_outbox
  SET status = 'outcome_unknown', lease_owner = NULL, lease_until = NULL,
      error_code = 'LEASE_EXPIRED_OUTCOME_UNKNOWN', updated_at = now_at
  WHERE status = 'leased' AND lease_until <= now_at;
  SELECT outbox_id INTO selected
  FROM integration.crm_outbox
  WHERE status = 'pending'
  ORDER BY created_at, outbox_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF selected IS NULL THEN RETURN; END IF;
  UPDATE integration.crm_outbox
  SET status = 'leased', lease_owner = $1,
      lease_until = now_at + make_interval(secs => $2), updated_at = now_at
  WHERE outbox_id = selected;
  RETURN QUERY SELECT * FROM integration.crm_outbox WHERE outbox_id = selected;
END;
$$;

CREATE OR REPLACE FUNCTION integration.complete_crm_outbox(uuid,text,text,text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE integration.crm_outbox
  SET status = 'confirmed', lease_owner = NULL, lease_until = NULL,
      remote_record_id = $3, remote_version = $4, updated_at = clock_timestamp()
  WHERE outbox_id = $1 AND status = 'leased' AND lease_owner = $2
    AND lease_until > clock_timestamp();
  IF FOUND THEN RETURN true; END IF;
  RETURN EXISTS(
    SELECT 1 FROM integration.crm_outbox
    WHERE outbox_id = $1 AND status = 'confirmed'
      AND remote_record_id = $3 AND remote_version = $4
  );
END;
$$;

CREATE OR REPLACE FUNCTION integration.store_crm_inbox(text,text,text,text,text,jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE existing integration.crm_inbox%ROWTYPE;
BEGIN
  INSERT INTO integration.crm_inbox(connector_id, remote_event_id, record_type, remote_record_id, remote_version, payload)
  VALUES($1, $2, $3, $4, $5, $6)
  ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN true; END IF;
  SELECT * INTO existing FROM integration.crm_inbox
  WHERE connector_id = $1 AND remote_event_id = $2;
  IF existing.record_type = $3 AND existing.remote_record_id = $4
     AND existing.remote_version = $5 AND existing.payload = $6
  THEN RETURN false;
  END IF;
  RAISE EXCEPTION 'CRM_INBOX_IDEMPOTENCY_CONFLICT';
END;
$$;

CREATE OR REPLACE FUNCTION integration.advance_crm_cursor(text,text,bigint,text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE current_version bigint;
BEGIN
  SELECT cursor_version INTO current_version
  FROM integration.crm_cursors
  WHERE connector_id = $1 AND stream = $2
  FOR UPDATE;
  IF NOT FOUND THEN
    IF $3 <> 0 THEN RAISE EXCEPTION 'CRM_CURSOR_CONFLICT'; END IF;
    INSERT INTO integration.crm_cursors(connector_id, stream, cursor_value, cursor_version)
    VALUES($1, $2, $4, 1);
    RETURN 1;
  END IF;
  IF current_version <> $3 THEN RAISE EXCEPTION 'CRM_CURSOR_CONFLICT'; END IF;
  UPDATE integration.crm_cursors
  SET cursor_value = $4, cursor_version = current_version + 1,
      updated_at = clock_timestamp()
  WHERE connector_id = $1 AND stream = $2;
  RETURN current_version + 1;
END;
$$;

CREATE OR REPLACE VIEW integration.pilot_summaries WITH (security_barrier = true) AS
SELECT c.cohort_id, c.project_id, c.cohort_name, c.status, c.maximum_targets,
       count(t.target_id)::integer AS target_count, c.created_at
FROM integration.pilot_cohorts c
LEFT JOIN integration.pilot_targets t ON t.cohort_id = c.cohort_id
GROUP BY c.cohort_id;

CREATE OR REPLACE VIEW integration.crm_sync_summaries WITH (security_barrier = true) AS
SELECT outbox_id, cohort_id, target_id, connector_id, operation, source_version,
       status, created_at, updated_at
FROM integration.crm_outbox;

DO $$
DECLARE role_name text;
DECLARE unsafe boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('proptimiza-crm-capability-roles'));
  FOREACH role_name IN ARRAY ARRAY['commercial_crm_sync','commercial_crm_observer'] LOOP
    SELECT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
    INTO unsafe FROM pg_roles WHERE rolname = role_name;
    IF NOT FOUND THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', role_name);
    ELSIF unsafe THEN
      RAISE EXCEPTION 'UNSAFE_PREEXISTING_ROLE: %', role_name;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA integration FROM PUBLIC, commercial_runtime,
  commercial_crm_sync, commercial_crm_observer, commercial_safety_operator;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA integration FROM PUBLIC, commercial_runtime,
  commercial_crm_sync, commercial_crm_observer, commercial_safety_operator;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA integration FROM PUBLIC, commercial_runtime,
  commercial_crm_sync, commercial_crm_observer, commercial_safety_operator;
ALTER DEFAULT PRIVILEGES IN SCHEMA integration REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA integration REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA integration TO commercial_runtime, commercial_crm_sync,
  commercial_crm_observer, commercial_safety_operator;
GRANT EXECUTE ON FUNCTION
  integration.create_pilot_cohort(uuid,text,text),
  integration.add_pilot_target(uuid,uuid,text,text,jsonb),
  integration.enqueue_crm_change(uuid,uuid,uuid,text,jsonb,bigint)
TO commercial_runtime;
GRANT EXECUTE ON FUNCTION
  integration.claim_crm_outbox(text,integer),
  integration.complete_crm_outbox(uuid,text,text,text),
  integration.store_crm_inbox(text,text,text,text,text,jsonb),
  integration.advance_crm_cursor(text,text,bigint,text)
TO commercial_crm_sync;
GRANT EXECUTE ON FUNCTION integration.set_crm_sync_enabled(boolean)
TO commercial_safety_operator;
GRANT SELECT ON integration.pilot_summaries, integration.crm_sync_summaries
TO commercial_crm_observer;

COMMIT;
