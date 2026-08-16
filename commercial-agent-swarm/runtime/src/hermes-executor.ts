import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chown, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ACTIVE_PROFILES, buildHermesPrompt, validateExecuteRequest, validateHermesUsage, type ExecuteInput, type ProfileId, type TrustedUsage } from './executor-contract.js'
import { reconcileAgentResult, type AgentResult } from './agent-result.js'
export { ACTIVE_PROFILES, type ExecuteInput, type ProfileId } from './executor-contract.js'

export const HERMES_BINARY = '/opt/hermes/.venv/bin/hermes'
export const HERMES_SAFE_PATH = '/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin'
export const HERMES_MODEL = 'deepseek-v4-flash'
export const HERMES_PROVIDER = 'custom:deepseek-v4-flash'
export const HERMES_BASE_URL = 'https://opencode.ai/zen/go/v1'

export interface ProcessInvocation {
  command: string
  args: string[]
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

export interface ProcessOutput { stdout: string; stderr: string; exitCode: number; timedOut?: boolean }
export interface ProcessRunner { run(invocation: ProcessInvocation): Promise<ProcessOutput> }
export interface HomeOwnershipPreparer { prepare(home: string, uid: number, gid: number): Promise<void> }

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
  expectedUsageUid?: number
  childUid: 10000
  childGid: 10000
  customApiKeyFile: string
  safePath: typeof HERMES_SAFE_PATH
  timeoutMs: number
  stdoutLimitBytes?: number
  stderrLimitBytes?: number
}

export interface ExecutorPort { execute(input: ExecuteInput): Promise<ExecutorEnvelope> }

