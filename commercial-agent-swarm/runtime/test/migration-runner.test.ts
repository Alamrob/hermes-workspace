import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  migrationDigest,
  validateMigrationSet,
} from '../src/migration-runner.js'

describe('versioned migration runner', () => {
  it('orders a closed migration set and calculates stable SHA-256 digests', () => {
    const migrations = validateMigrationSet([
      { version: '004_crm_integration', sql: 'SELECT 4;' },
      { version: '003_dispatch_queue', sql: 'SELECT 3;' },
      { version: '001_runtime', sql: 'SELECT 1;' },
      { version: '002_commercial_control_plane', sql: 'SELECT 2;' },
    ])
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [
        '001_runtime',
        '002_commercial_control_plane',
        '003_dispatch_queue',
        '004_crm_integration',
      ],
    )
    assert.equal(
      migrationDigest('SELECT 1;'),
      '17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a',
    )
  })

  it('rejects missing, duplicate, extra, or malformed migration history', () => {
    for (const migrations of [
      [],
      [
        { version: '001_runtime', sql: 'SELECT 1;' },
        { version: '001_runtime', sql: 'SELECT 1;' },
      ],
      [
        { version: '001_runtime', sql: 'SELECT 1;' },
        { version: '002_commercial_control_plane', sql: '' },
        { version: '003_dispatch_queue', sql: 'SELECT 3;' },
        { version: '004_crm_integration', sql: 'SELECT 4;' },
      ],
      [
        { version: '001_runtime', sql: 'SELECT 1;' },
        { version: '002_commercial_control_plane', sql: 'SELECT 2;' },
        { version: '003_dispatch_queue', sql: 'SELECT 3;' },
        { version: '004_crm_integration', sql: 'SELECT 4;' },
        { version: '005_unapproved', sql: 'SELECT 5;' },
      ],
    ])
      assert.throws(
        () => validateMigrationSet(migrations),
        /INVALID_MIGRATION_SET/,
      )
  })
})
