BEGIN;

ALTER TABLE control.dispatch_jobs
  DROP CONSTRAINT IF EXISTS dispatch_jobs_usage_budget_consistency_check;
ALTER TABLE control.dispatch_jobs
  ADD CONSTRAINT dispatch_jobs_usage_budget_consistency_check CHECK(
    (usage_budget_state IN('unreserved','released')
      AND usage_value_actual_micro_cents IS NULL
      AND usage_record_id IS NULL AND usage_value_source IS NULL)
    OR
    (usage_budget_state='reserved' AND status='leased'
      AND usage_value_reservation_micro_cents BETWEEN 1 AND 10000000
      AND usage_value_actual_micro_cents IS NULL
      AND usage_record_id IS NULL AND usage_value_source IS NULL
      AND usage_budget_version>0)
    OR
    (usage_budget_state='held_uncertain' AND status='usage_unknown'
      AND usage_value_reservation_micro_cents BETWEEN 1 AND 10000000
      AND usage_value_actual_micro_cents IS NULL
      AND usage_record_id IS NULL AND usage_value_source IS NULL
      AND usage_budget_version>0)
    OR
    (usage_budget_state='settled' AND status IN('succeeded','failed','budget_exceeded')
      AND usage_value_reservation_micro_cents BETWEEN 1 AND 10000000
      AND usage_value_actual_micro_cents BETWEEN 1 AND usage_value_reservation_micro_cents
      AND usage_record_id IS NOT NULL
      AND usage_value_source IN(
        'opencode_usage_export',
        'opencode_go_native_telemetry',
        'manual_conservative_estimate'
      )
      AND usage_budget_version>0)
  );

DELETE FROM control.schema_migrations
WHERE version='016_usage_source_not_null';

COMMIT;
