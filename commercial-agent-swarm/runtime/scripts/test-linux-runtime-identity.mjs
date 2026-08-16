import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { NodeProcessRunner, PosixHomeOwnershipPreparer } from '../dist/hermes-executor.js'
import { readGroupSecretFile } from '../dist/secret-file.js'
import { PosixSocketSecurity } from '../dist/socket-security.js'
import { assertExecutorSupervisorSecurity } from '../dist/supervisor-security.js'

if (process.platform !== 'linux') throw new Error('LINUX_TEST_RUNNER_REQUIRED')
assertExecutorSupervisorSecurity({
  pid: process.pid,
  uid: process.getuid?.(),
  gid: process.getgid?.(),
  status: await readFile('/proc/self/status', 'utf8'),
})

const root = '/tmp/runtime-identity'
const secret = join(root, 'secret')
const seed = join(root, 'seed')
const directory = join(root, 'ipc')
const cwd = join(root, 'cwd')
const temporaryRoot = join(root, 'temporary')
const socket = join(directory, 'executor.sock')
assert.equal(await readGroupSecretFile(secret, 10000), 'fixture-only')

const ephemeral = join(temporaryRoot, 'hermes-home-fixture')
await mkdir(ephemeral)
await writeFile(join(ephemeral, 'profile'), 'fixture')
const ownership = new PosixHomeOwnershipPreparer(temporaryRoot, 10000, 10000)
await ownership.prepare(ephemeral, 10002, 10002)
assert.equal((await lstat(ephemeral)).uid, 10002)
assert.equal((await lstat(ephemeral)).gid, 10000)
assert.equal((await lstat(join(ephemeral, 'profile'))).uid, 10002)
await ownership.reclaim(ephemeral, 10000, 10000)
await rm(ephemeral, { recursive: true })

const security = new PosixSocketSecurity(directory, 11000, 10000, 10000)
await security.beforeListen(socket)
const server = createServer()
await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve))
try {
  await security.afterListen(socket)
  const metadata = await lstat(socket)
  assert.equal(metadata.uid, 10000)
  assert.equal(metadata.gid, 11000)
  assert.equal(metadata.mode & 0o777, 0o660)

  const code = `const fs=require('fs'),net=require('net');const denied=(fn)=>{try{fn();return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'}};(async()=>{const connectDenied=await new Promise(r=>{const s=net.createConnection(${JSON.stringify(socket)});s.once('connect',()=>{s.destroy();r(false)});s.once('error',e=>r(e.code==='EACCES'||e.code==='EPERM'))});const status=fs.readFileSync('/proc/self/status','utf8'),names=['CapInh','CapPrm','CapEff','CapBnd','CapAmb'],lines=status.split('\\n');process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),secretDenied:denied(()=>fs.readFileSync(${JSON.stringify(secret)})),seedWriteDenied:denied(()=>fs.writeFileSync(${JSON.stringify(seed)},'x')),connectDenied,unlinkDenied:denied(()=>fs.unlinkSync(${JSON.stringify(socket)})),capValues:Object.fromEntries(names.map(n=>[n,lines.find(line=>line.startsWith(n+':'))?.split(':')[1].trim()])),nnp:/NoNewPrivs:\\s+1\\n/.test(status)}))})()`
  const output = await new NodeProcessRunner().run({
    command: process.execPath,
    args: ['-e', code],
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    uid: 10002,
    gid: 10002,
    shell: false,
    detached: true,
    cwd,
    timeoutMs: 5_000,
    stdoutLimitBytes: 4_096,
    stderrLimitBytes: 4_096,
  })
  assert.equal(output.exitCode, 0, output.stderr)
  assert.deepEqual(JSON.parse(output.stdout), {
    uid: 10002,
    gid: 10002,
    groups: [10002],
    secretDenied: true,
    seedWriteDenied: true,
    connectDenied: true,
    unlinkDenied: true,
    capValues: {
      CapInh: '0000000000000000',
      CapPrm: '0000000000000000',
      CapEff: '0000000000000000',
      CapBnd: '0000000000000000',
      CapAmb: '0000000000000000',
    },
    nnp: true,
  })
  process.stdout.write('linux-runtime-identity: ok\n')
} finally {
  await new Promise((resolve) => server.close(resolve))
}
