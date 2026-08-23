import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { readGroupSecretFile } from './secret-file.js'
import {
  ACTIVE_PROFILES,
  buildHermesPrompt,
  validateExecuteRequest,
  validateHermesUsage,
} from './executor-contract.js'
import { reconcileAgentResult } from './agent-result.js'
import {
  assertOpenCodeGoExecutionPreflight,
  priceOpenCodeGoUsage,
} from './opencode-go-pricing.js'
import {
  EXECUTOR_MODEL_PROXY_URL,
  EXECUTOR_NO_PROXY,
} from './runtime-config.js'
import type {
  ExecuteInput,
  ProfileId,
  TrustedUsage,
} from './executor-contract.js'
import type { AgentResult } from './agent-result.js'

export {
  ACTIVE_PROFILES,
  type ExecutionPolicy,
  type ExecuteInput,
  type ProfileId,
} from './executor-contract.js'

export const HERMES_BINARY = '/opt/hermes/.venv/bin/hermes'
export const HERMES_SAFE_PATH =
  '/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin'
export const HERMES_MODEL = 'deepseek-v4-flash'
export const HERMES_PROVIDER = 'opencode-go'
// The executor uses the dedicated OpenCode Go workspace key, not a managed
// Inference service-account key. Keep the subscription endpoint explicit and
// inside the isolated child environment so no other provider can drift.
export const HERMES_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const HERMES_KEY_ENV = 'OPENCODE_GO_API_KEY'
export const HERMES_BASE_URL_ENV = 'OPENCODE_GO_BASE_URL'
export const SETPRIV_BINARY = '/usr/bin/setpriv'
export const EXECUTOR_CHILD_SUPPLEMENTARY_GROUPS_CLEARED_V1 = true

export function classifyHermesExit(
  exitCode: number,
  stdout: string,
  stderr: string,
): string {
  const diagnostic = `${stdout.slice(0, 262_144)}\n${stderr.slice(0, 262_144)}`
  if (/HTTP\s*401|invalid api key|unauthori[sz]ed/i.test(diagnostic))
    return 'HERMES_PROVIDER_AUTH_REJECTED'
  if (/HTTP\s*403|forbidden|access denied/i.test(diagnostic))
    return 'HERMES_PROVIDER_ACCESS_REJECTED'
  if (/HTTP\s*429|rate.?limit|quota|credit|balance/i.test(diagnostic))
    return 'HERMES_PROVIDER_CAPACITY_REJECTED'
  if (/model.{0,40}(?:not found|unsupported|unknown)|HTTP\s*404/i.test(diagnostic))
    return 'HERMES_PROVIDER_MODEL_REJECTED'
  if (
    /HTTP\s*400|bad request|invalid_request|max_tokens|reasoning_effort|thinking/i.test(
      diagnostic,
    )
  )
    return 'HERMES_PROVIDER_REQUEST_REJECTED'
  if (
    /connection error|getaddrinfo|proxy error|connect(?:ion)? (?:refused|timeout)|timed? ?out|network (?:error|unreachable)/i.test(
      diagnostic,
    )
  )
    return 'HERMES_PROVIDER_NETWORK_ERROR'
  if (/permission denied/i.test(diagnostic)) {
    if (/\/run\/hermes-executor\/hermes-home-/i.test(diagnostic))
      return 'HERMES_PROFILE_HOME_PERMISSION_DENIED'
    if (/\/run\/hermes-executor\/hermes-run-/i.test(diagnostic))
      return 'HERMES_WORK_DIRECTORY_PERMISSION_DENIED'
    if (/\/opt\/proptimiza-hermes(?:\/|\b)/i.test(diagnostic))
      return 'HERMES_IMMUTABLE_SEED_PERMISSION_DENIED'
    if (/\/tmp(?:\/|\b)/i.test(diagnostic))
      return 'HERMES_TEMP_DIRECTORY_PERMISSION_DENIED'
    return 'HERMES_LOCAL_PERMISSION_DENIED'
  }
  if (/read-only file system/i.test(diagnostic))
    return 'HERMES_LOCAL_READ_ONLY_FILESYSTEM'
  if (/invalid yaml/i.test(diagnostic)) return 'HERMES_PROFILE_YAML_INVALID'
  if (/invalid config/i.test(diagnostic)) return 'HERMES_PROFILE_CONFIG_INVALID'
  if (/profile.{0,30}(?:invalid|error)/i.test(diagnostic))
    return 'HERMES_PROFILE_RUNTIME_ERROR'
  return `HERMES_EXIT_${exitCode}`
}

