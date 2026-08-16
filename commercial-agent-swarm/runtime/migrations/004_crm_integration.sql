BEGIN;

CREATE SCHEMA IF NOT EXISTS integration;
REVOKE ALL ON SCHEMA integration FROM PUBLIC;

CREATE TABLE IF NOT EXISTS integration.sync_control (
  control_id smallint PRIMARY KEY CHECK (control_id = 1),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO integration.sync_control(control_id, enabled)
VALUES (1, false) ON CONFLICT (control_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS control.approval_channel_evidence (
  approval_id uuid NOT NULL REFERENCES control.approvals(approval_id) ON DELETE RESTRICT,
  action_hash text NOT NULL CHECK (action_hash ~ '^[0-9a-f]{64}$'),
  channel text NOT NULL CHECK (channel IN ('sales', 'telegram')),
  decision text NOT NULL CHECK (decision IN ('approved', 'denied')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128 AND actor_id ~ '^[A-Za-z0-9._:@-]+$'),
  decided_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(approval_id, channel)
);

CREATE TABLE IF NOT EXISTS control.pilot_cohorts (
  cohort_id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES catalog.projects(project_id) ON DELETE RESTRICT,
  cohort_name text NOT NULL CHECK (length(btrim(cohort_name)) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'shadow' CHECK (status IN ('simulation', 'shadow', 'closed')),
  maximum_targets smallint NOT NULL DEFAULT 10 CHECK (maximum_targets BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id, cohort_name),
  UNIQUE(cohort_id, project_id)
);
CREATE INDEX IF NOT EXISTS pilot_cohorts_project_id_idx ON control.pilot_cohorts(project_id);

CREATE TABLE IF NOT EXISTS control.pilot_suppressions (
  control_ref text PRIMARY KEY CHECK (length(control_ref) BETWEEN 1 AND 256 AND control_ref ~ '^[A-Za-z0-9._:-]+$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 128),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 512 AND evidence_ref ~ '^[A-Za-z0-9._:/-]+$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS control.pilot_targets (
  target_id uuid PRIMARY KEY,
  cohort_id uuid NOT NULL,
  project_id text NOT NULL,
  control_ref text NOT NULL UNIQUE CHECK (length(control_ref) BETWEEN 1 AND 256 AND control_ref ~ '^[A-Za-z0-9._:-]+$'),
  company_ref text CHECK (company_ref IS NULL OR (length(company_ref) BETWEEN 1 AND 256 AND company_ref ~ '^[A-Za-z0-9._:-]+$')),
  person_ref text CHECK (person_ref IS NULL OR (length(person_ref) BETWEEN 1 AND 256 AND person_ref ~ '^[A-Za-z0-9._:-]+$')),
  opportunity_ref text CHECK (opportunity_ref IS NULL OR (length(opportunity_ref) BETWEEN 1 AND 256 AND opportunity_ref ~ '^[A-Za-z0-9._:-]+$')),
  offer_id text NOT NULL,
  offer_version text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('crm', 'email', 'whatsapp', 'calendar', 'web_chat', 'telephone', 'internal')),
  admission_state text NOT NULL CHECK (admission_state IN ('candidate', 'admitted', 'rejected', 'expired')),
  action_state text NOT NULL CHECK (action_state IN ('none', 'draft', 'approval_pending', 'approved', 'executed', 'blocked')),
  expires_at timestamptz NOT NULL,
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 512 AND evidence_ref ~ '^[A-Za-z0-9._:/-]+$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pilot_targets_cohort_fkey FOREIGN KEY(cohort_id, project_id)
    REFERENCES control.pilot_cohorts(cohort_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT pilot_targets_offer_fkey FOREIGN KEY(project_id, offer_id, offer_version)
    REFERENCES catalog.offer_versions(project_id, offer_id, version) ON DELETE RESTRICT,
  UNIQUE(cohort_id, target_id),
  CHECK (company_ref IS NOT NULL OR person_ref IS NOT NULL OR opportunity_ref IS NOT NULL),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS pilot_targets_cohort_idx ON control.pilot_targets(cohort_id, project_id);
CREATE INDEX IF NOT EXISTS pilot_targets_offer_idx ON control.pilot_targets(project_id, offer_id, offer_version);

CREATE TABLE IF NOT EXISTS integration.crm_entity_links (
  target_id uuid NOT NULL REFERENCES control.pilot_targets(target_id) ON DELETE RESTRICT,
  connector_id text NOT NULL CHECK (connector_id = 'twenty'),
  entity_type text NOT NULL CHECK (entity_type IN ('pilot_target', 'account', 'contact', 'opportunity', 'note')),
  remote_record_id text NOT NULL CHECK (length(btrim(remote_record_id)) BETWEEN 1 AND 256),
  remote_version text NOT NULL CHECK (length(btrim(remote_version)) BETWEEN 1 AND 256),
  synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(target_id, connector_id, entity_type),
  UNIQUE(connector_id, entity_type, remote_record_id)
);
CREATE INDEX IF NOT EXISTS crm_entity_links_target_idx ON integration.crm_entity_links(target_id);

CREATE TABLE IF NOT EXISTS integration.crm_outbox (
  outbox_id uuid PRIMARY KEY,
  cohort_id uuid NOT NULL,
  target_id uuid NOT NULL,
  connector_id text NOT NULL DEFAULT 'twenty' CHECK (connector_id = 'twenty'),
  operation text NOT NULL CHECK (operation IN ('mirror_pilot_target', 'upsert_account', 'upsert_contact', 'append_note')),
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
    REFERENCES control.pilot_targets(cohort_id, target_id) ON DELETE RESTRICT,
  UNIQUE(cohort_id, target_id, source_version),
  CHECK ((status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status = 'confirmed') = (remote_record_id IS NOT NULL AND remote_version IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS crm_outbox_target_idx ON integration.crm_outbox(cohort_id, target_id);
CREATE INDEX IF NOT EXISTS crm_outbox_pending_idx ON integration.crm_outbox(created_at, outbox_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS integration.crm_inbox (
  inbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connector_id text NOT NULL CHECK (connector_id = 'twenty'),
  remote_event_id text NOT NULL CHECK (length(btrim(remote_event_id)) BETWEEN 1 AND 256),
  record_type text NOT NULL CHECK (record_type IN ('pilot_target', 'account', 'contact', 'opportunity', 'note')),
  remote_record_id text NOT NULL CHECK (length(btrim(remote_record_id)) BETWEEN 1 AND 256),
  remote_version text NOT NULL CHECK (length(btrim(remote_version)) BETWEEN 1 AND 256),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(connector_id, remote_event_id)
);
CREATE INDEX IF NOT EXISTS crm_inbox_record_idx ON integration.crm_inbox(connector_id, record_type, remote_record_id);

CREATE TABLE IF NOT EXISTS integration.crm_sync_cursors (
  connector_id text NOT NULL CHECK (connector_id = 'twenty'),
  stream text NOT NULL CHECK (stream IN ('pilot_targets', 'accounts', 'contacts', 'opportunities', 'notes')),
  cursor_value text NOT NULL CHECK (length(cursor_value) BETWEEN 1 AND 2048),
  cursor_version bigint NOT NULL CHECK (cursor_version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(connector_id, stream)
);

CREATE OR REPLACE FUNCTION control.create_pilot_cohort(uuid,text,text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing control.pilot_cohorts%ROWTYPE;
BEGIN
 INSERT INTO control.pilot_cohorts(cohort_id,project_id,cohort_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING;
 IF FOUND THEN RETURN $1; END IF;
 SELECT * INTO existing FROM control.pilot_cohorts WHERE cohort_id=$1 OR(project_id=$2 AND cohort_name=$3);
 IF existing.cohort_id=$1 AND existing.project_id=$2 AND existing.cohort_name=$3 THEN RETURN existing.cohort_id; END IF;
 RAISE EXCEPTION 'PILOT_COHORT_IDEMPOTENCY_CONFLICT';
END $$;

CREATE OR REPLACE FUNCTION control.record_approval_channel_evidence(uuid,text,text,text,text,timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expected_hash text;DECLARE existing control.approval_channel_evidence%ROWTYPE;
BEGIN
 SELECT action_hash INTO expected_hash FROM control.approvals WHERE approval_id=$1 AND status='pending' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_NOT_PENDING';END IF;
 IF expected_hash<>$2 THEN RAISE EXCEPTION 'APPROVAL_EVIDENCE_HASH_MISMATCH';END IF;
 INSERT INTO control.approval_channel_evidence(approval_id,action_hash,channel,decision,actor_id,decided_at)
 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING;
 IF FOUND THEN RETURN true;END IF;
 SELECT * INTO existing FROM control.approval_channel_evidence WHERE approval_id=$1 AND channel=$3;
 IF existing.action_hash=$2 AND existing.decision=$4 AND existing.actor_id=$5 AND existing.decided_at=$6 THEN RETURN true;END IF;
 RAISE EXCEPTION 'APPROVAL_EVIDENCE_CONFLICT';
END $$;

CREATE OR REPLACE FUNCTION control.list_approval_channel_evidence(uuid) RETURNS SETOF control.approval_channel_evidence
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT * FROM control.approval_channel_evidence WHERE approval_id=$1 ORDER BY channel
$$;

CREATE OR REPLACE FUNCTION control.add_pilot_suppression(text,text,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing control.pilot_suppressions%ROWTYPE;
BEGIN
 INSERT INTO control.pilot_suppressions(control_ref,reason,evidence_ref) VALUES($1,$2,$3) ON CONFLICT DO NOTHING;
 IF FOUND THEN RETURN true; END IF;
 SELECT * INTO existing FROM control.pilot_suppressions WHERE control_ref=$1;
 IF existing.reason=$2 AND existing.evidence_ref=$3 THEN RETURN false; END IF;
 RAISE EXCEPTION 'PILOT_SUPPRESSION_CONFLICT';
END $$;

CREATE OR REPLACE FUNCTION control.add_pilot_target(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz,text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cohort control.pilot_cohorts%ROWTYPE;DECLARE existing control.pilot_targets%ROWTYPE;
BEGIN
 SELECT * INTO cohort FROM control.pilot_cohorts WHERE cohort_id=$2 FOR UPDATE;
 IF NOT FOUND OR cohort.status='closed' THEN RAISE EXCEPTION 'PILOT_COHORT_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM control.pilot_suppressions WHERE control_ref=$3) THEN RAISE EXCEPTION 'PILOT_TARGET_SUPPRESSED'; END IF;
 SELECT * INTO existing FROM control.pilot_targets WHERE target_id=$1 OR control_ref=$3;
 IF FOUND THEN
  IF existing.target_id=$1 AND existing.cohort_id=$2 AND existing.control_ref=$3 AND existing.company_ref IS NOT DISTINCT FROM $4 AND existing.person_ref IS NOT DISTINCT FROM $5 AND existing.opportunity_ref IS NOT DISTINCT FROM $6 AND existing.offer_id=$7 AND existing.offer_version=$8 AND existing.channel=$9 AND existing.admission_state=$10 AND existing.action_state=$11 AND existing.expires_at=$12 AND existing.evidence_ref=$13 THEN RETURN existing.target_id;END IF;
  RAISE EXCEPTION 'PILOT_TARGET_IDEMPOTENCY_CONFLICT';
 END IF;
 IF(SELECT count(*) FROM control.pilot_targets WHERE cohort_id=$2)>=cohort.maximum_targets THEN RAISE EXCEPTION 'PILOT_TARGET_LIMIT_EXCEEDED';END IF;
 INSERT INTO control.pilot_targets(target_id,cohort_id,project_id,control_ref,company_ref,person_ref,opportunity_ref,offer_id,offer_version,channel,admission_state,action_state,expires_at,evidence_ref)
 VALUES($1,$2,cohort.project_id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13);
 RETURN $1;
END $$;

CREATE OR REPLACE FUNCTION integration.enqueue_crm_change(uuid,uuid,uuid,text,jsonb,bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing integration.crm_outbox%ROWTYPE;
BEGIN
 INSERT INTO integration.crm_outbox(outbox_id,cohort_id,target_id,operation,payload,source_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING;
 IF FOUND THEN RETURN $1;END IF;
 SELECT * INTO existing FROM integration.crm_outbox WHERE cohort_id=$2 AND target_id=$3 AND source_version=$6;
 IF existing.operation=$4 AND existing.payload=$5 THEN RETURN existing.outbox_id;END IF;
 RAISE EXCEPTION 'CRM_IDEMPOTENCY_CONFLICT';
END $$;

CREATE OR REPLACE FUNCTION integration.set_crm_sync_enabled(boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$UPDATE integration.sync_control SET enabled=$1,updated_at=clock_timestamp() WHERE control_id=1$$;

CREATE OR REPLACE FUNCTION integration.claim_crm_outbox(text,integer) RETURNS SETOF integration.crm_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected uuid;DECLARE now_at timestamptz:=clock_timestamp();
BEGIN
 IF $1 IS NULL OR btrim($1)='' OR $2 NOT BETWEEN 5 AND 300 THEN RAISE EXCEPTION 'INVALID_CRM_LEASE';END IF;
 IF NOT EXISTS(SELECT 1 FROM integration.sync_control WHERE control_id=1 AND enabled) THEN RAISE EXCEPTION 'CRM_SYNC_DISABLED';END IF;
 UPDATE integration.crm_outbox SET status='outcome_unknown',lease_owner=NULL,lease_until=NULL,error_code='LEASE_EXPIRED_OUTCOME_UNKNOWN',updated_at=now_at WHERE status='leased'AND lease_until<=now_at;
 SELECT outbox_id INTO selected FROM integration.crm_outbox WHERE status='pending' ORDER BY created_at,outbox_id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF selected IS NULL THEN RETURN;END IF;
 UPDATE integration.crm_outbox SET status='leased',lease_owner=$1,lease_until=now_at+make_interval(secs=>$2),updated_at=now_at WHERE outbox_id=selected;
 RETURN QUERY SELECT * FROM integration.crm_outbox WHERE outbox_id=selected;
END $$;

CREATE OR REPLACE FUNCTION integration.complete_crm_outbox(uuid,text,text,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integration.crm_outbox%ROWTYPE;DECLARE link_type text;
BEGIN
 UPDATE integration.crm_outbox SET status='confirmed',lease_owner=NULL,lease_until=NULL,remote_record_id=$3,remote_version=$4,updated_at=clock_timestamp()
 WHERE outbox_id=$1 AND status='leased'AND lease_owner=$2 AND lease_until>clock_timestamp() RETURNING * INTO changed;
 IF FOUND THEN
  link_type:=CASE changed.operation WHEN'mirror_pilot_target'THEN'pilot_target'WHEN'upsert_account'THEN'account'WHEN'upsert_contact'THEN'contact'ELSE'note'END;
  INSERT INTO integration.crm_entity_links(target_id,connector_id,entity_type,remote_record_id,remote_version)
  VALUES(changed.target_id,'twenty',link_type,$3,$4)
  ON CONFLICT(target_id,connector_id,entity_type)DO UPDATE SET remote_record_id=EXCLUDED.remote_record_id,remote_version=EXCLUDED.remote_version,synced_at=clock_timestamp();
  RETURN true;
 END IF;
 RETURN EXISTS(SELECT 1 FROM integration.crm_outbox WHERE outbox_id=$1 AND status='confirmed'AND remote_record_id=$3 AND remote_version=$4);
END $$;

CREATE OR REPLACE FUNCTION integration.mark_crm_outbox_outcome_unknown(uuid,text,text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF $3<>'TWENTY_OUTCOME_UNKNOWN'THEN RAISE EXCEPTION'INVALID_CRM_OUTCOME_ERROR';END IF;
 UPDATE integration.crm_outbox SET status='outcome_unknown',lease_owner=NULL,lease_until=NULL,error_code=$3,updated_at=clock_timestamp() WHERE outbox_id=$1 AND status='leased'AND lease_owner=$2;
 IF FOUND THEN RETURN true;END IF;
 RETURN EXISTS(SELECT 1 FROM integration.crm_outbox WHERE outbox_id=$1 AND status='outcome_unknown'AND error_code=$3);
END $$;

CREATE OR REPLACE FUNCTION integration.store_crm_inbox(text,text,text,text,text,jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing integration.crm_inbox%ROWTYPE;
BEGIN
 INSERT INTO integration.crm_inbox(connector_id,remote_event_id,record_type,remote_record_id,remote_version,payload)VALUES($1,$2,$3,$4,$5,$6)ON CONFLICT DO NOTHING;
 IF FOUND THEN RETURN true;END IF;
 SELECT * INTO existing FROM integration.crm_inbox WHERE connector_id=$1 AND remote_event_id=$2;
 IF existing.record_type=$3 AND existing.remote_record_id=$4 AND existing.remote_version=$5 AND existing.payload=$6 THEN RETURN false;END IF;
 RAISE EXCEPTION'CRM_INBOX_IDEMPOTENCY_CONFLICT';
END $$;

CREATE OR REPLACE FUNCTION integration.advance_crm_cursor(text,text,bigint,text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_version bigint;
BEGIN
 SELECT cursor_version INTO current_version FROM integration.crm_sync_cursors WHERE connector_id=$1 AND stream=$2 FOR UPDATE;
 IF NOT FOUND THEN IF $3<>0 THEN RAISE EXCEPTION'CRM_CURSOR_CONFLICT';END IF;INSERT INTO integration.crm_sync_cursors(connector_id,stream,cursor_value,cursor_version)VALUES($1,$2,$4,1);RETURN 1;END IF;
 IF current_version<>$3 THEN RAISE EXCEPTION'CRM_CURSOR_CONFLICT';END IF;
 UPDATE integration.crm_sync_cursors SET cursor_value=$4,cursor_version=current_version+1,updated_at=clock_timestamp()WHERE connector_id=$1 AND stream=$2;
 RETURN current_version+1;
END $$;

CREATE OR REPLACE VIEW control.pilot_cohort_summaries WITH(security_barrier=true)AS
SELECT c.cohort_id,c.project_id,c.cohort_name,c.status,c.maximum_targets,count(t.target_id)::integer AS target_count,c.created_at
FROM control.pilot_cohorts c LEFT JOIN control.pilot_targets t ON t.cohort_id=c.cohort_id GROUP BY c.cohort_id;
CREATE OR REPLACE VIEW integration.crm_sync_summaries WITH(security_barrier=true)AS
SELECT outbox_id,cohort_id,target_id,connector_id,operation,source_version,status,created_at,updated_at FROM integration.crm_outbox;

DO $$DECLARE role_name text;DECLARE unsafe boolean;BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('proptimiza-crm-capability-roles'));
 FOREACH role_name IN ARRAY ARRAY['commercial_crm_sync','commercial_crm_observer','commercial_approval_evidence']LOOP
  SELECT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls INTO unsafe FROM pg_roles WHERE rolname=role_name;
  IF NOT FOUND THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);ELSIF unsafe THEN RAISE EXCEPTION'UNSAFE_PREEXISTING_ROLE: %',role_name;END IF;
 END LOOP;
END $$;

REVOKE ALL ON control.approval_channel_evidence,control.pilot_cohorts,control.pilot_targets,control.pilot_suppressions,integration.sync_control,integration.crm_entity_links,integration.crm_outbox,integration.crm_inbox,integration.crm_sync_cursors FROM PUBLIC,commercial_runtime,commercial_crm_sync,commercial_crm_observer,commercial_safety_operator,commercial_approval_evidence;
REVOKE ALL ON SEQUENCE integration.crm_inbox_inbox_id_seq FROM PUBLIC,commercial_runtime,commercial_crm_sync,commercial_crm_observer,commercial_safety_operator;
REVOKE ALL ON FUNCTION control.record_approval_channel_evidence(uuid,text,text,text,text,timestamptz),control.list_approval_channel_evidence(uuid),control.create_pilot_cohort(uuid,text,text),control.add_pilot_suppression(text,text,text),control.add_pilot_target(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz,text),integration.enqueue_crm_change(uuid,uuid,uuid,text,jsonb,bigint),integration.set_crm_sync_enabled(boolean),integration.claim_crm_outbox(text,integer),integration.complete_crm_outbox(uuid,text,text,text),integration.mark_crm_outbox_outcome_unknown(uuid,text,text),integration.store_crm_inbox(text,text,text,text,text,jsonb),integration.advance_crm_cursor(text,text,bigint,text) FROM PUBLIC,commercial_runtime,commercial_crm_sync,commercial_crm_observer,commercial_safety_operator,commercial_approval_evidence;
ALTER DEFAULT PRIVILEGES IN SCHEMA integration REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA integration REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA control,integration TO commercial_runtime;
GRANT EXECUTE ON FUNCTION control.create_pilot_cohort(uuid,text,text),control.add_pilot_target(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz,text),integration.enqueue_crm_change(uuid,uuid,uuid,text,jsonb,bigint) TO commercial_runtime;
GRANT USAGE ON SCHEMA integration TO commercial_crm_sync,commercial_crm_observer,commercial_safety_operator;
GRANT USAGE ON SCHEMA control TO commercial_crm_observer;
GRANT USAGE ON SCHEMA control TO commercial_approval_evidence;
GRANT EXECUTE ON FUNCTION control.record_approval_channel_evidence(uuid,text,text,text,text,timestamptz),control.list_approval_channel_evidence(uuid) TO commercial_approval_evidence;
GRANT EXECUTE ON FUNCTION integration.claim_crm_outbox(text,integer),integration.complete_crm_outbox(uuid,text,text,text),integration.mark_crm_outbox_outcome_unknown(uuid,text,text),integration.store_crm_inbox(text,text,text,text,text,jsonb),integration.advance_crm_cursor(text,text,bigint,text) TO commercial_crm_sync;
GRANT EXECUTE ON FUNCTION control.add_pilot_suppression(text,text,text),integration.set_crm_sync_enabled(boolean) TO commercial_safety_operator;
GRANT SELECT ON control.pilot_cohort_summaries TO commercial_crm_observer;
GRANT SELECT ON integration.crm_sync_summaries TO commercial_crm_observer;

COMMIT;
