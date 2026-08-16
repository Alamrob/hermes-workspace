BEGIN;

CREATE SCHEMA IF NOT EXISTS catalog;
REVOKE ALL ON SCHEMA catalog FROM PUBLIC;

CREATE TABLE IF NOT EXISTS catalog.projects (
  project_id text PRIMARY KEY CHECK (project_id ~ '^[a-z][a-z0-9-]{1,63}$'),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS catalog.project_versions (
  project_id text NOT NULL REFERENCES catalog.projects (project_id) ON DELETE RESTRICT,
  version text NOT NULL CHECK (version ~ '^v[0-9]+$'),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, version)
);

CREATE TABLE IF NOT EXISTS catalog.offer_versions (
  project_id text NOT NULL,
  offer_id text NOT NULL CHECK (offer_id ~ '^[a-z][a-z0-9-]{1,127}$'),
  version text NOT NULL CHECK (version ~ '^v[0-9]+$'),
  project_version text NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> ''),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  starting_price numeric(14,2) NOT NULL CHECK (starting_price >= 0),
  description text NOT NULL CHECK (btrim(description) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, offer_id, version),
  CONSTRAINT offer_versions_project_version_fkey
    FOREIGN KEY (project_id, project_version)
    REFERENCES catalog.project_versions (project_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS offer_versions_project_version_idx
  ON catalog.offer_versions (project_id, project_version);

CREATE TABLE IF NOT EXISTS catalog.icp_versions (
  project_id text NOT NULL,
  version text NOT NULL CHECK (version ~ '^v[0-9]+$'),
  project_version text NOT NULL,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  business_model text NOT NULL CHECK (business_model IN ('B2B', 'B2C', 'B2G')),
  sector text NOT NULL CHECK (btrim(sector) <> ''),
  employee_min integer NOT NULL CHECK (employee_min > 0),
  employee_max integer NOT NULL CHECK (employee_max >= employee_min),
  description text NOT NULL CHECK (btrim(description) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, version),
  CONSTRAINT icp_versions_project_version_fkey
    FOREIGN KEY (project_id, project_version)
    REFERENCES catalog.project_versions (project_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS icp_versions_project_version_idx
  ON catalog.icp_versions (project_id, project_version);

CREATE TABLE IF NOT EXISTS catalog.policy_versions (
  project_id text NOT NULL,
  version text NOT NULL CHECK (version ~ '^v[0-9]+$'),
  project_version text NOT NULL,
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, version),
  CONSTRAINT policy_versions_project_version_fkey
    FOREIGN KEY (project_id, project_version)
    REFERENCES catalog.project_versions (project_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS policy_versions_project_version_idx
  ON catalog.policy_versions (project_id, project_version);

CREATE TABLE IF NOT EXISTS control.deployed_versions (
  deployed_version text PRIMARY KEY CHECK (btrim(deployed_version) <> ''),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  deployed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS mail.delivery_policies (
  project_id text NOT NULL,
  policy_version text NOT NULL,
  sender text NOT NULL CHECK (sender = lower(sender) AND sender LIKE '%@%'),
  recipient text NOT NULL CHECK (recipient = lower(recipient) AND recipient LIKE '%@%'),
  maximum_volume integer NOT NULL CHECK (maximum_volume = 1),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, policy_version, sender, recipient),
  CONSTRAINT delivery_policies_policy_version_fkey
    FOREIGN KEY (project_id, policy_version)
    REFERENCES catalog.policy_versions (project_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS external_actions_approval_id_idx
  ON mail.external_actions (approval_id);

CREATE OR REPLACE FUNCTION catalog.reject_versioned_catalog_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'VERSIONED_CATALOG_IMMUTABLE';
END;
$$;

DO $$
DECLARE
  relation_name text;
  trigger_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['project_versions', 'offer_versions', 'icp_versions', 'policy_versions']
  LOOP
    trigger_name := relation_name || '_immutable';
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = trigger_name
        AND tgrelid = format('catalog.%I', relation_name)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON catalog.%I FOR EACH ROW EXECUTE FUNCTION catalog.reject_versioned_catalog_mutation()',
        trigger_name,
        relation_name
      );
    END IF;
  END LOOP;
END;
$$;

INSERT INTO catalog.projects (project_id, display_name)
VALUES ('proptimiza', 'Proptimiza')
ON CONFLICT (project_id) DO NOTHING;

INSERT INTO catalog.project_versions (project_id, version, display_name, status)
VALUES ('proptimiza', 'v1', 'Proptimiza Commercial Control Plane', 'active')
ON CONFLICT (project_id, version) DO NOTHING;

INSERT INTO catalog.offer_versions (
  project_id, offer_id, version, project_version, name, currency, starting_price, description
)
VALUES (
  'proptimiza', 'operacion-sin-planillas', 'v1', 'v1', 'Operación Sin Planillas', 'CLP',
  1800000.00, 'Automatización operacional controlada para empresas chilenas de servicios.'
)
ON CONFLICT (project_id, offer_id, version) DO NOTHING;

INSERT INTO catalog.icp_versions (
  project_id, version, project_version, country_code, business_model, sector,
  employee_min, employee_max, description
)
VALUES (
  'proptimiza', 'v1', 'v1', 'CL', 'B2B', 'services', 10, 100,
  'Empresas chilenas B2B de servicios con 10 a 100 empleados y operaciones manuales.'
)
ON CONFLICT (project_id, version) DO NOTHING;

INSERT INTO catalog.policy_versions (project_id, version, project_version, policy)
VALUES (
  'proptimiza', 'v1', 'v1',
  '{"external_contact":false,"mail_sender":"ventas@proptimiza.com","mail_recipient":"contacto@proptimiza.com","maximum_volume":1}'::jsonb
)
ON CONFLICT (project_id, version) DO NOTHING;

INSERT INTO mail.delivery_policies (
  project_id, policy_version, sender, recipient, maximum_volume, active
)
VALUES (
  'proptimiza', 'v1', 'ventas@proptimiza.com', 'contacto@proptimiza.com', 1, true
)
ON CONFLICT (project_id, policy_version, sender, recipient) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM catalog.offer_versions
    WHERE project_id = 'proptimiza'
      AND offer_id = 'operacion-sin-planillas'
      AND version = 'v1'
      AND name = 'Operación Sin Planillas'
      AND currency = 'CLP'
      AND starting_price = 1800000.00
  ) THEN
    RAISE EXCEPTION 'PROPTIMIZA_OFFER_V1_SEED_CONFLICT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM catalog.icp_versions
    WHERE project_id = 'proptimiza'
      AND version = 'v1'
      AND country_code = 'CL'
      AND business_model = 'B2B'
      AND sector = 'services'
      AND employee_min = 10
      AND employee_max = 100
  ) THEN
    RAISE EXCEPTION 'PROPTIMIZA_ICP_V1_SEED_CONFLICT';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commercial_runtime') THEN
    CREATE ROLE commercial_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commercial_observer') THEN
    CREATE ROLE commercial_observer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA catalog, control, mail TO commercial_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO commercial_runtime;
GRANT SELECT, INSERT, UPDATE ON control.missions, control.approvals, control.kill_switches TO commercial_runtime;
GRANT SELECT, INSERT ON control.audit_events TO commercial_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA control TO commercial_runtime;
GRANT SELECT, INSERT ON mail.webhook_events TO commercial_runtime;
GRANT SELECT, INSERT, UPDATE ON mail.external_actions TO commercial_runtime;
GRANT SELECT ON mail.delivery_policies TO commercial_runtime;

GRANT USAGE ON SCHEMA catalog, control, mail TO commercial_observer;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog, control, mail TO commercial_observer;

REVOKE ALL ON ALL TABLES IN SCHEMA catalog FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA catalog FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog GRANT SELECT ON TABLES TO commercial_observer;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog GRANT SELECT ON TABLES TO commercial_runtime;

COMMIT;
