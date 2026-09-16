import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PosixSocketSecurity } from '../src/socket-security.js'

function metadata(type:'directory'|'socket',overrides:Record<string,unknown>={}){
  return {
    dev:1,gid:11000,ino:type==='directory'?10:20,
    mode:type==='directory'?0o42770:0o140660,nlink:1,uid:10000,
    isDirectory:()=>type==='directory',isSocket:()=>type==='socket',isSymbolicLink:()=>false,
    ...overrides,
  }
}

function fixture(socketStates:Array<ReturnType<typeof metadata>|NodeJS.ErrnoException>,probe:'active'|'missing'|'stale'){
  const unlinked:string[]=[]
  const dependencies={
    chmod:async()=>undefined,getgid:()=>10000,getgroups:()=>[],getuid:()=>10000,
    platform:'linux' as const,probe:async()=>probe,realpath:async(path:string)=>path,
    unlink:async(path:string)=>{unlinked.push(path)},
    lstat:async(path:string)=>{
      if(path==='/run/commercial-swarm')return metadata('directory')
      const next=socketStates.shift()
      if(next instanceof Error)throw next
      if(!next)throw Object.assign(new Error('missing'),{code:'ENOENT'})
      return next
    },
  }
  return {security:new PosixSocketSecurity('/run/commercial-swarm',11000,10000,10000,dependencies),unlinked}
}

describe('stale executor socket recovery',()=>{
  const path='/run/commercial-swarm/executor.sock'
  it('removes only a stable, refused, exact-ACL socket',async()=>{
    const value=metadata('socket'),test=fixture([value,{...value}], 'stale')
    await test.security.beforeListen(path)
    assert.deepEqual(test.unlinked,[path])
  })
  it('never removes a socket with an active listener',async()=>{
    const test=fixture([metadata('socket')],'active')
    await assert.rejects(test.security.beforeListen(path),/EXECUTOR_SOCKET_ACTIVE/)
    assert.deepEqual(test.unlinked,[])
  })
  it('never removes unsafe or replaced filesystem objects',async()=>{
    for(const values of [
      [metadata('socket',{uid:0})],
      [metadata('socket'),metadata('socket',{ino:21})],
      [metadata('directory')],
    ]){
      const test=fixture(values,'stale')
      await assert.rejects(test.security.beforeListen(path),/UNSAFE_EXECUTOR_STALE_SOCKET|EXECUTOR_SOCKET_CHANGED/)
      assert.deepEqual(test.unlinked,[])
    }
  })
  it('accepts an absent socket without attempting cleanup',async()=>{
    const missing=Object.assign(new Error('missing'),{code:'ENOENT'})
    const test=fixture([missing],'missing')
    await test.security.beforeListen(path)
    assert.deepEqual(test.unlinked,[])
  })
})
