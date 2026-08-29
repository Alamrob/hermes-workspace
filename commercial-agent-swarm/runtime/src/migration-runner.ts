import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

const EXPECTED_MIGRATIONS = [
  '001_runtime',
  '002_commercial_control_plane',
  '003_dispatch_queue',
  '004_crm_integration',
  '005_portfolio_read_models',
  '006_sales_read_models',
  '007_usage_budget_ledger',
  '008_simulation_safety_seed',
  '009_internal_automation',
  '010_instruction_inbox',
  '011_go_native_usage_ledger',
  '012_dependency_terminalization',
  '013_variable_usage_reservations',
  '014_variable_usage_constraint',
  '015_shadow_human_review',
  '016_usage_source_not_null',
  '017_external_action_kill_switch_projection',
  '018_sales_mission_draft_projection',
  '019_codex_instruction_review',
  '020_internal_mail_attestation',
  '021_commercial_policy_v2_draft',
  '022_policy_human_review',
  '023_policy_activation_dossier',
  '024_draft_internal_review',
  '025_a1_research_dossier',
  '026_a1_research_authorization',
  '027_a1_research_order_authorization',
  '028_ed25519_a1_work_orders',
  '029_a1_authorization_renewal',
  '030_a1_dispatch_authorization',
  '031_a1_assignment_enqueue_authorization',
  '032_a1_assignment_execution_authorization',
  '033_a1_dispatch_execution_arm',
] as const

export interface MigrationSource {
  version: string
  sql: string
}

export interface ValidatedMigration extends MigrationSource {
  sha256: string
}

export function migrationDigest(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

export function validateMigrationSet(
  sources: MigrationSource[],
): ValidatedMigration[] {
  if (
    sources.length !== EXPECTED_MIGRATIONS.length ||
    new Set(sources.map((source) => source.version)).size !== sources.length ||
    sources.some(
      (source) =>
        !EXPECTED_MIGRATIONS.includes(source.version as never) ||
        !source.sql.trim(),
    )
  )
    throw new Error('INVALID_MIGRATION_SET')
  const ordered = [...sources].sort((left, right) =>
    left.version.localeCompare(right.version),
  )
  if (
    ordered.some(
      (source, index) => source.version !== EXPECTED_MIGRATIONS[index],
    )
  )
    throw new Error('INVALID_MIGRATION_SET')
  return ordered.map((source) => ({
    ...source,
    sha256: migrationDigest(source.sql),
  }))
}

export async function runVersionedMigrations(
  pool: Pick<Pool, 'connect'>,
  sources: MigrationSource[],
): Promise<void> {
  const migrations = validateMigrationSet(sources)
  const client = await pool.connect()
  let failure: unknown
  try {
    await client.query(
      `SELECT pg_advisory_lock(hashtext('proptimiza-commercial-migrations'))`,
    )
    for (const migration of migrations)
      await applyMigration(client, migration)
  } catch (error) {
    failure = error
    await client.query('ROLLBACK').catch(() => undefined)
  }
  try {
    await client.query(
      `SELECT pg_advisory_unlock(hashtext('proptimiza-commercial-migrations'))`,
    )
  } catch (error) {
    if (!failure) failure = error
  } finally {
    client.release()
  }
  if (failure) throw failure
}

async function applyMigration(
  client: Pick<PoolClient, 'query'>,
  migration: ValidatedMigration,
): Promise<void> {
  const table = await client.query<{ present: boolean }>(
    `SELECT to_regclass('control.schema_migrations') IS NOT NULL AS present`,
  )
  if (table.rows[0]?.present) {
    const recorded = await client.query<{ sha256: string }>(
      `SELECT sha256 FROM control.schema_migrations WHERE version=$1`,
      [migration.version],
    )
    const existing = recorded.rows.at(0)?.sha256
    if (existing) {
      if (existing !== migration.sha256)
        throw new Error(`MIGRATION_HASH_MISMATCH:${migration.version}`)
      return
    }
  }

  await client.query(migration.sql)
  await client.query(`
    CREATE TABLE IF NOT EXISTS control.schema_migrations(
      version text PRIMARY KEY CHECK(version~'^[0-9]{3}_[a-z0-9_]+$'),
      sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `)
  await client.query(
    `INSERT INTO control.schema_migrations(version,sha256) VALUES($1,$2) ON CONFLICT(version) DO NOTHING`,
    [migration.version, migration.sha256],
  )
  const verified = await client.query<{ sha256: string }>(
    `SELECT sha256 FROM control.schema_migrations WHERE version=$1`,
    [migration.version],
  )
  if (verified.rows.at(0)?.sha256 !== migration.sha256)
    throw new Error(`MIGRATION_HASH_MISMATCH:${migration.version}`)
}
