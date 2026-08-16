BEGIN;

INSERT INTO control.kill_switches(scope,scope_id,active)
VALUES('global','*',true)
ON CONFLICT(scope,scope_id) DO NOTHING;

COMMIT;
