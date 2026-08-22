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
