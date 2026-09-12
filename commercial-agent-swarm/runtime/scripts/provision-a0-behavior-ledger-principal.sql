\set ON_ERROR_STOP on

-- Run as the database owner after migration 038. The LOGIN intentionally has
-- no password in source control: use certificate/peer auth or inject a password
-- through the deployment secret boundary after this least-privilege setup.
BEGIN;

SELECT 'CREATE ROLE proptimiza_a0_behavior_ledger_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS(
  SELECT 1 FROM pg_roles WHERE rolname='proptimiza_a0_behavior_ledger_login'
) \gexec

DO $$ BEGIN
  IF EXISTS(
    SELECT 1 FROM pg_roles
    WHERE rolname='proptimiza_a0_behavior_ledger_login'
      AND (NOT rolcanlogin OR NOT rolinherit OR rolsuper OR rolcreatedb
        OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) OR EXISTS(
    SELECT 1 FROM pg_auth_members membership
    WHERE membership.member=(
      SELECT oid FROM pg_roles WHERE rolname='proptimiza_a0_behavior_ledger_login'
    ) AND (membership.admin_option OR membership.roleid<>(
      SELECT oid FROM pg_roles WHERE rolname='commercial_a0_behavior_ledger'
    ))
  ) THEN RAISE EXCEPTION 'UNSAFE_A0_BEHAVIOR_LEDGER_LOGIN'; END IF;
END $$;

SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',current_database()) \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM proptimiza_a0_behavior_ledger_login',current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO proptimiza_a0_behavior_ledger_login',current_database()) \gexec
REVOKE ALL ON SCHEMA public,catalog,control,mail,integration
FROM proptimiza_a0_behavior_ledger_login;
REVOKE ALL ON ALL TABLES IN SCHEMA catalog,control,mail,integration
FROM proptimiza_a0_behavior_ledger_login;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA catalog,control,mail,integration
FROM proptimiza_a0_behavior_ledger_login;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA catalog,control,mail,integration
FROM proptimiza_a0_behavior_ledger_login;
GRANT commercial_a0_behavior_ledger TO proptimiza_a0_behavior_ledger_login;

COMMIT;
