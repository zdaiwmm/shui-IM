import { mountDialog } from './dialog';
export const accessEscape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Deadlines are monotonic offsets from server time, never the local wall clock. */
export function formatAccessRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function accessDeadline(expiresAt:string,serverTime:string):number {
  const remaining=Date.parse(expiresAt)-Date.parse(serverTime);
  return performance.now()+Math.max(0,Math.min(600000,Number.isFinite(remaining)?remaining:0));
}
export function mountAccessApproval(root:HTMLElement,options:{signal:AbortSignal;title:string;description:string;code:string;deadline:number;approve:()=>Promise<void>;reject:()=>Promise<void>;closed:()=>void}):()=>void {
  const overlay=document.createElement('div');overlay.className='space-modal-overlay browser-access-modal';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label',options.title);
  overlay.innerHTML=`<section class="space-name-dialog"><button class="text-button access-close" aria-label="关闭授权弹窗">关闭</button><h2>${accessEscape(options.title)}</h2><p>${accessEscape(options.description)}</p><p class="access-code" aria-label="核对码">${accessEscape(options.code)}</p><p class="field-hint">请核对申请页面的六位码，仅批准你确认的请求。</p><p class="access-countdown" aria-live="off"></p><p class="form-error" role="alert"></p><div class="space-dialog-actions"><button class="text-button access-reject">拒绝</button><button class="primary-button access-approve">确认授权</button></div></section>`;
  root.append(overlay);let busy=false,timer:number|undefined;
  const dialog=mountDialog(overlay,{signal:options.signal,isActive:()=>!options.signal.aborted,onClose:()=>{window.clearInterval(timer);options.closed();}});
  const close=()=>dialog.close({animate:false});
  const tick=()=>{const left=Math.ceil((options.deadline-performance.now())/1000);if(left<=0){close();return;}const label=overlay.querySelector('.access-countdown');if(label)label.textContent=`${Math.floor(left/60)}:${String(left%60).padStart(2,'0')} 内完成授权`;};
  tick();timer=window.setInterval(tick,250);options.signal.addEventListener('abort',()=>window.clearInterval(timer),{once:true});
  overlay.querySelector('.access-close')!.addEventListener('click',close);
  async function run(action:()=>Promise<void>) {
    if(busy||options.signal.aborted||performance.now()>=options.deadline)return;
    busy=true;overlay.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=true);
    try{await action();if(!options.signal.aborted)close();}
    catch(cause){if(overlay.isConnected&&!options.signal.aborted)overlay.querySelector('.form-error')!.textContent=cause instanceof Error?cause.message:'授权未完成';}
    finally{busy=false;if(overlay.isConnected)overlay.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=false);}
  }
  overlay.querySelector('.access-approve')!.addEventListener('click',()=>void run(options.approve));
  overlay.querySelector('.access-reject')!.addEventListener('click',()=>void run(options.reject));
  return close;
}