export interface ProcessInvocation {
  command: string
  args: Array<string>
  env: Record<string, string>
  uid: number
  gid: number
  shell: false
  detached: true
  cwd: string
  timeoutMs: number
  stdoutLimitBytes: number
  stderrLimitBytes: number
}

export interface ProcessOutput {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean
}
export interface ProcessRunner {
  run: (invocation: ProcessInvocation) => Promise<ProcessOutput>
}
export interface HomeOwnershipPreparer {
  prepare: (home: string, uid: number, gid: number) => Promise<void>
  reclaim?: (home: string, uid: number, gid: number) => Promise<void>
}

export interface ExecutorEnvelope {
  schema_version: '1.0'
  agent_result: AgentResult
  usage: TrustedUsage
}

export interface HermesExecutorOptions {
  runner: ProcessRunner
  ownership: HomeOwnershipPreparer
  profileSeed: string
  expectedSeedSha256: string
  temporaryRoot: string
  expectedTemporaryRoot: string
  expectedOwnerUid?: number
  expectedOwnerGid?: number
  expectedUsageUid?: number
  childUid: number
  childGid: number
  customApiKeyFile: string
  expectedSecretGid?: number
  readCustomApiKey?: (path: string, expectedGid: number) => Promise<string>
  safePath: string
  modelProxyUrl: string
  noProxy: string
  externalResearchEnabled: boolean
  timeoutMs: number
  stdoutLimitBytes?: number
  stderrLimitBytes?: number
  pricingClock?: () => Date
  pricingPreflight?: typeof assertOpenCodeGoExecutionPreflight
}

export interface ExecutorPort {
  execute: (input: ExecuteInput) => Promise<ExecutorEnvelope>
}

export type ExecutorExecutionState = 'not_started' | 'unknown' | 'finished'

export class ExecutorExecutionError extends Error {
  constructor(
    message: string,
    readonly executionState: ExecutorExecutionState,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ExecutorExecutionError'
  }
}

