import type { Pool } from 'pg'

const databaseName = /^[a-z][a-z0-9_]{0,62}$/

export async function dropTestDatabase(admin: Pool, database: string): Promise<void> {
  if (!databaseName.test(database)) throw new Error('TEST_DATABASE_NAME_INVALID')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const active = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [database],
    )
    if (active.rows[0]?.count === 0) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`TEST_DATABASE_CONNECTIONS_DID_NOT_CLOSE:${database}`)
}
