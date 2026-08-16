import { Pool } from 'pg'
import { InMemoryAuditSink, type AuditSink } from './observability.js'
import {
  PostgresAuditSink,
  PostgresRuntimeRepository,
} from './postgres-repository.js'
import {
  InMemoryRuntimeRepository,
  type RuntimeRepository,
} from './repository.js'

type RuntimeEnvironment = Record<string, string | undefined>

export interface RuntimePersistence {
  repository: RuntimeRepository
  audit: AuditSink
  close(): Promise<void>
}

export function createRuntimePersistence(
  environment: RuntimeEnvironment = process.env,
): RuntimePersistence {
  const databaseUrl = environment.DATABASE_URL?.trim()
  if (databaseUrl) {
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: 'proptimiza-commercial-runtime',
    })
    return {
      repository: new PostgresRuntimeRepository(pool),
      audit: new PostgresAuditSink(pool),
      close: () => pool.end(),
    }
  }
  if (environment.NODE_ENV === 'test' || environment.NODE_ENV === 'development') {
    return {
      repository: new InMemoryRuntimeRepository(),
      audit: new InMemoryAuditSink(),
      close: async () => undefined,
    }
  }
  throw new Error('DATABASE_URL is required outside test/development')
}
