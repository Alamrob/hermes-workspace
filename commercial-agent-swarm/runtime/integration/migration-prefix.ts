import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'
import { migrationDigest } from '../src/migration-runner.js'

export async function applyMigrationPrefix(
  pool: Pool,
  versions: readonly string[],
): Promise<void> {
  for (const version of versions) {
    const sql = await readFile(
      new URL(`../migrations/${version}.sql`, import.meta.url),
      'utf8',
    )
    await pool.query(sql)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS control.schema_migrations(
        version text PRIMARY KEY CHECK(version~'^[0-9]{3}_[a-z0-9_]+$'),
        sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `)
    await pool.query(
      `INSERT INTO control.schema_migrations(version,sha256)
       VALUES($1,$2) ON CONFLICT(version) DO NOTHING`,
      [version, migrationDigest(sql)],
    )
  }
}
