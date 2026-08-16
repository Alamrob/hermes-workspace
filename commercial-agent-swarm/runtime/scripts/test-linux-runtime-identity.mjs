import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, chown, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readGroupSecretFile } from '../dist/secret-file.js'
import { PosixSocketSecurity } from '../dist/socket-security.js'

if (
  process.platform !== 'linux' ||
  (process.argv[2] !== '--child' && process.getuid?.() !== 0)
)
  throw new Error('ROOT_LINUX_TEST_RUNNER_REQUIRED')

if (process.argv[2] === '--child') {
  const secret = await readGroupSecretFile(process.argv[3], 10000)
  const directory = process.argv[4]
  const socket = join(directory, 'executor.sock')
  const security = new PosixSocketSecurity(directory, 19000, 10000, 10000)
  await security.beforeListen(socket)
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve))
  try {
    await security.afterListen(socket)
    const metadata = await lstat(socket)
    assert.equal(metadata.uid, 10000)
    assert.equal(metadata.gid, 19000)
    assert.equal(metadata.mode & 0o777, 0o660)
    process.stdout.write(secret)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  process.exit(0)
}

const root = await mkdtemp(join(tmpdir(), 'runtime-identity-'))
const secret = join(root, 'secret')
const directory = join(root, 'ipc')
const script = fileURLToPath(import.meta.url)
const runChild = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, '--child', secret, directory], {
    uid: 10000,
    gid: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  child.once('error', reject)
  child.once('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))
})

try {
  await chmod(root, 0o755)
  await writeFile(secret, 'fixture-only\n', { mode: 0o440 })
  await chown(secret, 0, 10000)
  await mkdir(directory, { mode: 0o700 })
  await chown(directory, 10000, 19000)
  await chmod(directory, 0o2770)
  const valid = await runChild()
  assert.equal(valid.code, 0, valid.stderr)
  assert.equal(valid.stdout, 'fixture-only')

  await chmod(secret, 0o444)
  assert.notEqual((await runChild()).code, 0)
  process.stdout.write('linux-runtime-identity: ok\n')
} finally {
  await rm(root, { recursive: true, force: true })
}
