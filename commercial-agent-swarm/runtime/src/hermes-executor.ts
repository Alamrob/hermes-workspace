import { spawn } from 'node:child_process'
import { chown, cp, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const ACTIVE_PROFILES = [
  'sales-orchestrator',
  'market-account-intelligence',
  'contact-data-steward',
  'qualification-prioritization',
  'outreach-draft-manager',
  'commercial-qa-compliance'
] as const

export type ProfileId = (typeof ACTIVE_PROFILES)[number]

export interface ProcessInvocation {
  command: string
  args: string[]
  env: Record<string, string>
  uid: number
  gid: number
  shell: false
  timeoutMs?: number
}

export interface ProcessOutput {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean
}

export interface ProcessRunner {
  run(invocation: ProcessInvocation): Promise<ProcessOutput>
}

export interface HomeOwnershipPreparer {
  prepare(home: string, uid: number, gid: number): Promise<void>
}

export interface ExecutorEnvelope {
  schema_version: '1.0'
  mission_id: string
  assignment_id: string
  profile_id: ProfileId
  status: 'completed' | 'failed'
  result: { artifact_id: string; content: string } | null
  evidence: string[]
  token_cost: {
    input_tokens: number
    output_tokens: number
    currency: string
    amount: number
  }
  error: string | null
}

export interface HermesExecutorOptions {
  runner: ProcessRunner
  ownership: HomeOwnershipPreparer
  profileSeed: string
  temporaryRoot: string
  childUid: number
  childGid: number
  customApiKey: string
  safePath: string
  timeoutMs?: number
}

export interface ExecuteInput {
  mission_id: string
  assignment_id: string
  profile_id: string
  prompt: string
}

export interface ExecutorPort {
  execute(input: ExecuteInput): Promise<ExecutorEnvelope>
}

export class HermesExecutor implements ExecutorPort {
  constructor(private readonly options: HermesExecutorOptions) {
    if (!Number.isInteger(options.childUid) || options.childUid <= 0) throw new Error('NON_ROOT_UID_REQUIRED')
    if (!Number.isInteger(options.childGid) || options.childGid <= 0) throw new Error('NON_ROOT_GID_REQUIRED')
    if (!options.customApiKey) throw new Error('CUSTOM_API_KEY_REQUIRED')
  }

  async execute(input: ExecuteInput): Promise<ExecutorEnvelope> {
    if (!ACTIVE_PROFILES.includes(input.profile_id as ProfileId)) throw new Error('UNKNOWN_PROFILE')

    await mkdir(this.options.temporaryRoot, { recursive: true })
    const home = await mkdtemp(join(this.options.temporaryRoot, 'hermes-home-'))
    try {
      await cp(this.options.profileSeed, home, { recursive: true, force: false })
      await this.options.ownership.prepare(home, this.options.childUid, this.options.childGid)
      const invocation: ProcessInvocation = {
        command: 'hermes',
        args: ['-p', input.profile_id, '--cli', 'chat', '-q', input.prompt],
        env: {
          CUSTOM_API_KEY: this.options.customApiKey,
          HERMES_HOME: home,
          HOME: home,
          LANG: 'C.UTF-8',
          PATH: this.options.safePath
        },
        uid: this.options.childUid,
        gid: this.options.childGid,
        shell: false,
        timeoutMs: this.options.timeoutMs
      }
      const output = await this.options.runner.run(invocation)
      if (output.timedOut) throw new Error('HERMES_TIMEOUT')
      if (output.exitCode !== 0) throw new Error(`HERMES_EXIT_${output.exitCode}`)
      return validateEnvelope(output.stdout, input)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
}

export class NodeProcessRunner implements ProcessRunner {
  async run(invocation: ProcessInvocation): Promise<ProcessOutput> {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        env: invocation.env,
        uid: invocation.uid,
        gid: invocation.gid,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      const timer = invocation.timeoutMs
        ? setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, invocation.timeoutMs)
        : undefined
      child.once('error', error => {
        if (timer) clearTimeout(timer)
        reject(error)
      })
      child.once('close', code => {
        if (timer) clearTimeout(timer)
        resolve({ stdout, stderr, exitCode: code ?? -1, timedOut })
      })
    })
  }
}

export class PosixHomeOwnershipPreparer implements HomeOwnershipPreparer {
  async prepare(home: string, uid: number, gid: number): Promise<void> {
    await this.prepareEntry(home, uid, gid)
  }

  private async prepareEntry(path: string, uid: number, gid: number): Promise<void> {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error('UNSAFE_PROFILE_SEED_SYMLINK')
    if (metadata.isDirectory()) {
      for (const entry of await readdir(path)) await this.prepareEntry(join(path, entry), uid, gid)
    }
    await chown(path, uid, gid)
  }
}

function validateEnvelope(raw: string, input: ExecuteInput): ExecutorEnvelope {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('INVALID_EXECUTOR_ENVELOPE')
  }

  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schema_version', 'mission_id', 'assignment_id', 'profile_id', 'status',
    'result', 'evidence', 'token_cost', 'error'
  ])) throw new Error('INVALID_EXECUTOR_ENVELOPE')

  const envelope = value
  const cost = envelope.token_cost
  if (
    envelope.schema_version !== '1.0' ||
    envelope.mission_id !== input.mission_id ||
    envelope.assignment_id !== input.assignment_id ||
    envelope.profile_id !== input.profile_id ||
    !['completed', 'failed'].includes(String(envelope.status)) ||
    !Array.isArray(envelope.evidence) ||
    !envelope.evidence.every(item => typeof item === 'string') ||
    !isRecord(cost) ||
    !hasOnlyKeys(cost, ['input_tokens', 'output_tokens', 'currency', 'amount']) ||
    ![cost.input_tokens, cost.output_tokens].every(value => Number.isSafeInteger(value) && Number(value) >= 0) ||
    typeof cost.amount !== 'number' ||
    !Number.isFinite(cost.amount) ||
    cost.amount < 0 ||
    typeof cost.currency !== 'string' ||
    cost.currency.length === 0
  ) throw new Error('INVALID_EXECUTOR_ENVELOPE')

  if (
    envelope.status === 'completed' &&
    (!isRecord(envelope.result) ||
      !hasOnlyKeys(envelope.result, ['artifact_id', 'content']) ||
      typeof envelope.result.artifact_id !== 'string' ||
      envelope.result.artifact_id.length === 0 ||
      typeof envelope.result.content !== 'string' ||
      envelope.error !== null)
  ) throw new Error('INVALID_EXECUTOR_ENVELOPE')

  if (
    envelope.status === 'failed' &&
    (envelope.result !== null || typeof envelope.error !== 'string' || envelope.error.length === 0)
  ) throw new Error('INVALID_EXECUTOR_ENVELOPE')

  return value as unknown as ExecutorEnvelope
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
