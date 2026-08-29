import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { runVersionedMigrations } from './migration-runner.js'
import { readOwnerSecretFile } from './simulation-entrypoint.js'

export async function migrateCommercialDatabase(
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (
    environment.NODE_ENV !== 'production' ||
    environment.COMMERCIAL_MODE !== 'simulation'
  )
    throw new Error('MIGRATION_MODE_INVALID')
  if (environment.MIGRATION_DATABASE_URL?.trim())
    throw new Error('RAW_SECRET_FORBIDDEN:MIGRATION_DATABASE_URL')
  const secretFile = environment.MIGRATION_DATABASE_URL_FILE?.trim()
  if (!secretFile) throw new Error('MIGRATION_DATABASE_URL_FILE_REQUIRED')
  const connectionString = await readOwnerSecretFile(secretFile)
  const pool = new Pool({
    connectionString,
    application_name: 'proptimiza-commercial-migrator',
    max: 1,
  })
  try {
    await runVersionedMigrations(pool, await loadMigrationSources())
  } finally {
    await pool.end()
  }
}

export async function loadMigrationSources() {
  return Promise.all(
    [
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
    ].map(async (version) => ({
      version,
      sql: await readFile(
        new URL(`../migrations/${version}.sql`, import.meta.url),
        'utf8',
      ),
    })),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await migrateCommercialDatabase()
