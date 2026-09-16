import { chmod, lstat, realpath, unlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface SocketSecurityPort { beforeListen(socketPath:string):Promise<void>; afterListen(socketPath:string):Promise<void> }

interface SocketMetadata {
  dev:number
  gid:number
  ino:number
  mode:number
  nlink:number
  uid:number
  isDirectory():boolean
  isSocket():boolean
  isSymbolicLink():boolean
}

interface PosixSocketSecurityDependencies {
  chmod(path:string,mode:number):Promise<void>
  getgid():number|undefined
  getgroups():number[]
  getuid():number|undefined
  lstat(path:string):Promise<SocketMetadata>
  platform:NodeJS.Platform
  probe(path:string):Promise<'active'|'missing'|'stale'>
  realpath(path:string):Promise<string>
  unlink(path:string):Promise<void>
}

const defaults:PosixSocketSecurityDependencies={
  chmod,
  getgid:()=>process.getgid?.(),
  getgroups:()=>process.getgroups?.()??[],
  getuid:()=>process.getuid?.(),
  lstat,
  platform:process.platform,
  probe:probeUnixSocket,
  realpath,
  unlink,
}

export class PosixSocketSecurity implements SocketSecurityPort {
  private readonly dependencies:PosixSocketSecurityDependencies
  constructor(private readonly directory:string,private readonly ipcGid:number,private readonly executorUid=10000,private readonly executorGid=10000,dependencies:Partial<PosixSocketSecurityDependencies>={}) {
    this.dependencies={...defaults,...dependencies}
  }
  async beforeListen(socketPath:string):Promise<void>{
    const io=this.dependencies
    if(io.platform==='win32')throw new Error('POSIX_SOCKET_REQUIRED')
    if(!isAbsolute(this.directory)||dirname(socketPath)!==this.directory)throw new Error('UNSAFE_EXECUTOR_SOCKET_PATH')
    if(io.getuid()!==this.executorUid||io.getgid()!==this.executorGid)throw new Error('EXECUTOR_EFFECTIVE_IDENTITY_INVALID')
    if(io.getgroups().includes(this.ipcGid))throw new Error('EXECUTOR_IPC_GROUP_MEMBERSHIP_FORBIDDEN')
    const metadata=await io.lstat(this.directory);if(metadata.isSymbolicLink()||!metadata.isDirectory()||metadata.uid!==this.executorUid||metadata.gid!==this.ipcGid||(metadata.mode&0o7777)!==0o2770||resolve(await io.realpath(this.directory))!==resolve(this.directory))throw new Error('UNSAFE_EXECUTOR_SOCKET_DIRECTORY')
    await this.removeVerifiedStaleSocket(socketPath)
  }
  async afterListen(socketPath:string):Promise<void>{
    const io=this.dependencies
    await io.chmod(socketPath,0o660);const metadata=await io.lstat(socketPath);if(!metadata.isSocket()||metadata.uid!==this.executorUid||metadata.gid!==this.ipcGid||(metadata.mode&0o777)!==0o660)throw new Error('UNSAFE_EXECUTOR_SOCKET_ACL')
  }
  private async removeVerifiedStaleSocket(socketPath:string):Promise<void>{
    const io=this.dependencies
    let first:SocketMetadata
    try{first=await io.lstat(socketPath)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    assertSocketMetadata(first,this.executorUid,this.ipcGid)
    const state=await io.probe(socketPath)
    if(state==='active')throw new Error('EXECUTOR_SOCKET_ACTIVE')
    if(state==='missing')return
    let second:SocketMetadata
    try{second=await io.lstat(socketPath)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    assertSocketMetadata(second,this.executorUid,this.ipcGid)
    if(first.dev!==second.dev||first.ino!==second.ino)throw new Error('EXECUTOR_SOCKET_CHANGED')
    await io.unlink(socketPath)
  }
}

function assertSocketMetadata(metadata:SocketMetadata,uid:number,gid:number):void{
  if(!metadata.isSocket()||metadata.isSymbolicLink()||metadata.uid!==uid||metadata.gid!==gid||
    metadata.nlink!==1||(metadata.mode&0o777)!==0o660)throw new Error('UNSAFE_EXECUTOR_STALE_SOCKET')
}

function probeUnixSocket(path:string):Promise<'active'|'missing'|'stale'>{
  return new Promise((resolveProbe,reject)=>{
    const socket=createConnection({path})
    let settled=false
    const finish=(result:'active'|'missing'|'stale'|Error)=>{
      if(settled)return
      settled=true;socket.destroy()
      if(result instanceof Error)reject(result);else resolveProbe(result)
    }
    socket.setTimeout(250,()=>finish(new Error('EXECUTOR_SOCKET_PROBE_TIMEOUT')))
    socket.once('connect',()=>finish('active'))
    socket.once('error',(error:NodeJS.ErrnoException)=>{
      if(error.code==='ECONNREFUSED')finish('stale')
      else if(error.code==='ENOENT')finish('missing')
      else finish(new Error(`EXECUTOR_SOCKET_PROBE_FAILED:${error.code??'UNKNOWN'}`))
    })
  })
}
