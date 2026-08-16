import type { Pool } from 'pg'
import { hashAction } from './canonical.js'
import type { ExecutorEnvelope, ExecutorPort, ProfileId } from './hermes-executor.js'
import { ExecutorTransportError } from './unix-executor-client.js'

export interface EnqueueJob {
  job_id: string
  mission_id: string
  trace_id: string
  idempotency_key: string
  profile_id: string
  instruction: string
  evidence: string
  dependencies: string[]
  budget_reservation_usd: number
  maximum_tokens: number
  maximum_api_calls: number
  max_attempts: number
}

export interface ClaimedJob {
  job_id: string
  mission_id: string
  trace_id: string
  profile_id: ProfileId
  instruction: string
  evidence: { trust:'untrusted_data';content:string }
  reservation: { maximum_tokens:number;maximum_api_calls:number;budget_reservation:{currency:'USD';amount:number} }
  attempts: number
  max_attempts: number
}

export interface CompletionCost {
  amount: number
  total_tokens: number
  api_calls: number
}

export interface DispatchQueuePort {
  enqueue(job: EnqueueJob): Promise<string>
  claim(worker: string, leaseSeconds: number, childTimeoutSeconds: number): Promise<ClaimedJob | null>
  recover(): Promise<void>
  fail(id: string, worker: string, error: string, recoverable: boolean): Promise<void>
  complete(id: string, worker: string, envelope: unknown, artifactHash: string, cost: CompletionCost): Promise<void>
}

export class PostgresDispatchQueue implements DispatchQueuePort {
  constructor(private readonly pool: Pool) {}

  async enqueue(job: EnqueueJob): Promise<string> {
    const result = await this.pool.query<{ job_id: string }>(
      'SELECT control.enqueue_dispatch($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid[],$9::numeric,$10::bigint,$11,$12) AS job_id',
      [job.job_id, job.mission_id, job.trace_id, job.idempotency_key, job.profile_id, job.instruction, job.evidence,
        job.dependencies, job.budget_reservation_usd, job.maximum_tokens, job.maximum_api_calls, job.max_attempts]
    )
    return result.rows[0]!.job_id
  }

  async claim(worker: string, leaseSeconds: number, childTimeoutSeconds: number): Promise<ClaimedJob | null> {
    const result = await this.pool.query<{
      job_id: string
      mission_id: string
      trace_id: string
      profile_id: ProfileId
      instruction: string
      evidence: { trust:'untrusted_data';content:string }
      maximum_tokens:number
      maximum_api_calls:number
      budget_reservation_usd:string
      attempts: number
      max_attempts: number
    }>('SELECT * FROM control.claim_dispatch($1,$2,$3)', [worker, leaseSeconds, childTimeoutSeconds])
    const row = result.rows[0]
    return row ? {
      job_id: row.job_id,
      mission_id: row.mission_id,
      trace_id: row.trace_id,
      profile_id: row.profile_id,
      instruction: row.instruction,
      evidence: row.evidence,
      reservation:{maximum_tokens:row.maximum_tokens,maximum_api_calls:row.maximum_api_calls,budget_reservation:{currency:'USD',amount:Number(row.budget_reservation_usd)}},
      attempts: row.attempts,
      max_attempts: row.max_attempts
    } : null
  }

  async recover(): Promise<void> {
    await this.pool.query('SELECT control.recover_dispatch_leases()')
  }

  async fail(id: string, worker: string, error: string, recoverable: boolean): Promise<void> {
    await this.pool.query(
      'SELECT control.fail_dispatch($1::uuid,$2,$3,$4)',
      [id, worker, error, recoverable]
    )
  }

  async complete(
    id: string,
    worker: string,
    envelope: unknown,
    artifactHash: string,
    cost: CompletionCost,
  ): Promise<void> {
    await this.pool.query(
      'SELECT control.complete_dispatch($1::uuid,$2,$3::jsonb,$4,$5::numeric,$6::bigint,$7)',
      [id, worker, JSON.stringify(envelope), artifactHash, cost.amount, cost.total_tokens, cost.api_calls]
    )
  }
}

export interface DispatcherOptions {
  queue: DispatchQueuePort
  executor: ExecutorPort
  workerId: string
  leaseSeconds: number
  childTimeoutSeconds: number
}

export class DeterministicDispatcher {
  private running = false

  constructor(private readonly options: DispatcherOptions) {}

  async runOnce(): Promise<boolean> {
    if (this.running) return false
    this.running = true
    try {
      return await this.runExclusive()
    } finally {
      this.running = false
    }
  }

  private async runExclusive(): Promise<boolean> {
    await this.options.queue.recover()
    const job = await this.options.queue.claim(this.options.workerId, this.options.leaseSeconds, this.options.childTimeoutSeconds)
    if (!job) return false

    try {
      const envelope: ExecutorEnvelope = await this.options.executor.execute({
        mission_id: job.mission_id,
        trace_id: job.trace_id,
        assignment_id: job.job_id,
        profile_id: job.profile_id,
        instruction: job.instruction,
        evidence: job.evidence,
        reservation: job.reservation,
      })
      if (envelope.agent_result.status === 'failed') throw new Error(envelope.agent_result.errors[0] && typeof envelope.agent_result.errors[0] === 'object' ? 'AGENT_RESULT_FAILED' : 'EXECUTOR_FAILURE')
      if(envelope.usage.cost.status!=='known')throw new Error('HERMES_COST_UNKNOWN')
      const hash = hashAction(envelope.agent_result)
      await this.options.queue.complete(
        job.job_id,
        this.options.workerId,
        envelope,
        hash,
        { amount: envelope.usage.cost.amount_usd, total_tokens: envelope.usage.tokens.total, api_calls: envelope.usage.api_calls },
      )
      return true
    } catch (error) {
      if (error instanceof ExecutorTransportError && error.executionState === 'unknown') return true
      const message = error instanceof Error ? error.message : 'EXECUTOR_FAILURE'
      const recoverable = error instanceof ExecutorTransportError ? error.recoverable : /HERMES_EXIT|TIMEOUT|LEASE/.test(message)
      await this.options.queue.fail(
        job.job_id,
        this.options.workerId,
        message,
        recoverable,
      )
      return true
    }
  }
}
