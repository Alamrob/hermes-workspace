import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  A0BatchSealingError,
  prepareA0BatchSigningCandidate,
  signAuthorizedA0Batch,
  type A0ArtifactMaterial,
  type A0BatchSigningCandidate,
  type A0BatchSigningGate,
} from './a0-batch-sealer.js'
import {
  A0_BEHAVIOR_PROFILES,
  hashA0Canonical,
} from './a0-behavior-batch-admission.js'

const PROFILE_FILES = [
  'distribution.yaml',
  'config.yaml',
  'SOUL.md',
  'mcp.json',
] as const
const TEST_CASES = Array.from(
  { length: 16 },
  (_, index) => `T${String(index + 1).padStart(2, '0')}`,
)
const MAX_JSON_BYTES = 1_048_576
const MAX_KEY_BYTES = 16_384
const MAX_TOTAL_BYTES = 16_777_216
const PREVIEW_FLAGS = new Set([
  '--plan-bundle',
  '--fixtures-root',
  '--profiles-root',
  '--test-case',
  '--public-key',
  '--output-candidate',
])
const SEAL_FLAGS = new Set([
  '--plan-bundle',
  '--fixtures-root',
  '--profiles-root',
  '--test-case',
  '--candidate',
  '--gate',
  '--private-key',
  '--public-key',
  '--output-dir',
])

interface CliDependencies {
  now(): Date
  write(line: string): void
}

const defaultDependencies: CliDependencies = {
  now: () => new Date(),
  write: (line) => process.stdout.write(`${line}\n`),
}

/** Offline-only CLI. It has no network, database, provider or dispatch port. */
export async function runA0BatchSealerCli(
  argv: string[],
  dependencies: CliDependencies = defaultDependencies,
): Promise<void> {
  const mode = argv[0]
  const allowed = mode === 'preview' ? PREVIEW_FLAGS : mode === 'seal' ? SEAL_FLAGS : undefined
  if (!allowed) closed()
  const args = parseArgs(argv.slice(1), allowed)
  const planPath = await exactRegularFile(args['--plan-bundle'], MAX_JSON_BYTES)
  const publicKeyPath = await exactRegularFile(args['--public-key'], MAX_KEY_BYTES)
  const fixturesRoot = await exactDirectory(args['--fixtures-root'])
  const profilesRoot = await exactDirectory(args['--profiles-root'])
  const testCase = args['--test-case']
  if (!TEST_CASES.includes(testCase)) closed()
  const bundle = await readJson(planPath)
  const publicKey = await readFile(publicKeyPath, 'utf8')
  const { fixtureArtifacts, profileArtifacts } = await readArtifacts(
    fixturesRoot,
    profilesRoot,
  )
  const prepared = prepareA0BatchSigningCandidate({
    bundle,
    fixture_artifacts: fixtureArtifacts,
    profile_artifacts: profileArtifacts,
    test_case: testCase,
    public_key_pem: publicKey,
    now: dependencies.now(),
  })

  if (mode === 'preview') {
    const output = await exactAbsentOutputFile(args['--output-candidate'])
    await writeAtomicFile(output, jsonBytes(prepared.candidate), 0o600)
    dependencies.write('a0_batch_candidate=prepared_offline')
    dependencies.write(`candidate_sha256=${prepared.candidate.candidate_sha256}`)
    dependencies.write(
      `required_authorization_sha256=${prepared.candidate.required_authorization_sha256}`,
    )
    dependencies.write(
      `required_authorization_text=${prepared.candidate.required_authorization_text}`,
    )
    dependencies.write('provider_calls=0')
    dependencies.write('candidate_persisted_locally=true')
    dependencies.write('sealed_request_persisted=false')
    dependencies.write('transferred=false')
    dependencies.write('dispatched=false')
    dependencies.write('executed=false')
    return
  }

  const candidatePath = await exactRegularFile(args['--candidate'], MAX_JSON_BYTES)
  const gatePath = await exactRegularFile(args['--gate'], MAX_JSON_BYTES)
  const privateKeyPath = await exactRegularFile(args['--private-key'], MAX_KEY_BYTES)
  if (privateKeyPath === publicKeyPath) closed()
  const candidate = (await readJson(candidatePath)) as A0BatchSigningCandidate
  const gate = (await readJson(gatePath)) as A0BatchSigningGate
  if (
    candidate.candidate_sha256 !== prepared.candidate.candidate_sha256 ||
    hashA0Canonical(candidate) !== hashA0Canonical(prepared.candidate)
  )
    closed()
  const privateKey = await readFile(privateKeyPath, 'utf8')
  const signed = signAuthorizedA0Batch(
    candidate,
    gate,
    privateKey,
    publicKey,
    dependencies.now(),
  )
  const outputDirectory = await exactAbsentOutputDirectory(args['--output-dir'])
  const requestSha256 = await writeSealedRequest({
    outputDirectory,
    bundle,
    snapshot: prepared.snapshot,
    authorization: signed.authorization,
    publicKey: Buffer.from(publicKey, 'utf8'),
    artifacts: prepared.sealed_artifacts,
  })
  dependencies.write('a0_batch_request=sealed_offline')
  dependencies.write(`request_sha256=${requestSha256}`)
  dependencies.write(`authorization_sha256=${signed.authorization_sha256}`)
  dependencies.write('request_files=124')
  dependencies.write('provider_calls=0')
  dependencies.write('persisted_locally=true')
  dependencies.write('transferred=false')
  dependencies.write('dispatched=false')
  dependencies.write('executed=false')
  dependencies.write('authorization_scope=exact_single_batch_execution')
  dependencies.write('execution_attempts_authorized=1')
  dependencies.write('no_retry_on_uncertainty=true')
  dependencies.write('next_required_control=preflight_and_single_use_consumption')
}

