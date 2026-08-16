import assert from 'node:assert/strict'
import { chmod, chown, lstat, mkdir, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { PosixSocketSecurity } from '../src/socket-security.js'

const rootLinux = process.platform !== 'win32' && process.getuid?.() === 0

describe('POSIX executor socket security', () => {
  it('uses a pre-created owner:IPC setgid directory and produces an inherited-group 0660 socket without chown',{skip:!rootLinux},async()=>{const root=join(tmpdir(),`executor-socket-${crypto.randomUUID()}`),directory=join(root,'run'),socket=join(directory,'executor.sock');await mkdir(directory,{recursive:true});await chown(directory,0,19000);await chmod(directory,0o2770);const security=new PosixSocketSecurity(directory,19000,0,0);try{await security.beforeListen(socket);const server=createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(socket,resolve));try{await security.afterListen(socket);const metadata=await lstat(socket);assert.equal(metadata.isSocket(),true);assert.equal(metadata.uid,0);assert.equal(metadata.gid,19000);assert.equal(metadata.mode&0o777,0o660)}finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}}finally{await rm(root,{recursive:true,force:true})}})

  it('rejects traversal, symlinks, broad modes, missing setgid, and wrong effective identity',{skip:!rootLinux},async()=>{const root=join(tmpdir(),`executor-socket-bad-${crypto.randomUUID()}`),directory=join(root,'run'),link=join(root,'link');await mkdir(directory,{recursive:true,mode:0o777});await chown(directory,0,19000);await chmod(directory,0o2770);await symlink(directory,link,'dir');try{await assert.rejects(new PosixSocketSecurity(directory,19000,0,0).beforeListen(join(directory,'../executor.sock')),/UNSAFE_EXECUTOR_SOCKET_PATH/);await assert.rejects(new PosixSocketSecurity(link,19000,0,0).beforeListen(join(link,'executor.sock')),/UNSAFE_EXECUTOR_SOCKET_DIRECTORY/);await assert.rejects(new PosixSocketSecurity(directory,19000,10000,10000).beforeListen(join(directory,'executor.sock')),/EXECUTOR_EFFECTIVE_IDENTITY_INVALID/);await chmod(directory,0o770);await assert.rejects(new PosixSocketSecurity(directory,19000,0,0).beforeListen(join(directory,'executor.sock')),/UNSAFE_EXECUTOR_SOCKET_DIRECTORY/)}finally{await rm(root,{recursive:true,force:true})}})
})
