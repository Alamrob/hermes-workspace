import { chmod, lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface SocketSecurityPort { beforeListen(socketPath:string):Promise<void>; afterListen(socketPath:string):Promise<void> }

export class PosixSocketSecurity implements SocketSecurityPort {
  constructor(private readonly directory:string,private readonly ipcGid:number,private readonly executorUid=10000,private readonly executorGid=10000) {}
  async beforeListen(socketPath:string):Promise<void>{
    if(process.platform==='win32')throw new Error('POSIX_SOCKET_REQUIRED')
    if(!isAbsolute(this.directory)||dirname(socketPath)!==this.directory)throw new Error('UNSAFE_EXECUTOR_SOCKET_PATH')
    if(process.getuid?.()!==this.executorUid||process.getgid?.()!==this.executorGid)throw new Error('EXECUTOR_EFFECTIVE_IDENTITY_INVALID')
    if((process.getgroups?.()??[]).includes(this.ipcGid))throw new Error('EXECUTOR_IPC_GROUP_MEMBERSHIP_FORBIDDEN')
    const metadata=await lstat(this.directory);if(metadata.isSymbolicLink()||!metadata.isDirectory()||metadata.uid!==this.executorUid||metadata.gid!==this.ipcGid||(metadata.mode&0o7777)!==0o2770||resolve(await realpath(this.directory))!==resolve(this.directory))throw new Error('UNSAFE_EXECUTOR_SOCKET_DIRECTORY')
  }
  async afterListen(socketPath:string):Promise<void>{
    await chmod(socketPath,0o660);const metadata=await lstat(socketPath);if(!metadata.isSocket()||metadata.uid!==this.executorUid||metadata.gid!==this.ipcGid||(metadata.mode&0o777)!==0o660)throw new Error('UNSAFE_EXECUTOR_SOCKET_ACL')
  }
}
