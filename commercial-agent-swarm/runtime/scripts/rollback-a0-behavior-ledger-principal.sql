-- Idempotently removes only the A0 LOGIN from the dedicated authority DB.
-- The database, migrations, capability role, PUBLIC isolation, and every
-- runtime/CRM/n8n/other-database ACL remain untouched.
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='2s';

DO $$ BEGIN
  IF current_database()<>'proptimiza_commercial_authority'
    OR NOT EXISTS(
      SELECT 1 FROM pg_database database
      WHERE database.datname=current_database()
        AND pg_get_userbyid(database.datdba)='proptimiza_commercial_authority_owner'
        AND coalesce(obj_description(database.oid,'pg_database'),'')
          ='proptimiza:commercial-authority:v1'
    )
  THEN RAISE EXCEPTION 'A0_AUTHORITY_DATABASE_NOT_DEDICATED'; END IF;

  IF EXISTS(
    SELECT 1 FROM pg_roles WHERE rolname='proptimiza_a0_behavior_ledger_login'
  ) THEN
    IF EXISTS(
      SELECT 1 FROM pg_roles
      WHERE rolname='proptimiza_a0_behavior_ledger_login'
        AND (NOT rolcanlogin OR NOT rolinherit OR rolsuper OR rolcreatedb
          OR rolcreaterole OR rolreplication OR rolbypassrls)
    ) OR EXISTS(
      SELECT 1 FROM pg_auth_members membership
      WHERE membership.member=(SELECT oid FROM pg_roles
        WHERE rolname='proptimiza_a0_behavior_ledger_login')
        AND (membership.admin_option OR membership.roleid<>(SELECT oid FROM pg_roles
          WHERE rolname='commercial_a0_behavior_ledger'))
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

    EXECUTE 'REVOKE commercial_a0_behavior_ledger FROM proptimiza_a0_behavior_ledger_login';
    EXECUTE 'REVOKE ALL ON DATABASE proptimiza_commercial_authority FROM proptimiza_a0_behavior_ledger_login';
    EXECUTE 'REVOKE ALL ON SCHEMA public,catalog,control,mail,integration FROM proptimiza_a0_behavior_ledger_login';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public,catalog,control,mail,integration FROM proptimiza_a0_behavior_ledger_login';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public,catalog,control,mail,integration FROM proptimiza_a0_behavior_ledger_login';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public,catalog,control,mail,integration FROM proptimiza_a0_behavior_ledger_login';
    EXECUTE 'DROP ROLE proptimiza_a0_behavior_ledger_login';
  END IF;
END $$;

COMMIT;
