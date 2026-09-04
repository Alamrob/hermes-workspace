import {Socket} from 'node:net'
import {randomUUID} from 'node:crypto'
import type {ExecutionLeaseGrant,LeaseBinding} from './execution-lease.js'

export interface ExecutorGuardianPort {
  challenge(binding:LeaseBinding):Promise<string>
  begin(binding:LeaseBinding,grant:ExecutionLeaseGrant):Promise<void>
  renew(binding:LeaseBinding,grant:ExecutionLeaseGrant):Promise<void>
  finish(binding:LeaseBinding):Promise<void>
  close():void
}
// The inherited socketpair belongs to trusted PID1/Node, not to Hermes/model.
// No filesystem socket, credentials, database, HTTP or Docker capability.
export class ExecutorGuardianClient implements ExecutorGuardianPort {
  private pending=new Map<string,{op:string;resolve:(v:Record<string,unknown>)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>;deadline:number}>()
  private input=Buffer.alloc(0)
  private dead=false
  private heartbeat:ReturnType<typeof setInterval>
  private heartbeatBusy=false
  private sequence=0
  constructor(private readonly socket:Socket){
    socket.on('error',()=>this.close());socket.on('end',()=>this.close());socket.on('close',()=>this.close())
    socket.on('data',(data:Buffer)=>this.read(data))
    this.heartbeat=setInterval(()=>{
      if(this.heartbeatBusy||this.dead)return
      this.heartbeatBusy=true
      void this.call('heartbeat').finally(()=>{this.heartbeatBusy=false}).catch(()=>this.close())
    },250)
  }
  static fromInheritedDescriptor(value:string|undefined):ExecutorGuardianClient{
    if(process.platform!=='linux'||process.ppid!==1||!value||!/^[0-9]{1,2}$/.test(value)||Number(value)<3||Number(value)>32)throw Error('EXECUTOR_GUARDIAN_REQUIRED')
    return new ExecutorGuardianClient(new Socket({fd:Number(value),readable:true,writable:true}))
  }
  async challenge(binding:LeaseBinding):Promise<string>{return (await this.call('challenge',{binding})).challenge_id as string}
  async begin(binding:LeaseBinding,grant:ExecutionLeaseGrant):Promise<void>{await this.call('begin',{binding,grant})}
  async renew(binding:LeaseBinding,grant:ExecutionLeaseGrant):Promise<void>{await this.call('renew',{binding,grant})}
  async finish(binding:LeaseBinding):Promise<void>{await this.call('finish',{binding})}
  close():void{
    if(this.dead)return
    this.dead=true;clearInterval(this.heartbeat);this.socket.destroy()
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('EXECUTOR_GUARDIAN_UNAVAILABLE'))}
    this.pending.clear()
  }
  private call(op:string,data:Record<string,unknown>={}):Promise<Record<string,unknown>>{
    if(this.dead||this.pending.size>=64||this.sequence>=Number.MAX_SAFE_INTEGER)return Promise.reject(Error('EXECUTOR_GUARDIAN_UNAVAILABLE'))
    const id=randomUUID(),bytes=Buffer.from(JSON.stringify({id,seq:++this.sequence,op,...data})+'\n')
    if(bytes.length>8192)return Promise.reject(Error('EXECUTOR_GUARDIAN_FRAME'))
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.close(),750)
      this.pending.set(id,{op,resolve,reject,timer,deadline:performance.now()+750})
      try{this.socket.write(bytes,error=>{if(error)this.close()})}catch{this.close()}
    })
  }
  private read(chunk:Buffer):void{
    if(this.dead)return
    this.input=Buffer.concat([this.input,chunk]);if(this.input.length>16384){this.close();return}
    try{
      for(let end=this.input.indexOf(10);end>=0;end=this.input.indexOf(10)){
        const v=JSON.parse(this.input.subarray(0,end).toString('utf8')) as Record<string,unknown>;this.input=this.input.subarray(end+1)
        const p=typeof v?.id==='string'?this.pending.get(v.id):undefined
        if(!p||performance.now()>=p.deadline||v.ok!==true||Object.keys(v).sort().join(',')!==(p.op==='challenge'?'challenge_id,id,ok':'id,ok'))throw Error()
        if(p.op==='challenge'&&(typeof v.challenge_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v.challenge_id)))throw Error()
        clearTimeout(p.timer);this.pending.delete(v.id as string);p.resolve(v)
      }
    }catch{this.close()}
  }
}
