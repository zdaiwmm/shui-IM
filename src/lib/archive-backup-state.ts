import { uiLiteral, uiTemplate } from './language';
import { ApiError } from './api';
import { withVaultMutation, readPrivateCatalogMeta, type VaultSession } from './vault';
import { readRoomArchiveCounts, type ArchiveCounts } from './room-archive';
export type BackupOutcome={kind:'complete'|'partial'|'paused';reason?:string};
export type BackupRunFacts={running:boolean;error:string;outcome?:BackupOutcome};
export class ArchiveBackupController {
  private pending:Promise<BackupOutcome>|null=null;
  private automatic:AbortController|null=null;
  private blocked=false;
  private facts:BackupRunFacts={running:false,error:''};
  constructor(readonly session:VaultSession,readonly signal:AbortSignal,private readonly active:()=>boolean,
    private readonly operation:(signal:AbortSignal)=>Promise<BackupOutcome>,private readonly changed:()=>void){signal.addEventListener('abort',()=>this.automatic?.abort(),{once:true});}
  get snapshot():Readonly<BackupRunFacts>{return {...this.facts};}
  pauseAutomatic():void{if(this.automatic){this.automatic.abort();this.facts={running:false,error:'',outcome:{kind:'paused',reason:uiLiteral('自动备份已暂停')}};}this.changed();}
  run(force=false):Promise<BackupOutcome>{
    if(!this.active()||this.signal.aborted)return Promise.resolve({kind:'paused',reason:uiLiteral('会话已锁定')});
    if(!force&&this.blocked)return Promise.resolve({kind:'paused',reason:uiLiteral('备份写入权限或容量需重新核对')});
    if(!force&&this.session.vault.roomArchiveV2?.automaticBackup===false)return Promise.resolve({kind:'paused',reason:uiLiteral('自动备份已关闭')});
    if(this.pending)return force?this.pending.then(()=>this.run(true)):this.automatic?.signal.aborted?this.pending.then(()=>this.run(false)):this.pending;
    this.automatic=force?null:new AbortController();
    const signal=this.automatic?AbortSignal.any([this.signal,this.automatic.signal]):this.signal;
    this.facts={running:true,error:''};
    this.blocked=false;
    const run=Promise.resolve().then(()=>this.active()&&!signal.aborted?this.operation(signal):Promise.resolve({kind:'paused' as const,reason:uiLiteral('会话已锁定')})).then(outcome=>{if(this.active()&&!this.signal.aborted)this.facts={running:false,error:'',outcome};return outcome;}).catch((cause:unknown)=>{
      if(cause instanceof ApiError&&[401,403,404,410,413,507].includes(cause.status))this.blocked=true;
      if(this.active()&&!this.signal.aborted)this.facts={running:false,error:signal.aborted?'':cause instanceof Error?cause.message:uiLiteral('自动备份暂未完成'),outcome:{kind:'paused',reason:signal.aborted?uiLiteral('自动备份已暂停'):uiLiteral('备份未完成')}};
      return {kind:'paused',reason:signal.aborted?uiLiteral('备份已暂停'):uiLiteral('备份未完成')} as BackupOutcome;
    }).finally(()=>{this.facts={...this.facts,running:false};if(this.pending===run){this.pending=null;this.automatic=null;}if(this.active()&&!this.signal.aborted)this.changed();});
    this.pending=run;this.changed();return run;
  }
}
export type ArchiveBackupSnapshot={coverage:'complete'|'partial'|'unknown';enabled:boolean;credential:'verified'|'unverified'|'rotating';running:boolean;error:string;available:boolean;confirmedAt?:string;counts:ArchiveCounts|null;status:string};
export async function readArchiveBackupSnapshot(session:VaultSession,signal:AbortSignal,facts:Readonly<BackupRunFacts>):Promise<ArchiveBackupSnapshot>{
  const archive=session.vault.roomArchiveV2!;
  const meta=await readPrivateCatalogMeta(session,signal);
  const countRevision=session.vault.archiveState?.revision;
  let counts:ArchiveCounts|null=null;try{counts=await readRoomArchiveCounts(session,signal);}catch{signal.throwIfAborted();}
  await withVaultMutation(session,async()=>{signal.throwIfAborted();});
  const state=session.vault.archiveState,complete=state?.lastComplete;
  if(state?.revision!==countRevision||(await readPrivateCatalogMeta(session,signal)).revision!==meta.revision)counts=null;
  const valid=!!complete&&complete.archiveId===archive.key.descriptor.id&&complete.scope===(session.vault.localDataScope??session.vault.roomId)&&complete.privateRevision===meta.revision&&complete.sharedThrough===session.vault.lastSeq&&state!.cursor>=complete.sharedThrough&&complete.revision<=state!.revision&&!state!.preparing&&!state!.pending;
  const coverage=valid&&counts?'complete':counts?'partial':'unknown';
  const available=!!state?.head&&!!state.revision;
  const enabled=archive.automaticBackup!==false;
  let status=coverage==='complete'?(state?.revision===0?uiLiteral('当前没有需要备份的记录'):uiLiteral('当前本机记录及原文件已全部备份')):coverage==='unknown'?uiLiteral('最新备份范围尚未确认'):uiLiteral('部分内容尚未备份');
  if(facts.running)status+=uiLiteral('；正在加密并备份');
  else if(facts.error)status+=`；${facts.error}`;
  else if(facts.outcome?.kind==='paused'&&facts.outcome.reason)status+=`；${facts.outcome.reason}`;
  if(!enabled)status+=uiLiteral('；自动备份已关闭');
  if(archive.rotation)status+=uiLiteral('；凭证更新待完成');
  if(typeof navigator!=='undefined'&&navigator.onLine===false)status+=uiLiteral('；当前离线');
  if(available)status+=uiTemplate`。已有已确认的加密备份${state?.syncedAt?`（${new Date(state.syncedAt).toLocaleString()}）`:''}`;
  else status+=uiLiteral('。尚无已确认的记录批次');
  status+=archive.rotation?uiLiteral('。新恢复凭证尚未完成'):archive.cardVerified?uiLiteral('。恢复凭证已回验'):uiLiteral('。恢复凭证尚未回验');
  signal.throwIfAborted();
  return {coverage,enabled,credential:archive.rotation?'rotating':archive.cardVerified?'verified':'unverified',running:facts.running,error:facts.error,available,confirmedAt:state?.syncedAt,counts,status};
}
