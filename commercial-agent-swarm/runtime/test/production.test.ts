import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PostgresRuntimeRepository } from '../src/postgres-repository.js'
import { createRuntimePersistence } from '../src/production.js'
import { InMemoryRuntimeRepository } from '../src/repository.js'

describe('runtime persistence composition', () => {
  it('fails production startup closed without DATABASE_URL', () => {
    assert.throws(
      () => createRuntimePersistence({ NODE_ENV: 'production' }),
      /DATABASE_URL is required/,
    )
    assert.throws(
      () => createRuntimePersistence({}),
      /DATABASE_URL is required outside test\/development/,
    )
  })

  it('uses memory only for test or development and PostgreSQL whenever DATABASE_URL is set', async () => {
    const testPersistence = createRuntimePersistence({ NODE_ENV: 'test' })
    assert.ok(testPersistence.repository instanceof InMemoryRuntimeRepository)
    await testPersistence.close()

    const productionPersistence = createRuntimePersistence({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://runtime:unused@127.0.0.1:1/runtime',
    })
    assert.ok(productionPersistence.repository instanceof PostgresRuntimeRepository)
    await productionPersistence.close()
  })
})