export class HermesExecutor implements ExecutorPort {
  constructor(private readonly options: HermesExecutorOptions) {
    if (options.childUid !== 10000 || options.childGid !== 10000) throw new Error('EXPECTED_CHILD_IDENTITY_REQUIRED')
    if (options.safePath !== HERMES_SAFE_PATH) throw new Error('UNSAFE_CHILD_PATH')
    if (!/^[0-9a-f]{64}$/.test(options.expectedSeedSha256)) throw new Error('PROFILE_SEED_HASH_REQUIRED')
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 3_600_000) throw new Error('HERMES_TIMEOUT_REQUIRED')
    for(const limit of [options.stdoutLimitBytes??1_048_576,options.stderrLimitBytes??262_144])if(!Number.isSafeInteger(limit)||limit<=0||limit>4_194_304)throw new Error('HERMES_OUTPUT_LIMIT_INVALID')
  }

  async execute(input: ExecuteInput): Promise<ExecutorEnvelope> {
    if (!ACTIVE_PROFILES.includes(input.profile_id as ProfileId)) throw new Error('UNKNOWN_PROFILE')
    const request=validateExecuteRequest({request_id:`local-${input.assignment_id}`,type:'execute',...input})
    const ownerUid = this.options.expectedOwnerUid ?? (process.getuid?.() ?? 0)
    await assertSecureDirectory(this.options.temporaryRoot,this.options.expectedTemporaryRoot, ownerUid)
    await assertSecureSeed(this.options.profileSeed, ownerUid, this.options.expectedSeedSha256, input.profile_id,input.reservation)
    const customApiKey = await readRootOnlySecret(this.options.customApiKeyFile, ownerUid)
    const home = await mkdtemp(join(this.options.temporaryRoot, 'hermes-home-'))
    const cwd = await mkdtemp(join(this.options.temporaryRoot, 'hermes-run-'))
    try {
      await cp(this.options.profileSeed, home, { recursive: true, force: false })
      if (await hashProfileSeed(home) !== this.options.expectedSeedSha256) throw new Error('PROFILE_SEED_POST_COPY_MISMATCH')
      await this.options.ownership.prepare(home, this.options.childUid, this.options.childGid)
      await this.options.ownership.prepare(cwd, this.options.childUid, this.options.childGid)
      if ((await readdir(cwd)).length !== 0) throw new Error('HERMES_CWD_NOT_EMPTY')
      const usageFile = join(cwd, 'usage.json')
      const startedAt = new Date().toISOString()
      const output = await this.options.runner.run({
        command: HERMES_BINARY,
        args: ['-p', input.profile_id, '-z', buildHermesPrompt(request), '--usage-file', usageFile],
        env: { CUSTOM_API_KEY: customApiKey, HERMES_HOME: home, HOME: home, LANG: 'C.UTF-8', PATH: HERMES_SAFE_PATH },
        uid: 10000, gid: 10000, shell: false, detached: true, cwd,
        timeoutMs: this.options.timeoutMs,
        stdoutLimitBytes: this.options.stdoutLimitBytes ?? 1_048_576,
        stderrLimitBytes: this.options.stderrLimitBytes ?? 262_144,
      })
      if (output.timedOut) throw new Error('HERMES_TIMEOUT')
      if (output.exitCode !== 0) throw new Error(`HERMES_EXIT_${output.exitCode}`)
      const usage = validateHermesUsage(JSON.parse(await readSecureUsageFile(usageFile,this.options.expectedUsageUid??10000)) as unknown, input.reservation)
      let rawResult:unknown; try{rawResult=JSON.parse(output.stdout)}catch{throw new Error('INVALID_EXECUTOR_ENVELOPE')}
      const agentResult=reconcileAgentResult(rawResult,input,usage,input.reservation.budget_reservation,startedAt,new Date().toISOString())
      return {schema_version:'1.0',agent_result:agentResult,usage}
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

export class NodeProcessRunner implements ProcessRunner {
  async run(invocation: ProcessInvocation): Promise<ProcessOutput> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(invocation.command, invocation.args, { env: invocation.env, uid: invocation.uid, gid: invocation.gid, shell: false, detached: true, cwd: invocation.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let stdoutBytes = 0; let stderrBytes = 0; let timedOut = false; let overflow: Error | undefined; let settled = false
      const terminate = () => { if (!child.pid) return; try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') } catch {} }
      child.stdout.on('data', (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > invocation.stdoutLimitBytes) { overflow ??= new Error('HERMES_STDOUT_LIMIT'); terminate() } else stdout.push(chunk) })
      child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > invocation.stderrLimitBytes) { overflow ??= new Error('HERMES_STDERR_LIMIT'); terminate() } else stderr.push(chunk) })
      const timer = setTimeout(() => { timedOut = true; terminate() }, invocation.timeoutMs)
      child.once('error', error => { if (settled) return; settled = true; clearTimeout(timer); reject(error) })
      child.once('close', async code => { if (settled) return; settled = true; clearTimeout(timer); try{await waitForProcessGroupExit(child.pid)}catch(error){reject(error);return}if (overflow) reject(overflow); else resolvePromise({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? -1, timedOut }) })
    })
  }
}

async function waitForProcessGroupExit(pid:number|undefined):Promise<void>{if(process.platform==='win32'||!pid)return;const deadline=Date.now()+2_000;for(;;){try{process.kill(-pid,0)}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw error}if(Date.now()>=deadline)throw new Error('HERMES_PROCESS_GROUP_NOT_REAPED');await new Promise(resolvePromise=>setTimeout(resolvePromise,10))}}

export class PosixHomeOwnershipPreparer implements HomeOwnershipPreparer {
  async prepare(home: string, uid: number, gid: number): Promise<void> { await this.prepareEntry(home, uid, gid) }
  private async prepareEntry(path: string, uid: number, gid: number): Promise<void> { const metadata = await lstat(path); if (metadata.isSymbolicLink()) throw new Error('UNSAFE_PROFILE_SEED_SYMLINK'); if (metadata.isDirectory()) for (const entry of await readdir(path)) await this.prepareEntry(join(path, entry), uid, gid); await chown(path, uid, gid) }
}

export async function hashProfileSeed(root: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (path: string) => { const metadata = await lstat(path); if (metadata.isSymbolicLink()) throw new Error('UNSAFE_PROFILE_SEED_SYMLINK'); const name = relative(root, path).replaceAll('\\','/'); if (name) hash.update(`${metadata.isDirectory() ? 'd' : 'f'}:${name}\0`); if (metadata.isDirectory()) { for (const entry of (await readdir(path)).sort()) await walk(join(path, entry)) } else hash.update(await readFile(path)) }
  await walk(root); return hash.digest('hex')
}