export class HermesExecutor implements ExecutorPort {
  constructor(private readonly options: HermesExecutorOptions) {
    if (options.childUid !== 10002 || options.childGid !== 10002)
      throw new Error('EXPECTED_CHILD_IDENTITY_REQUIRED')
    if (options.safePath !== HERMES_SAFE_PATH)
      throw new Error('UNSAFE_CHILD_PATH')
    if (
      options.modelProxyUrl !== EXECUTOR_MODEL_PROXY_URL ||
      options.noProxy !== EXECUTOR_NO_PROXY
    )
      throw new Error('EXECUTOR_MODEL_PROXY_INVALID')
    if (!/^[0-9a-f]{64}$/.test(options.expectedSeedSha256))
      throw new Error('PROFILE_SEED_HASH_REQUIRED')
    if (typeof options.externalResearchEnabled !== 'boolean')
      throw new Error('EXTERNAL_RESEARCH_GATE_REQUIRED')
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 3_600_000
    )
      throw new Error('HERMES_TIMEOUT_REQUIRED')
    for (const limit of [
      options.stdoutLimitBytes ?? 1_048_576,
      options.stderrLimitBytes ?? 262_144,
    ])
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 4_194_304)
        throw new Error('HERMES_OUTPUT_LIMIT_INVALID')
  }

  async execute(input: ExecuteInput): Promise<ExecutorEnvelope> {
    let executionState: ExecutorExecutionState = 'not_started'
    try {
      return await this.executeTracked(input, (state) => {
        executionState = state
      })
    } catch (error) {
      if (error instanceof ExecutorExecutionError) throw error
      throw new ExecutorExecutionError(
        error instanceof Error ? error.message : 'EXECUTOR_FAILURE',
        executionState,
        { cause: error },
      )
    }
  }

  private async executeTracked(
    input: ExecuteInput,
    setExecutionState: (state: ExecutorExecutionState) => void,
  ): Promise<ExecutorEnvelope> {
    if (!ACTIVE_PROFILES.includes(input.profile_id))
      throw new Error('UNKNOWN_PROFILE')
    const request = validateExecuteRequest({
      request_id: `local-${input.assignment_id}`,
      type: 'execute',
      ...input,
    })
    if (request.execution_timeout_ms !== this.options.timeoutMs)
      throw new Error('HERMES_TIMEOUT_HANDSHAKE_MISMATCH')
    assertExecutionAuthority(request, this.options.externalResearchEnabled)
    const pricingNow = (this.options.pricingClock ?? (() => new Date()))()
    ;(this.options.pricingPreflight ?? assertOpenCodeGoExecutionPreflight)(
      request.reservation,
      pricingNow,
    )
    const ownerUid = this.options.expectedOwnerUid ?? process.getuid?.() ?? 0
    await assertSecureDirectory(
      this.options.temporaryRoot,
      this.options.expectedTemporaryRoot,
      ownerUid,
    )
    await assertSecureSeed(
      this.options.profileSeed,
      ownerUid,
      this.options.expectedSeedSha256,
      input.profile_id,
      input.reservation,
    )
    const customApiKey = await (this.options.readCustomApiKey ?? readGroupSecretFile)(
      this.options.customApiKeyFile,
      this.options.expectedSecretGid ?? 10000,
    )
    const home = await mkdtemp(join(this.options.temporaryRoot, 'hermes-home-'))
    const cwd = await mkdtemp(join(this.options.temporaryRoot, 'hermes-run-'))
    try {
      await cp(this.options.profileSeed, home, {
        recursive: true,
        force: false,
      })
      if ((await hashProfileSeed(home)) !== this.options.expectedSeedSha256)
        throw new Error('PROFILE_SEED_POST_COPY_MISMATCH')
      await this.options.ownership.prepare(
        home,
        this.options.childUid,
        this.options.childGid,
      )
      if ((await readdir(cwd)).length !== 0)
        throw new Error('HERMES_CWD_NOT_EMPTY')
      await this.options.ownership.prepare(
        cwd,
        this.options.childUid,
        this.options.childGid,
      )
      const usageFile = join(cwd, 'usage.json')
      const startedAt = new Date().toISOString()
      setExecutionState('unknown')
      const output = await this.options.runner.run({
        command: HERMES_BINARY,
        args: [
          '-p',
          input.profile_id,
          '-z',
          buildHermesPrompt(request),
          '--usage-file',
          usageFile,
        ],
        env: {
          [HERMES_KEY_ENV]: customApiKey,
          [HERMES_BASE_URL_ENV]: HERMES_BASE_URL,
          HERMES_HOME: home,
          HOME: home,
          HTTP_PROXY: this.options.modelProxyUrl,
          HTTPS_PROXY: this.options.modelProxyUrl,
          LANG: 'C.UTF-8',
          NO_PROXY: this.options.noProxy,
          PATH: HERMES_SAFE_PATH,
        },
        uid: this.options.childUid,
        gid: this.options.childGid,
        shell: false,
        detached: true,
        cwd,
        timeoutMs: this.options.timeoutMs,
        stdoutLimitBytes: this.options.stdoutLimitBytes ?? 1_048_576,
        stderrLimitBytes: this.options.stderrLimitBytes ?? 262_144,
      })
      if (output.timedOut) throw new Error('HERMES_TIMEOUT')
      setExecutionState('finished')
      if (output.exitCode !== 0)
        throw new Error(
          classifyHermesExit(output.exitCode, output.stdout, output.stderr),
        )
      await this.options.ownership.reclaim?.(
        cwd,
        ownerUid,
        this.options.expectedOwnerGid ?? process.getgid?.() ?? ownerUid,
      )
      let usagePayload: string
      try {
        usagePayload = await readSecureUsageFile(
          usageFile,
          this.options.expectedUsageUid ?? this.options.childUid,
        )
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'HERMES_USAGE_UNKNOWN'
        ) {
          const classified = classifyHermesExit(
            1,
            output.stdout,
            output.stderr,
          )
          if (classified !== 'HERMES_EXIT_1') throw new Error(classified)
        }
        throw error
      }
      let nativeUsage: TrustedUsage
      try {
        nativeUsage = validateHermesUsage(
          JSON.parse(usagePayload) as unknown,
          input.reservation,
        )
      } catch (error) {
        if (error instanceof Error && error.message === 'HERMES_USAGE_FAILED') {
          const classified = classifyHermesExit(1, output.stdout, output.stderr)
          if (classified !== 'HERMES_EXIT_1') throw new Error(classified)
        }
        throw error
      }
      const usage = priceOpenCodeGoUsage(nativeUsage, pricingNow)
      const finishedAt = new Date().toISOString()
      let agentResult: AgentResult
      try {
        let rawResult: unknown
        try {
          rawResult = JSON.parse(output.stdout)
        } catch {
          throw new Error('INVALID_EXECUTOR_ENVELOPE')
        }
        agentResult = reconcileAgentResult(
          rawResult,
          input,
          usage,
          input.reservation.budget_reservation,
          startedAt,
          finishedAt,
        )
      } catch (error) {
        const code = error instanceof Error ? error.message : 'EXECUTOR_FAILURE'
        if (!RESULT_VALIDATION_FAILURES.has(code) && !code.startsWith('INVALID_AGENT_RESULT_')) throw error
        // Usage is already trusted and priced at this boundary. Return a
        // runtime-owned failed AgentResult so the broker can settle the ledger
        // without accepting or retaining malformed model output.
        agentResult = reconcileAgentResult(
          runtimeValidationFailure(input, code, startedAt, finishedAt),
          input,
          usage,
          input.reservation.budget_reservation,
          startedAt,
          finishedAt,
        )
      }
      return { schema_version: '1.0', agent_result: agentResult, usage }
    } finally {
      await this.options.ownership.reclaim?.(
        home,
        ownerUid,
        this.options.expectedOwnerGid ?? process.getgid?.() ?? ownerUid,
      )
      await this.options.ownership.reclaim?.(
        cwd,
        ownerUid,
        this.options.expectedOwnerGid ?? process.getgid?.() ?? ownerUid,
      )
      await rm(home, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

const EXECUTION_CAPABILITIES: Record<
  ProfileId,
  {
    tools: string[]
    actions: string[]
    channels: string[]
    research: boolean
  }
> = {
  'sales-orchestrator': {
    tools: ['hermes.analysis'],
    actions: ['analysis.internal'],
    channels: ['internal'],
    research: false,
  },
  'market-account-intelligence': {
    tools: ['hermes.analysis', 'hermes.web'],
    actions: ['analysis.internal', 'research.public.read'],
    channels: ['internal', 'public_web'],
    research: true,
  },
  'contact-data-steward': {
    tools: ['hermes.analysis', 'hermes.web'],
    actions: ['analysis.internal', 'research.public.read'],
    channels: ['internal', 'public_web'],
    research: true,
  },
  'qualification-prioritization': {
    tools: ['hermes.analysis'],
    actions: ['analysis.internal'],
    channels: ['internal'],
    research: false,
  },
  'outreach-draft-manager': {
    tools: ['hermes.analysis', 'hermes.file.ephemeral'],
    actions: ['analysis.internal', 'artifact.prepare'],
    channels: ['internal'],
    research: false,
  },
  'commercial-qa-compliance': {
    tools: ['hermes.analysis'],
    actions: ['analysis.internal'],
    channels: ['internal'],
    research: false,
  },
}

export function assertExecutionAuthority(
  input: ExecuteInput,
  externalResearchEnabled: boolean,
): void {
  const capability = EXECUTION_CAPABILITIES[input.profile_id]
  const policy = input.execution_policy
  const tools = new Set(policy.approved_tools)
  const actions = new Set(policy.allowed_actions)
  const channels = new Set(policy.approved_channels)
  if (
    capability.tools.some((item) => !tools.has(item)) ||
    capability.actions.some((item) => !actions.has(item)) ||
    capability.channels.some((item) => !channels.has(item)) ||
    (capability.research &&
      (!externalResearchEnabled ||
        !['A1', 'A2'].includes(policy.autonomy_level)))
  )
    throw new Error('EXECUTION_TOOL_POLICY_DENIED')
}

const RESULT_VALIDATION_FAILURES = new Set([
  'INVALID_EXECUTOR_ENVELOPE',
  'INVALID_AGENT_RESULT',
  'SIMULATION_EXTERNAL_CHANGE',
  'SIMULATION_EXTERNAL_ACTION',
])

function runtimeValidationFailure(
  input: ExecuteInput,
  code: string,
  startedAt: string,
  finishedAt: string,
): AgentResult {
  return {
    mission_id: input.mission_id,
    trace_id: input.trace_id,
    assignment_id: input.assignment_id,
    agent_id: input.profile_id,
    status: 'failed',
    summary: 'Hermes completed the inference, but the deterministic runtime rejected the model output contract.',
    facts: [],
    inferences: [],
    actions_taken: [],
    external_changes: [],
    evidence: [],
    artifacts: [],
    metrics: { runtime_output_accepted: false },
    cost: {
      currency: 'USD',
      llm: 0,
      tools: 0,
      total: 0,
      input_tokens: 0,
      output_tokens: 0,
    },
    errors: [
      {
        code,
        message: 'Model output was rejected without storing its content.',
        recoverable: false,
        attempts: 1,
        next_safe_step: 'Review the trusted prompt and schema before authorizing a new execution.',
      },
    ],
    risks: [],
    pending_approvals: [],
    recommended_next_actions: [
      'Review the trusted prompt and schema before authorizing a new execution.',
    ],
    started_at: startedAt,
    finished_at: finishedAt,
  }
}

export class NodeProcessRunner implements ProcessRunner {
  async run(invocation: ProcessInvocation): Promise<ProcessOutput> {
    return new Promise((resolvePromise, reject) => {
      const isolatedChild =
        process.platform !== 'win32' &&
        invocation.uid === 10002 &&
        invocation.gid === 10002
      const child = spawn(
        isolatedChild ? SETPRIV_BINARY : invocation.command,
        isolatedChild
          ? [
              '--clear-groups',
              '--reuid=10002',
              '--regid=10002',
              '--inh-caps=-all',
              '--ambient-caps=-all',
              '--bounding-set=-all',
              '--no-new-privs',
              '--',
              invocation.command,
              ...invocation.args,
            ]
          : invocation.args,
        {
        env: invocation.env,
        ...(isolatedChild
          ? {}
          : { uid: invocation.uid, gid: invocation.gid }),
        shell: false,
        detached: true,
        cwd: invocation.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      const stdout: Array<Buffer> = []
      const stderr: Array<Buffer> = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let timedOut = false
      let overflow: Error | undefined
      let settled = false
      const terminate = () => {
        if (!child.pid) return
        try {
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > invocation.stdoutLimitBytes) {
          overflow ??= new Error('HERMES_STDOUT_LIMIT')
          terminate()
        } else stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length
        if (stderrBytes > invocation.stderrLimitBytes) {
          overflow ??= new Error('HERMES_STDERR_LIMIT')
          terminate()
        } else stderr.push(chunk)
      })
      const timer = setTimeout(() => {
        timedOut = true
        terminate()
      }, invocation.timeoutMs)
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', async (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        terminate()
        try {
          await waitForProcessGroupExit(child.pid)
        } catch (error) {
          reject(error)
          return
        }
        if (overflow) reject(overflow)
        else
          resolvePromise({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            exitCode: code ?? -1,
            timedOut,
          })
      })
    })
  }
}

async function waitForProcessGroupExit(pid: number | undefined): Promise<void> {
  if (process.platform === 'win32' || !pid) return
  const deadline = Date.now() + 2_000
  for (;;) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    if (Date.now() >= deadline)
      throw new Error('HERMES_PROCESS_GROUP_NOT_REAPED')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
}

export class PosixHomeOwnershipPreparer implements HomeOwnershipPreparer {
  constructor(
    private readonly expectedRoot: string,
    private readonly supervisorUid = 10000,
    private readonly supervisorGid = 10000,
  ) {}

  async prepare(home: string, uid: number, gid: number): Promise<void> {
    await this.assertScopedHome(home)
    if (uid !== 10002 || gid !== 10002)
      throw new Error('EXPECTED_CHILD_IDENTITY_REQUIRED')
    try {
      await this.prepareEntry(home, uid, gid)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code))
        throw new Error(`POSIX_EPHEMERAL_HOME_PREPARE_${code}`)
      throw error
    }
  }

  async reclaim(home: string, uid: number, gid: number): Promise<void> {
    await this.assertScopedHome(home)
    if (uid !== this.supervisorUid || gid !== this.supervisorGid)
      throw new Error('EXECUTOR_EFFECTIVE_IDENTITY_INVALID')
    await this.reclaimDirectoryTree(home, uid, gid)
  }

  private async assertScopedHome(path: string): Promise<void> {
    if (
      !isAbsolute(path) ||
      !isAbsolute(this.expectedRoot) ||
      dirname(resolve(path)) !== resolve(this.expectedRoot) ||
      !resolve(path).startsWith(`${resolve(this.expectedRoot)}${sep}`) ||
      resolve(await realpath(this.expectedRoot)) !== resolve(this.expectedRoot)
    )
      throw new Error('UNSAFE_EPHEMERAL_HOME_PATH')
    const root = await lstat(this.expectedRoot)
    if (
      root.isSymbolicLink() ||
      !root.isDirectory() ||
      (process.platform !== 'win32' &&
        (root.uid !== this.supervisorUid ||
          root.gid !== this.supervisorGid ||
          (root.mode & 0o777) !== 0o711))
    )
      throw new Error('UNSAFE_EPHEMERAL_HOME_PATH')
  }

  private async prepareEntry(
    path: string,
    uid: number,
    gid: number,
  ): Promise<void> {
    const metadata = await lstat(path)
    if (
      metadata.isSymbolicLink() ||
      (!metadata.isDirectory() && !metadata.isFile()) ||
      (!metadata.isDirectory() && metadata.nlink !== 1)
    )
      throw new Error('UNSAFE_PROFILE_SEED_SYMLINK')
    if (metadata.isDirectory())
      for (const entry of await readdir(path))
        await this.prepareEntry(join(path, entry), uid, gid)
    if (process.platform !== 'win32') {
      if (metadata.isDirectory()) {
        await chmod(path, 0o710)
        await chown(path, uid, this.supervisorGid)
      } else {
        // The capability-bounded supervisor owns the copied file but has no
        // DAC_OVERRIDE. Make it writable before ownership passes to the child.
        await chmod(path, 0o600)
        await chown(path, uid, gid)
      }
    }
  }

  private async reclaimDirectoryTree(
    path: string,
    uid: number,
    gid: number,
  ): Promise<void> {
    const metadata = await lstat(path)
    if (!metadata.isDirectory()) return
    if (process.platform !== 'win32') {
      await chown(path, uid, gid)
      await chmod(path, 0o700)
    }
    for (const entry of await readdir(path))
      await this.reclaimDirectoryTree(join(path, entry), uid, gid)
  }
}

