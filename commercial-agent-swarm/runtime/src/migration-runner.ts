import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

const EXPECTED_MIGRATIONS = [
  '001_runtime',
  '002_commercial_control_plane',
  '003_dispatch_queue',
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
  try {
    await client.query(
      `SELECT pg_advisory_lock(hashtext('proptimiza-commercial-migrations'))`,
    )
    for (const migration of migrations)
      await applyMigration(client, migration)
  } finally {
    try {
      await client.query(
        `SELECT pg_advisory_unlock(hashtext('proptimiza-commercial-migrations'))`,
      )
    } finally {
      client.release()
    }
  }
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
