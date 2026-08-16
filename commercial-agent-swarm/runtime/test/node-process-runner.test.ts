import assert from 'node:assert/strict'
import { chmod, chown, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { NodeProcessRunner } from '../src/hermes-executor.js'
import type { ProcessInvocation } from '../src/hermes-executor.js'

const linux = process.platform !== 'win32'
async function invocation(
  code: string,
  timeoutMs = 1_000,
  stdoutLimitBytes = 1024,
): Promise<ProcessInvocation> {
  const cwd = join(tmpdir(), `runner-test-${crypto.randomUUID()}`)
  await mkdir(cwd)
  return {
    command: process.execPath,
    args: ['-e', code],
    env: { PATH: process.env.PATH ?? '' },
    uid: process.getuid?.() ?? 10000,
    gid: process.getgid?.() ?? 10000,
    shell: false,
    detached: true,
    cwd,
    timeoutMs,
    stdoutLimitBytes,
    stderrLimitBytes: 1024,
  }
}

describe('Node process runner containment', () => {
  it(
    'kills the process group and waits for close when stdout exceeds its bound',
    { skip: !linux },
    async () => {
      const call = await invocation(
        "process.stdout.write('x'.repeat(2048));setInterval(()=>{},1000)",
        1_000,
        128,
      )
      try {
        await assert.rejects(
          new NodeProcessRunner().run(call),
          /HERMES_STDOUT_LIMIT/,
        )
      } finally {
        await rm(call.cwd, { recursive: true, force: true })
      }
    },
  )
  it(
    'kills descendants on timeout and reports only after the group is gone',
    { skip: !linux },
    async () => {
      const call = await invocation(
        "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)",
        100,
        1024,
      )
      try {
        const out = await new NodeProcessRunner().run(call)
        assert.equal(out.timedOut, true)
        const pid = Number(out.stdout.trim())
        assert.equal(Number.isSafeInteger(pid), true)
        assert.throws(() => process.kill(pid, 0))
      } finally {
        await rm(call.cwd, { recursive: true, force: true })
      }
    },
  )
  it(
    'kills a surviving descendant when the process-group leader exits first',
    { skip: !linux },
    async () => {
      const call = await invocation(
        "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();process.stdout.write(String(c.pid))",
        1_000,
        1024,
      )
      try {
        const out = await new NodeProcessRunner().run(call)
        assert.equal(out.exitCode, 0)
        const pid = Number(out.stdout.trim())
        assert.equal(Number.isSafeInteger(pid), true)
        assert.throws(() => process.kill(pid, 0))
      } finally {
        await rm(call.cwd, { recursive: true, force: true })
      }
    },
  )
  it(
    'bounds stderr and propagates spawn errors only after cleanup',
    { skip: !linux },
    async () => {
      const call = await invocation(
        "process.stderr.write('x'.repeat(2048));setInterval(()=>{},1000)",
      )
      call.stderrLimitBytes = 128
      try {
        await assert.rejects(
          new NodeProcessRunner().run(call),
          /HERMES_STDERR_LIMIT/,
        )
        await assert.rejects(
          new NodeProcessRunner().run({
            ...call,
            command: '/definitely/missing/hermes',
          }),
          /ENOENT/,
        )
      } finally {
        await rm(call.cwd, { recursive: true, force: true })
      }
    },
  )
  it(
    'drops to child uid/gid 10002 with no capabilities and cannot read the supervisor secret, seed, or socket',
    { skip: !linux || process.getuid?.() !== 0 },
    async () => {
      const root = join(tmpdir(), `runner-identity-${crypto.randomUUID()}`),
        cwd = join(root, 'cwd'),
        key = join(root, 'key'),
        ipc = join(root, 'ipc'),
        socket = join(ipc, 'executor.sock'),
        seed = join(root, 'seed')
      await mkdir(cwd, { recursive: true })
      await mkdir(ipc)
      await writeFile(key, 'secret')
      await writeFile(seed, 'immutable')
      await chmod(root, 0o755)
      await chmod(cwd, 0o755)
      await chmod(key, 0o440)
      await chown(key, 0, 10000)
      await chmod(seed, 0o444)
      await chown(seed, 10000, 10000)
      await chown(ipc, 10000, 11000)
      await chmod(ipc, 0o2770)
      const server = createServer()
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socket, resolve))
      await chown(socket, 10000, 11000)
      await chmod(socket, 0o660)
      const code = `const fs=require('fs'),net=require('net');const denied=(fn)=>{try{fn();return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'}};(async()=>{const connectDenied=await new Promise(r=>{const s=net.createConnection(${JSON.stringify(socket)});s.once('connect',()=>{s.destroy();r(false)});s.once('error',e=>r(e.code==='EACCES'||e.code==='EPERM'))});const status=fs.readFileSync('/proc/self/status','utf8');process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),keyDenied:denied(()=>fs.readFileSync(${JSON.stringify(key)})),seedWriteDenied:denied(()=>fs.writeFileSync(${JSON.stringify(seed)},'x')),connectDenied,unlinkDenied:denied(()=>fs.unlinkSync(${JSON.stringify(socket)})),capEff:/CapEff:\\s+0+\\n/.test(status),capBnd:/CapBnd:\\s+0+\\n/.test(status),noNewPrivs:/NoNewPrivs:\\s+1\\n/.test(status)}))})()`
      const call: ProcessInvocation = {
        command: process.execPath,
        args: ['-e', code],
        env: { PATH: process.env.PATH ?? '' },
        uid: 10002,
        gid: 10002,
        shell: false,
        detached: true,
        cwd,
        timeoutMs: 1_000,
        stdoutLimitBytes: 1024,
        stderrLimitBytes: 1024,
      }
      try {
        const out = await new NodeProcessRunner().run(call)
        assert.equal(out.exitCode, 0)
        assert.deepEqual(JSON.parse(out.stdout), {
          uid: 10002,
          gid: 10002,
          groups: [10002],
          keyDenied: true,
          seedWriteDenied: true,
          connectDenied: true,
          unlinkDenied: true,
          capEff: true,
          capBnd: true,
          noNewPrivs: true,
        })
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
