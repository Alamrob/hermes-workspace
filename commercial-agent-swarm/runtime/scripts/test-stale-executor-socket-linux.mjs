import assert from 'node:assert/strict'
import { chmod, chown, lstat, mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { PosixSocketSecurity } from '../dist/socket-security.js'

if(process.platform!=='linux'||process.getuid?.()!==0||process.argv.length!==2)
  throw new Error('ROOT_LINUX_REQUIRED')

const directory='/run/stale-executor-socket-test'
const socketPath=`${directory}/executor.sock`
await mkdir(directory,{mode:0o2770})
await chmod(directory,0o2770)
await chown(directory,10000,11000)

const child=spawn(process.execPath,['-e',
  `const fs=require('node:fs'),s=require('node:net').createServer();s.listen(${JSON.stringify(socketPath)},()=>{fs.chmodSync(${JSON.stringify(socketPath)},0o660);process.stdout.write('READY\\n')})`],{
  gid:10000,uid:10000,stdio:['ignore','pipe','inherit'],
})
await new Promise((resolve,reject)=>{
  child.once('error',reject)
  child.stdout.once('data',(value)=>value.toString()==='READY\n'?resolve():reject(new Error('CHILD_READY_INVALID')))
})
child.kill('SIGKILL')
await new Promise(resolve=>child.once('close',resolve))
const stale=await lstat(socketPath)
assert.equal(stale.isSocket(),true)
assert.equal(stale.uid,10000)
assert.equal(stale.gid,11000)
assert.equal(stale.mode&0o777,0o660)

process.setgroups([])
process.setgid(10000)
process.setuid(10000)
const security=new PosixSocketSecurity(directory,11000,10000,10000)
await security.beforeListen(socketPath)
await assert.rejects(lstat(socketPath),{code:'ENOENT'})

const server=createServer()
await new Promise((resolve,reject)=>server.once('error',reject).listen(socketPath,resolve))
try{
  await security.afterListen(socketPath)
  const current=await lstat(socketPath)
  assert.equal(current.isSocket(),true)
  assert.equal(current.uid,10000)
  assert.equal(current.gid,11000)
  assert.equal(current.mode&0o777,0o660)
  await assert.rejects(security.beforeListen(socketPath),/EXECUTOR_SOCKET_ACTIVE/)
}finally{
  await new Promise(resolve=>server.close(resolve))
}
process.stdout.write('{"status":"stale_socket_recovered_rebound_and_active_rejected"}\n')
