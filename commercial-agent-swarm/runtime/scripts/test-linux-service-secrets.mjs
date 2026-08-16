import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, chown, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

if (process.platform !== 'linux' || process.getuid?.() !== 0)
  throw new Error('ROOT_LINUX_TEST_RUNNER_REQUIRED')

async function readAsService(path, gid, expectedGid = gid) {
  const expression = `import('./dist/secret-file.js').then(async ({readGroupSecretFile})=>process.stdout.write(await readGroupSecretFile(${JSON.stringify(path)},${expectedGid}))).catch(()=>process.exit(73))`
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--eval', expression], {
      cwd: process.cwd(), uid: gid, gid,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.once('error', reject)
    child.once('close', (code) =>
      resolve({ code: code ?? -1, output: Buffer.concat(chunks).toString('utf8') }),
    )
  })
}

const root = `/tmp/service-secrets-${crypto.randomUUID()}`
const secret = join(root, 'secret')
const link = join(root, 'link')
await mkdir(root, { mode: 0o755 })
try {
  await writeFile(secret, 'fixture-only\n', { mode: 0o440 })
  await chown(secret, 0, 10001)
  assert.deepEqual(await readAsService(secret, 10001), { code: 0, output: 'fixture-only' })
  assert.notEqual((await readAsService(secret, 10011)).code, 0)

  await chown(secret, 0, 10011)
  assert.deepEqual(await readAsService(secret, 10011), { code: 0, output: 'fixture-only' })
  assert.notEqual((await readAsService(secret, 10001)).code, 0)
  assert.notEqual((await readAsService(secret, 10011, 10001)).code, 0)

  await chmod(secret, 0o444)
  assert.notEqual((await readAsService(secret, 10011)).code, 0)
  await chmod(secret, 0o440)
  await chown(secret, 10011, 10011)
  assert.notEqual((await readAsService(secret, 10011)).code, 0)
  await chown(secret, 0, 10011)
  await symlink(secret, link)
  assert.notEqual((await readAsService(link, 10011)).code, 0)
  process.stdout.write('linux-service-secrets: ok\n')
} finally {
  await rm(root, { recursive: true, force: true })
}
