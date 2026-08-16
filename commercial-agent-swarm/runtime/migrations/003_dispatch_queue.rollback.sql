BEGIN;
REVOKE ALL ON FUNCTION control.enqueue_dispatch(uuid,uuid,uuid,text,text,text,text,uuid[],numeric,bigint,integer,integer),control.recover_dispatch_leases(),control.claim_dispatch(text,integer,integer),control.fail_dispatch(uuid,text,text,boolean),control.complete_dispatch(uuid,text,jsonb,text,numeric,bigint,integer) FROM PUBLIC,commercial_runtime,commercial_approver,commercial_safety_operator,commercial_observer;
DROP FUNCTION IF EXISTS control.complete_dispatch(uuid,text,jsonb,text,numeric,bigint,integer),control.fail_dispatch(uuid,text,text,boolean),control.claim_dispatch(text,integer,integer),control.recover_dispatch_leases(),control.enqueue_dispatch(uuid,uuid,uuid,text,text,text,text,uuid[],numeric,bigint,integer,integer);
DROP TABLE IF EXISTS control.dispatch_events,control.dispatch_dependencies,control.dispatch_jobs;
COMMIT;