export async function hashProfileSeed(root: string): Promise<string> {
  const hash = createHash('sha256')
  const field = (value: Buffer) => {
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(value.length))
    hash.update(length)
    hash.update(value)
  }
  const walk = async (path: string) => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink())
      throw new Error('UNSAFE_PROFILE_SEED_SYMLINK')
    const name = relative(root, path).replaceAll('\\', '/')
    if (name) {
      hash.update(metadata.isDirectory() ? 'd' : 'f')
      field(Buffer.from(name, 'utf8'))
    }
    if (metadata.isDirectory()) {
      for (const entry of (await readdir(path)).sort())
        await walk(join(path, entry))
    } else field(await readFile(path))
  }
  await walk(root)
  return hash.digest('hex')
}

async function assertSecureDirectory(
  path: string,
  expected: string,
  ownerUid: number,
): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== resolve(expected))
    throw new Error('TEMPORARY_ROOT_ABSOLUTE_REQUIRED')
  const metadata = await lstat(path)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    resolve(await realpath(path)) !== resolve(path)
  )
    throw new Error('UNSAFE_TEMPORARY_ROOT')
  if (
    process.platform !== 'win32' &&
    (metadata.uid !== ownerUid || (metadata.mode & 0o777) !== 0o711)
  )
    throw new Error('UNSAFE_TEMPORARY_ROOT')
}
async function assertSecureSeed(
  path: string,
  ownerUid: number,
  expectedHash: string,
  profile: ProfileId,
  reservation: ExecuteInput['reservation'],
): Promise<void> {
  if (!isAbsolute(path)) throw new Error('PROFILE_SEED_ABSOLUTE_REQUIRED')
  await validateSeedTree(path, ownerUid)
  if ((await hashProfileSeed(path)) !== expectedHash)
    throw new Error('PROFILE_SEED_HASH_MISMATCH')
  const parsed = parseYaml(
    await readFile(join(path, 'profiles', profile, 'config.yaml'), 'utf8'),
  ) as unknown
  if (!record(parsed)) throw new Error('PROFILE_MANIFEST_MISMATCH')
  const model = record(parsed.model) ? parsed.model : null
  const agent = record(parsed.agent) ? parsed.agent : null
  if (
    parsed.custom_providers !== undefined ||
    parsed.providers !== undefined ||
    !model ||
    model.default !== HERMES_MODEL ||
    model.provider !== HERMES_PROVIDER ||
    !agent
  )
    throw new Error('PROFILE_MANIFEST_MISMATCH')
  const maxTokens = model.max_tokens
  const maxTurns = agent.max_turns
  if (
    !Number.isSafeInteger(maxTokens) ||
    Number(maxTokens) <= 0 ||
    !Number.isSafeInteger(maxTurns) ||
    Number(maxTurns) <= 0 ||
    reservation.maximum_tokens < Number(maxTokens) * Number(maxTurns) ||
    reservation.maximum_api_calls < Number(maxTurns)
  )
    throw new Error('PROFILE_BUDGET_CEILING_MISMATCH')
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
async function validateSeedTree(path: string, ownerUid: number): Promise<void> {
  const metadata = await lstat(path)
  if (
    metadata.isSymbolicLink() ||
    (!metadata.isDirectory() && !metadata.isFile()) ||
    (process.platform !== 'win32' &&
      (metadata.uid !== ownerUid || (metadata.mode & 0o022) !== 0))
  )
    throw new Error('UNSAFE_PROFILE_SEED')
  if (metadata.isDirectory())
    for (const entry of await readdir(path))
      await validateSeedTree(join(path, entry), ownerUid)
}
async function readSecureUsageFile(
  path: string,
  ownerUid: number,
): Promise<string> {
  let handle
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
    )
    const metadata = await handle.stat()
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size <= 0 ||
      metadata.size > 65_536 ||
      (process.platform !== 'win32' && metadata.uid !== ownerUid)
    )
      throw new Error('UNSAFE_HERMES_USAGE_FILE')
    return await handle.readFile('utf8')
  } catch (error) {
    if (error instanceof Error && error.message === 'UNSAFE_HERMES_USAGE_FILE')
      throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('HERMES_USAGE_UNKNOWN')
    throw new Error('UNSAFE_HERMES_USAGE_FILE')
  } finally {
    await handle?.close()
  }
}
