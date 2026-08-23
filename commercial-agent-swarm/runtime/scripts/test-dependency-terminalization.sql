\set ON_ERROR_STOP on

BEGIN;

INSERT INTO control.missions(mission_id,idempotency_key,payload)
VALUES(
  '123e4567-e89b-42d3-a456-426614174950',
  'dependency-terminalization-test',
  jsonb_build_object(
    'expires_at','2099-08-23T23:59:59Z',
    'budget_limit',jsonb_build_object('currency','USD','maximum',0.5)
  )
);

INSERT INTO control.dispatch_jobs(
  job_id,mission_id,trace_id,idempotency_key,profile_id,instruction,evidence,
  status,mission_usage_value_ceiling_usd,usage_value_reservation_usd,
  maximum_tokens,maximum_api_calls,max_attempts,error
)
VALUES
(
  '123e4567-e89b-42d3-a456-426614174951',
  '123e4567-e89b-42d3-a456-426614174950',
  '123e4567-e89b-42d3-a456-426614174952',
  'dependency-primary-failed','qualification-prioritization','synthetic',
  '{"trust":"untrusted_data","content":"synthetic"}'::jsonb,
  'failed',0.5,0.1,100,6,1,'SYNTHETIC_PRIMARY_FAILURE'
),
(
  '123e4567-e89b-42d3-a456-426614174953',
  '123e4567-e89b-42d3-a456-426614174950',
  '123e4567-e89b-42d3-a456-426614174952',
  'dependency-child-queued','commercial-qa-compliance','synthetic',
  '{"trust":"untrusted_data","content":"synthetic"}'::jsonb,
  'queued',0.5,0.1,100,6,1,NULL
),
(
  '123e4567-e89b-42d3-a456-426614174954',
  '123e4567-e89b-42d3-a456-426614174950',
  '123e4567-e89b-42d3-a456-426614174952',
  'dependency-grandchild-queued','commercial-qa-compliance','synthetic',
  '{"trust":"untrusted_data","content":"synthetic"}'::jsonb,
  'queued',0.5,0.1,100,6,1,NULL
);

INSERT INTO control.dispatch_dependencies(job_id,depends_on_job_id)
VALUES
  ('123e4567-e89b-42d3-a456-426614174953','123e4567-e89b-42d3-a456-426614174951'),
  ('123e4567-e89b-42d3-a456-426614174954','123e4567-e89b-42d3-a456-426614174953');

DO $$
DECLARE changed integer;
BEGIN
  SELECT control.terminalize_failed_dispatch_dependencies() INTO changed;
  IF changed <> 2 THEN RAISE EXCEPTION 'EXPECTED_TWO_TERMINALIZED_GOT:%',changed; END IF;
  IF EXISTS(
    SELECT 1 FROM control.dispatch_jobs
    WHERE job_id IN(
      '123e4567-e89b-42d3-a456-426614174953',
      '123e4567-e89b-42d3-a456-426614174954'
    ) AND (
      status <> 'failed' OR
      error <> 'DEPENDENCY_TERMINAL_NON_SUCCESS' OR
      usage_budget_state <> 'released' OR
      usage_value_consumed_usd <> 0
    )
  ) THEN RAISE EXCEPTION 'DEPENDENCY_TERMINALIZATION_STATE_INVALID'; END IF;
  IF (
    SELECT count(*) FROM control.dispatch_events
    WHERE job_id IN(
      '123e4567-e89b-42d3-a456-426614174953',
      '123e4567-e89b-42d3-a456-426614174954'
    ) AND from_status='queued' AND to_status='failed'
      AND reason='DEPENDENCY_TERMINAL_NON_SUCCESS'
  ) <> 2 THEN RAISE EXCEPTION 'DEPENDENCY_TERMINALIZATION_EVENTS_INVALID'; END IF;
  IF control.terminalize_failed_dispatch_dependencies() <> 0
    THEN RAISE EXCEPTION 'DEPENDENCY_TERMINALIZATION_NOT_IDEMPOTENT'; END IF;
END$$;

ROLLBACK;

SELECT 'DEPENDENCY_TERMINALIZATION_TEST_OK';
