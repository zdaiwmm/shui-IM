import { uiLiteral, t } from './language';
import {ensurePrivateCatalog,readPrivateHistoryPage,type PrivateHistoryPage} from './private-archive-catalog';
import type {VaultSession} from './vault';
/** Owns one bounded plaintext page. Page cancellation also owns decoded media/URLs. */
export class PrivateHistoryController {
  page:PrivateHistoryPage={items:[],start:0,end:0,total:0,revision:''};
  error='';loading=false;
  private pageAbort=new AbortController();
  private mediaAbort=new AbortController();
  private request=0;
  settled:Promise<void>=Promise.resolve();
  private readonly abort=()=>this.dispose();
  constructor(readonly session:VaultSession,private readonly signal:AbortSignal,private readonly active:()=>boolean,private readonly changed:()=>void){signal.addEventListener('abort',this.abort,{once:true});}
  get pageSignal():AbortSignal{return AbortSignal.any([this.signal,this.mediaAbort.signal]);}
  load(direction:'latest'|'older'|'newer'='latest',anchorId?:string):Promise<void>{
    if(this.signal.aborted||!this.active())return Promise.resolve();
    this.pageAbort.abort();this.pageAbort=new AbortController();this.pauseMedia();const signal=AbortSignal.any([this.signal,this.pageAbort.signal]),request=++this.request;
    const before=direction==='older'?this.page.start:undefined,after=direction==='newer'?this.page.end:undefined;
    this.page={...this.page,items:[]};this.error='';this.loading=true;this.changed();
    const run=(async()=>{try{
      const meta=await ensurePrivateCatalog(this.session,signal);
      const page=await readPrivateHistoryPage(this.session,meta,signal,{before,after,anchorId});
      if(!signal.aborted&&this.active()&&request===this.request)this.page=page;
    }catch(cause){if(!signal.aborted&&this.active()&&request===this.request)this.error=cause instanceof Error?t(cause.message):uiLiteral('恢复历史暂时无法读取');}
    finally{if(!signal.aborted&&this.active()&&request===this.request){this.loading=false;this.changed();}}})();
    this.settled=run;return run;
  }
  pauseMedia():void{this.mediaAbort.abort();this.mediaAbort=new AbortController();}
  dispose():void{this.signal.removeEventListener('abort',this.abort);this.request++;this.pageAbort.abort();this.mediaAbort.abort();this.page={items:[],start:0,end:0,total:0,revision:''};this.loading=false;this.error='';}
}