async function assertSecureDirectory(path:string,expected:string,ownerUid:number):Promise<void>{ if(!isAbsolute(path)||resolve(path)!==resolve(expected))throw new Error('TEMPORARY_ROOT_ABSOLUTE_REQUIRED'); const metadata=await lstat(path); if(metadata.isSymbolicLink()||!metadata.isDirectory()||resolve(await realpath(path))!==resolve(path))throw new Error('UNSAFE_TEMPORARY_ROOT'); if(process.platform!=='win32'&&(metadata.uid!==ownerUid||(metadata.mode&0o022)!==0))throw new Error('UNSAFE_TEMPORARY_ROOT') }
async function assertSecureSeed(path:string,ownerUid:number,expectedHash:string,profile:ProfileId,reservation:ExecuteInput['reservation']):Promise<void>{ if(!isAbsolute(path))throw new Error('PROFILE_SEED_ABSOLUTE_REQUIRED');await validateSeedTree(path,ownerUid);if(await hashProfileSeed(path)!==expectedHash)throw new Error('PROFILE_SEED_HASH_MISMATCH'); const config=await readFile(join(path,'profiles',profile,'config.yaml'),'utf8'); if(!config.includes(HERMES_PROVIDER)||!config.includes(HERMES_MODEL)||!config.includes(HERMES_BASE_URL))throw new Error('PROFILE_MANIFEST_MISMATCH');const maxTokens=Number(/max_tokens:\s*(\d+)/.exec(config)?.[1]);const maxTurns=Number(/max_turns:\s*(\d+)/.exec(config)?.[1]);if(!Number.isSafeInteger(maxTokens)||maxTokens<=0||!Number.isSafeInteger(maxTurns)||maxTurns<=0||reservation.maximum_tokens<maxTokens*maxTurns||reservation.maximum_api_calls<maxTurns)throw new Error('PROFILE_BUDGET_CEILING_MISMATCH') }
async function validateSeedTree(path:string,ownerUid:number):Promise<void>{const metadata=await lstat(path);if(metadata.isSymbolicLink()||(!metadata.isDirectory()&&!metadata.isFile())||process.platform!=='win32'&&(metadata.uid!==ownerUid||(metadata.mode&0o022)!==0))throw new Error('UNSAFE_PROFILE_SEED');if(metadata.isDirectory())for(const entry of await readdir(path))await validateSeedTree(join(path,entry),ownerUid)}
async function readRootOnlySecret(path:string,ownerUid:number):Promise<string>{ if(!isAbsolute(path)||resolve(await realpath(path))!==resolve(path))throw new Error('UNSAFE_CUSTOM_API_KEY_FILE'); const metadata=await lstat(path); if(metadata.isSymbolicLink()||!metadata.isFile()||metadata.nlink!==1||metadata.size<=0||metadata.size>16_384)throw new Error('UNSAFE_CUSTOM_API_KEY_FILE'); if(process.platform!=='win32'&&(metadata.uid!==ownerUid||(metadata.mode&0o077)!==0))throw new Error('UNSAFE_CUSTOM_API_KEY_FILE'); const secret=(await readFile(path,'utf8')).trim(); if(!secret)throw new Error('CUSTOM_API_KEY_REQUIRED'); return secret }
async function readSecureUsageFile(path:string,ownerUid:number):Promise<string>{let handle;try{handle=await open(path,fsConstants.O_RDONLY|(process.platform==='win32'?0:fsConstants.O_NOFOLLOW));const metadata=await handle.stat();if(!metadata.isFile()||metadata.nlink!==1||metadata.size<=0||metadata.size>65_536||process.platform!=='win32'&&metadata.uid!==ownerUid)throw new Error('UNSAFE_HERMES_USAGE_FILE');return await handle.readFile('utf8')}catch(error){if(error instanceof Error&&error.message==='UNSAFE_HERMES_USAGE_FILE')throw error;throw new Error('UNSAFE_HERMES_USAGE_FILE')}finally{await handle?.close()}}
