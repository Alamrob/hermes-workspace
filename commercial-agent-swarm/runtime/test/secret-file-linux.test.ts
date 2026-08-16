import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, chown, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const rootLinux = process.platform === 'linux' && process.getuid?.() === 0

async function readAsExecutor(path: string): Promise<{ code: number; output: string }> {
  const expression = `import('./src/secret-file.ts').then(async ({readGroupSecretFile})=>process.stdout.write(await readGroupSecretFile(${JSON.stringify(path)},10000))).catch(()=>process.exit(73))`
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', expression], {
      cwd: process.cwd(),
      uid: 10000,
      gid: 10000,
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', reject)
    child.once('close', (code) =>
      resolve({ code: code ?? -1, output: Buffer.concat(chunks).toString('utf8') }),
    )
  })
}

describe('Linux dedicated-group secret contract', () => {
  it('lets uid/gid 10000 read only root:10000 0440 without following symlinks', { skip: !rootLinux }, async () => {
    const root = join(tmpdir(), `group-secret-${crypto.randomUUID()}`)
    const secret = join(root, 'secret')
    const link = join(root, 'link')
    await mkdir(root, { mode: 0o755 })
    try {
      await writeFile(secret, 'not-a-real-secret\n', { mode: 0o440 })
      await chown(secret, 0, 10000)
      assert.deepEqual(await readAsExecutor(secret), { code: 0, output: 'not-a-real-secret' })

      await chmod(secret, 0o444)
      assert.notEqual((await readAsExecutor(secret)).code, 0)
      await chmod(secret, 0o440)
      await chown(secret, 10000, 10000)
      assert.notEqual((await readAsExecutor(secret)).code, 0)
      await chown(secret, 0, 10001)
      assert.notEqual((await readAsExecutor(secret)).code, 0)
      await chown(secret, 0, 10000)
      await symlink(secret, link)
      assert.notEqual((await readAsExecutor(link)).code, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
