\set ON_ERROR_STOP on

-- Cluster-admin bootstrap. This creates a new, marked database; it never
-- changes ACLs on an existing runtime, CRM, n8n, postgres, or template DB.
\connect postgres
SET statement_timeout='10s';
SET lock_timeout='2s';

SELECT 'CREATE ROLE proptimiza_commercial_authority_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS(
  SELECT 1 FROM pg_roles WHERE rolname='proptimiza_commercial_authority_owner'
) \gexec

DO $$ BEGIN
  IF EXISTS(
    SELECT 1 FROM pg_roles
    WHERE rolname='proptimiza_commercial_authority_owner'
      AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole
        OR rolreplication OR rolbypassrls)
  ) OR EXISTS(
    SELECT 1 FROM pg_auth_members
    WHERE member=(SELECT oid FROM pg_roles
      WHERE rolname='proptimiza_commercial_authority_owner')
  ) OR EXISTS(
    SELECT 1 FROM pg_database database
    WHERE database.datname<>'proptimiza_commercial_authority'
      AND database.datdba=(SELECT oid FROM pg_roles
        WHERE rolname='proptimiza_commercial_authority_owner')
  ) THEN RAISE EXCEPTION 'UNSAFE_COMMERCIAL_AUTHORITY_OWNER'; END IF;
  IF EXISTS(
    SELECT 1 FROM pg_database database
    WHERE database.datname='proptimiza_commercial_authority'
      AND (pg_get_userbyid(database.datdba)<>'proptimiza_commercial_authority_owner'
        OR coalesce(obj_description(database.oid,'pg_database'),'')
          <>'proptimiza:commercial-authority:v1')
  ) THEN RAISE EXCEPTION 'EXISTING_DATABASE_IS_NOT_DEDICATED_AUTHORITY'; END IF;
END $$;

SELECT 'CREATE DATABASE proptimiza_commercial_authority OWNER proptimiza_commercial_authority_owner TEMPLATE template0'
WHERE NOT EXISTS(
  SELECT 1 FROM pg_database WHERE datname='proptimiza_commercial_authority'
) \gexec

COMMENT ON DATABASE proptimiza_commercial_authority
IS 'proptimiza:commercial-authority:v1';
REVOKE ALL ON DATABASE proptimiza_commercial_authority FROM PUBLIC;

-- Apply every runtime migration through 038 to this exact database before
-- running provision-a0-behavior-ledger-principal.sql. Authentication secrets
-- and pg_hba rules remain deployment-boundary inputs and are never in Git.
