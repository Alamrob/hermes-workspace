-- Integration-test fixture only. Production provisioning is performed by the
-- sealed host provisioner, which creates a SCRAM secret in memory, limits the
-- login to one connection, updates PgBouncer and probes the effective grants.
-- This secret-free fixture fails closed unless the test harness opts in through
-- PGOPTIONS=-c proptimiza.allow_secret_free_a0_test_login=on.
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='2s';

DO $$ BEGIN
  IF current_setting('proptimiza.allow_secret_free_a0_test_login',true)<>'on'
  THEN RAISE EXCEPTION 'A0_SECRET_FREE_TEST_LOGIN_FORBIDDEN'; END IF;

  IF current_database()<>'proptimiza_commercial_authority'
    OR NOT EXISTS(
      SELECT 1 FROM pg_database database
      WHERE database.datname=current_database()
        AND pg_get_userbyid(database.datdba)='proptimiza_commercial_authority_owner'
        AND coalesce(shobj_description(database.oid,'pg_database'),'')
          ='proptimiza:commercial-authority:v1'
    )
    OR (SELECT count(*) FROM control.schema_migrations
      WHERE version IN('038_a0_behavior_authority','039_a0_behavior_task_results'))<>2
  THEN RAISE EXCEPTION 'A0_AUTHORITY_DATABASE_NOT_DEDICATED'; END IF;
END $$;

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
  ) OR EXISTS(
    SELECT 1 FROM pg_database database
    WHERE database.datdba=(SELECT oid FROM pg_roles
      WHERE rolname='proptimiza_a0_behavior_ledger_login')
  ) OR EXISTS(
    SELECT 1 FROM pg_namespace namespace
    WHERE namespace.nspowner=(SELECT oid FROM pg_roles
      WHERE rolname='proptimiza_a0_behavior_ledger_login')
  ) OR EXISTS(
    SELECT 1 FROM pg_class object
    WHERE object.relowner=(SELECT oid FROM pg_roles
      WHERE rolname='proptimiza_a0_behavior_ledger_login')
  ) OR EXISTS(
    SELECT 1 FROM pg_proc routine
    WHERE routine.proowner=(SELECT oid FROM pg_roles
      WHERE rolname='proptimiza_a0_behavior_ledger_login')
  ) THEN RAISE EXCEPTION 'UNSAFE_A0_BEHAVIOR_LEDGER_LOGIN'; END IF;
END $$;

REVOKE ALL ON DATABASE proptimiza_commercial_authority FROM PUBLIC;
REVOKE ALL ON DATABASE proptimiza_commercial_authority
FROM proptimiza_a0_behavior_ledger_login;
GRANT CONNECT ON DATABASE proptimiza_commercial_authority
TO proptimiza_a0_behavior_ledger_login;
REVOKE ALL ON SCHEMA public,catalog,control,mail,integration
FROM proptimiza_a0_behavior_ledger_login;
REVOKE ALL ON ALL TABLES IN SCHEMA public,catalog,control,mail,integration
FROM proptimiza_a0_behavior_ledger_login;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public,catalog,control,mail,integration
FROM proptimiza_a0_behavior_ledger_login;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public,catalog,control,mail,integration
FROM proptimiza_a0_behavior_ledger_login;
GRANT commercial_a0_behavior_ledger TO proptimiza_a0_behavior_ledger_login;

DO $$ BEGIN
  IF NOT has_database_privilege(
      'proptimiza_a0_behavior_ledger_login','proptimiza_commercial_authority','CONNECT')
    OR has_database_privilege(
      'proptimiza_a0_behavior_ledger_login','proptimiza_commercial_authority','TEMP')
    OR has_database_privilege(
      'proptimiza_a0_behavior_ledger_login','proptimiza_commercial_authority','CREATE')
  THEN RAISE EXCEPTION 'A0_BEHAVIOR_LEDGER_DATABASE_PRIVILEGES_UNSAFE'; END IF;
END $$;

COMMIT;
