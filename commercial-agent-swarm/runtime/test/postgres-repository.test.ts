import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PostgresRuntimeRepository } from '../src/postgres-repository.js'
import type { MissionRecord } from '../src/repository.js'

describe('PostgreSQL repository capability routing', () => {
  it('uses only the dedicated work-order ingestor pool to persist a mission', async () => {
    const calls: Array<Array<unknown>> = []
    const runtime = {
      query: async () => {
        throw new Error('RUNTIME_MUST_NOT_SAVE_MISSIONS')
      },
    }
    const ingestor = {
      query: async (...args: Array<unknown>) => {
        calls.push(args)
        return { rows: [] }
      },
    }
    const repository = new PostgresRuntimeRepository(runtime as never, {
      ingestorPool: ingestor as never,
    })
    await repository.saveMission({
      mission_id: '123e4567-e89b-42d3-a456-426614174000',
      idempotency_key: 'mission-ingestor-1',
      autonomy_level: 'A1',
      a3_enabled: false,
    } as MissionRecord)
    assert.equal(calls.length, 1)
    assert.match(String(calls[0][0]), /control\.save_mission/)
  })
})