async function readArtifacts(
  fixturesRoot: string,
  profilesRoot: string,
): Promise<{
  fixtureArtifacts: A0ArtifactMaterial[]
  profileArtifacts: A0ArtifactMaterial[]
}> {
  const fixtureArtifacts: A0ArtifactMaterial[] = []
  for (const testCase of TEST_CASES)
    for (const agentId of A0_BEHAVIOR_PROFILES) {
      const path = `${agentId}/${testCase}.json`
      fixtureArtifacts.push({
        path,
        bytes: await exactChildFile(fixturesRoot, path, 131_072),
      })
    }
  const profileArtifacts: A0ArtifactMaterial[] = []
  for (const agentId of A0_BEHAVIOR_PROFILES)
    for (const file of PROFILE_FILES) {
      const path = `profiles/${agentId}/${file}`
      profileArtifacts.push({
        path,
        bytes: await exactChildFile(
          profilesRoot,
          `${agentId}/${file}`,
          262_144,
        ),
      })
    }
  return { fixtureArtifacts, profileArtifacts }
}

async function writeSealedRequest(input: {
  outputDirectory: string
  bundle: unknown
  snapshot: unknown
  authorization: unknown
  publicKey: Buffer
  artifacts: ReadonlyArray<{
    file_name: string
    bytes: Uint8Array
  }>
}): Promise<string> {
  const parent = await realpath(dirname(input.outputDirectory))
  const temp = resolve(parent, `.${basename(input.outputDirectory)}.${randomUUID()}.tmp`)
  const files = new Map<string, Uint8Array>([
    ['plan-bundle.json', jsonBytes(input.bundle)],
    ['artifact-snapshot.json', jsonBytes(input.snapshot)],
    ['batch-authorization.json', jsonBytes(input.authorization)],
    ['authority-public-key.pem', input.publicKey],
  ])
  for (const artifact of input.artifacts) {
    if (files.has(artifact.file_name)) closed()
    files.set(artifact.file_name, artifact.bytes)
  }
  if (files.size !== 124) closed()
  const total = [...files.values()].reduce(
    (sum, value) => sum + value.byteLength,
    0,
  )
  if (total > MAX_TOTAL_BYTES) closed()

  try {
    await mkdir(temp, { mode: 0o700 })
    await chmod(temp, 0o700)
    for (const [name, bytes] of [...files].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!/^[A-Za-z0-9._-]{1,240}$/.test(name)) closed()
      await writeExclusiveFile(resolve(temp, name), bytes, 0o600)
    }
    await rename(temp, input.outputDirectory)
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  const index = [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bytes]) => ({ name, bytes: bytes.byteLength, sha256: digest(bytes) }))
  return hashA0Canonical(index)
}

async function writeAtomicFile(
  path: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  const parent = await realpath(dirname(path))
  const temp = resolve(parent, `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeExclusiveFile(temp, bytes, mode)
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

async function writeExclusiveFile(
  path: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'wx', mode)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(path, mode)
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function parseArgs(
  argv: string[],
  expected: ReadonlySet<string>,
): Record<string, string> {
  if (argv.length !== expected.size * 2) closed()
  const result: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      !flag ||
      !expected.has(flag) ||
      Object.prototype.hasOwnProperty.call(result, flag) ||
      !value ||
      value.startsWith('--')
    )
      closed()
    result[flag] = value
  }
  return result
}

async function exactDirectory(path: string): Promise<string> {
  const requested = resolve(path)
  const state = await lstat(requested)
  if (!state.isDirectory() || state.isSymbolicLink()) closed()
  const actual = await realpath(requested)
  if (actual !== requested) closed()
  return actual
}

async function exactRegularFile(path: string, maximum: number): Promise<string> {
  const requested = resolve(path)
  const state = await lstat(requested)
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.size < 1 ||
    state.size > maximum
  )
    closed()
  const actual = await realpath(requested)
  if (actual !== requested) closed()
  return actual
}

async function exactChildFile(
  root: string,
  relative: string,
  maximum: number,
): Promise<Buffer> {
  const requested = resolve(root, ...relative.split('/'))
  if (!requested.startsWith(`${root}${sep}`)) closed()
  const actual = await exactRegularFile(requested, maximum)
  if (!actual.startsWith(`${root}${sep}`)) closed()
  return readFile(actual)
}

async function exactAbsentOutputFile(path: string): Promise<string> {
  const output = resolve(path)
  const parent = await exactDirectory(dirname(output))
  if (resolve(parent, basename(output)) !== output) closed()
  await requireAbsent(output)
  return output
}

async function exactAbsentOutputDirectory(path: string): Promise<string> {
  const output = resolve(path)
  const parent = await exactDirectory(dirname(output))
  if (resolve(parent, basename(output)) !== output) closed()
  await requireAbsent(output)
  return output
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path)
    closed()
  } catch (error) {
    if (error instanceof A0BatchSealingError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') closed()
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    closed()
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function closed(): never {
  throw new A0BatchSealingError()
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runA0BatchSealerCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof A0BatchSealingError ? error.message : 'A0_BATCH_SEALER_FAILED'}\n`,
    )
    process.exitCode = 1
  })
}
