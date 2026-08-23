#!/bin/sh
set -eu

bundle=/tmp/proptimiza-dependency-terminalization-20260823
container=postgresql-kjo7-postgresql-1
database=proptimiza_dependency_test_20260823
container_bundle=/tmp/proptimiza-dependency-terminalization-20260823

if [ "${1:-}" != '--execute' ]; then
  printf '%s\n' 'dry-run: pass --execute on the audited VPS test bundle'
  exit 0
fi

[ -d "$bundle/migrations" ]
[ -f "$bundle/test-dependency-terminalization.sql" ]

cleanup() {
  docker exec "$container" dropdb --if-exists -U VDCD9RGMZN0FlHhM "$database" >/dev/null 2>&1 || true
  docker exec "$container" rm -rf -- "$container_bundle" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cleanup
docker exec "$container" createdb -U VDCD9RGMZN0FlHhM "$database"
docker exec "$container" mkdir -p "$container_bundle/migrations"
docker cp "$bundle/migrations/." "$container:$container_bundle/migrations"
docker cp "$bundle/test-dependency-terminalization.sql" "$container:$container_bundle/test-dependency-terminalization.sql"

for version in \
  001_runtime \
  002_commercial_control_plane \
  003_dispatch_queue \
  004_crm_integration \
  005_portfolio_read_models \
  006_sales_read_models \
  007_usage_budget_ledger \
  008_simulation_safety_seed \
  009_internal_automation \
  010_instruction_inbox \
  011_go_native_usage_ledger \
  012_dependency_terminalization
do
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 \
    -U VDCD9RGMZN0FlHhM -d "$database" \
    -f "$container_bundle/migrations/$version.sql" >/dev/null
done

docker exec "$container" psql -X -v ON_ERROR_STOP=1 \
  -U VDCD9RGMZN0FlHhM -d "$database" \
  -f "$container_bundle/test-dependency-terminalization.sql"
