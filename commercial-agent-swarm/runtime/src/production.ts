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
    const approverUrl = environment.APPROVER_DATABASE_URL?.trim()
    const safetyUrl = environment.SAFETY_DATABASE_URL?.trim()
    if (environment.NODE_ENV === 'production' && !approverUrl) {
      throw new Error('APPROVER_DATABASE_URL is required in production')
    }
    if (environment.NODE_ENV === 'production' && !safetyUrl) {
      throw new Error('SAFETY_DATABASE_URL is required in production')
    }
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: 'proptimiza-commercial-runtime',
    })
    const approverPool = new Pool({
      connectionString: approverUrl ?? databaseUrl,
      application_name: 'proptimiza-commercial-approver',
    })
    const safetyPool = new Pool({
      connectionString: safetyUrl ?? databaseUrl,
      application_name: 'proptimiza-commercial-safety',
    })
    return {
      repository: new PostgresRuntimeRepository(pool, { approverPool, safetyPool }),
      audit: new PostgresAuditSink(pool),
      close: async () => { await Promise.all([pool.end(), approverPool.end(), safetyPool.end()]) },
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
