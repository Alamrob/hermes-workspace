import type { Pool } from 'pg'
import { hashAction } from './canonical.js'
import type { ExecutorEnvelope, ExecutorPort, ProfileId } from './hermes-executor.js'

export interface EnqueueJob {
  job_id: string
  mission_id: string
  idempotency_key: string
  profile_id: string
  prompt: string
  dependencies: string[]
  maximum_cost: number
  maximum_tokens: number
  max_attempts: number
}

export interface ClaimedJob {
  job_id: string
  mission_id: string
  profile_id: ProfileId
  prompt: string
  attempts: number
  max_attempts: number
}

export interface CompletionCost {
  amount: number
  input_tokens: number
  output_tokens: number
}

export interface DispatchQueuePort {
  enqueue(job: EnqueueJob): Promise<string>
  claim(worker: string, now: string, leaseSeconds: number): Promise<ClaimedJob | null>
  recover(now: string): Promise<void>
  fail(id: string, worker: string, error: string, recoverable: boolean, now: string): Promise<void>
  complete(id: string, worker: string, envelope: unknown, artifactHash: string, cost: CompletionCost, now: string): Promise<void>
}

export class PostgresDispatchQueue implements DispatchQueuePort {
  constructor(private readonly pool: Pool) {}

  async enqueue(job: EnqueueJob): Promise<string> {
    const result = await this.pool.query<{ job_id: string }>(
      'SELECT control.enqueue_dispatch($1::uuid,$2::uuid,$3,$4,$5,$6::uuid[],$7::numeric,$8::bigint,$9) AS job_id',
      [job.job_id, job.mission_id, job.idempotency_key, job.profile_id, job.prompt,
        job.dependencies, job.maximum_cost, job.maximum_tokens, job.max_attempts]
    )
    return result.rows[0]!.job_id
  }

  async claim(worker: string, now: string, leaseSeconds: number): Promise<ClaimedJob | null> {
    const result = await this.pool.query<{
      job_id: string
      mission_id: string
      profile_id: ProfileId
      prompt: { text: string }
      attempts: number
      max_attempts: number
    }>('SELECT * FROM control.claim_dispatch($1,$2::timestamptz,$3)', [worker, now, leaseSeconds])
    const row = result.rows[0]
    return row ? {
      job_id: row.job_id,
      mission_id: row.mission_id,
      profile_id: row.profile_id,
      prompt: row.prompt.text,
      attempts: row.attempts,
      max_attempts: row.max_attempts
    } : null
  }

  async recover(now: string): Promise<void> {
    await this.pool.query('SELECT control.recover_dispatch_leases($1::timestamptz)', [now])
  }

  async fail(id: string, worker: string, error: string, recoverable: boolean, now: string): Promise<void> {
    await this.pool.query(
      'SELECT control.fail_dispatch($1::uuid,$2,$3,$4,$5::timestamptz)',
      [id, worker, error, recoverable, now]
    )
  }

  async complete(
    id: string,
    worker: string,
    envelope: unknown,
    artifactHash: string,
    cost: CompletionCost,
    now: string
  ): Promise<void> {
    await this.pool.query(
      'SELECT control.complete_dispatch($1::uuid,$2,$3::jsonb,$4,$5::numeric,$6::bigint,$7::bigint,$8::timestamptz)',
      [id, worker, JSON.stringify(envelope), artifactHash, cost.amount,
        cost.input_tokens, cost.output_tokens, now]
    )
  }
}

export interface DispatcherOptions {
  queue: DispatchQueuePort
  executor: ExecutorPort
  workerId: string
  now: () => Date
  leaseSeconds: number
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
    const now = this.options.now().toISOString()
    await this.options.queue.recover(now)
    const job = await this.options.queue.claim(this.options.workerId, now, this.options.leaseSeconds)
    if (!job) return false

    try {
      const envelope: ExecutorEnvelope = await this.options.executor.execute({
        mission_id: job.mission_id,
        assignment_id: job.job_id,
        profile_id: job.profile_id,
        prompt: job.prompt
      })
      if (envelope.status === 'failed') throw new Error(envelope.error ?? 'EXECUTOR_FAILURE')
      const hash = hashAction({
        artifact_id: envelope.result!.artifact_id,
        content: envelope.result!.content
      })
      await this.options.queue.complete(
        job.job_id,
        this.options.workerId,
        envelope,
        hash,
        envelope.token_cost,
        this.options.now().toISOString()
      )
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'EXECUTOR_FAILURE'
      const recoverable = /HERMES_EXIT|TIMEOUT|LEASE/.test(message)
      await this.options.queue.fail(
        job.job_id,
        this.options.workerId,
        message,
        recoverable,
        this.options.now().toISOString()
      )
      return true
    }
  }
}
