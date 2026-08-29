import { randomUUID } from 'node:crypto'
import { chmod, lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  A1CodexSigningError,
  signAuthorizedA1Order,
  type A1CodexSignedOrder,
  type A1CodexSigningExpectation,
} from './a1-codex-signer.js'
import type { A1AuthorizedOrderCandidate } from './a1-authorized-order-candidate.js'

const MAX_JSON_BYTES = 1_048_576
const MAX_KEY_BYTES = 16_384
const EXPECTED_FLAGS = new Set(['--candidate', '--expectation', '--private-key', '--public-key', '--output'])

interface SignerDependencies {
  now(): Date
  sign(
    candidate: A1AuthorizedOrderCandidate,
    expectation: A1CodexSigningExpectation,
    privateKeyPem: string,
    publicKeyPem: string,
    authority: { issuer: string; audience: string },
    now: Date,
  ): A1CodexSignedOrder
  write(line: string): void
}

const defaultDependencies: SignerDependencies = {
  now: () => new Date(),
  sign: signAuthorizedA1Order,
  write: (line) => process.stdout.write(`${line}\n`),
}

/** Offline-only CLI. It has no network, database or broker dependency. */
export async function runA1CodexSignerCli(
  argv: string[],
  dependencies: SignerDependencies = defaultDependencies,
): Promise<void> {
  const args = parseArgs(argv)
  const candidatePath = await exactRegularFile(args['--candidate'], MAX_JSON_BYTES)
  const expectationPath = await exactRegularFile(args['--expectation'], MAX_JSON_BYTES)
  const privateKeyPath = await exactRegularFile(args['--private-key'], MAX_KEY_BYTES)
  const publicKeyPath = await exactRegularFile(args['--public-key'], MAX_KEY_BYTES)
  if (privateKeyPath === publicKeyPath) fail()

  const outputPath = resolve(args['--output'])
  const outputParent = await realpath(dirname(outputPath))
  const parentStat = await lstat(outputParent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || resolve(outputParent, basename(outputPath)) !== outputPath)
    fail()
  try { await lstat(outputPath); fail() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }

  const candidate = await readJson(candidatePath) as A1AuthorizedOrderCandidate
  const expectation = await readJson(expectationPath) as A1CodexSigningExpectation
  const privateKey = await readFile(privateKeyPath, 'utf8')
  const publicKey = await readFile(publicKeyPath, 'utf8')
  if (!privateKey.includes('BEGIN PRIVATE KEY') || !publicKey.includes('BEGIN PUBLIC KEY')) fail()

  const result = dependencies.sign(
    candidate,
    expectation,
    privateKey,
    publicKey,
    { issuer: 'codex', audience: 'hermes-commercial-orchestrator' },
    dependencies.now(),
  )
  if (result.persisted || result.missionCreated || result.dispatchQueued || result.nextRequiredGate !== 'submit_signed_order_separately') fail()

  const tempPath = resolve(outputParent, `.${basename(outputPath)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(result)}\n`, 'utf8')
    await handle.sync()
    await handle.close(); handle = undefined
    await chmod(tempPath, 0o600)
    await rename(tempPath, outputPath)
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
  dependencies.write('a1_codex_signer=prepared_offline')
  dependencies.write(`mission_id=${result.missionId}`)
  dependencies.write(`signed_work_order_sha256=${result.signedWorkOrderSha256}`)
  dependencies.write('persisted=false')
  dependencies.write('mission_created=false')
  dependencies.write('dispatch_queued=false')
  dependencies.write('next_required_gate=submit_signed_order_separately')
}

function parseArgs(argv: string[]): Record<string, string> {
  if (argv.length !== EXPECTED_FLAGS.size * 2) fail()
  const result: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1]
    if (!flag || !EXPECTED_FLAGS.has(flag) || result[flag] || !value || value.startsWith('--')) fail()
    result[flag] = value
  }
  if (Object.keys(result).length !== EXPECTED_FLAGS.size) fail()
  return result
}

async function exactRegularFile(path: string, maximum: number): Promise<string> {
  const requested = resolve(path)
  const stat = await lstat(requested)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) fail()
  const actual = await realpath(requested)
  if (actual !== requested) fail()
  return actual
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch { fail() }
}

function fail(): never { throw new A1CodexSigningError() }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runA1CodexSignerCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof A1CodexSigningError ? error.message : 'A1_CODEX_SIGNER_FAILED'}\n`)
    process.exitCode = 1
  })
}
