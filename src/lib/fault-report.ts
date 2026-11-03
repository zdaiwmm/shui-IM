import stages from './fault-stages.json';
import { currentRelease } from './release-update';
import { t } from './language';

export type FaultStage = keyof typeof stages;
const stageByError = new WeakMap<object,FaultStage>();
export function atFaultStage<T>(stage: FaultStage, operation: Promise<T>): Promise<T> {
  return operation.catch(error => {
    if (error && typeof error === 'object' && !stageByError.has(error)) stageByError.set(error,stage);
    throw error;
  });
}
export function validFaultId(value: unknown): value is string {
  return typeof value === 'string' && /^E-[0-9A-F]{16}$/.test(value);
}
export function makeFault(fallback: FaultStage, error: unknown, serverId?: string) {
  const stage = error instanceof Error && stageByError.get(error) || fallback;
  const name = error instanceof Error ? error.name : '';
  const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
  const reason = name === 'QuotaExceededError' ? 'STORAGE_QUOTA' : name === 'InvalidStateError' ? 'STORE_UNAVAILABLE'
    : name === 'TimeoutError' ? 'TIMEOUT' : status === 401 || status === 403 ? 'ACCESS_DENIED'
    : typeof status === 'number' ? 'REQUEST_REJECTED' : name === 'TypeError' && ['upload.reserve','upload.chunk','upload.complete','upload.status'].includes(stage) ? 'NETWORK' : 'FAILED';
  const recorded = validFaultId(serverId);
  const id = recorded ? serverId : 'E-'+Array.from(crypto.getRandomValues(new Uint8Array(8)),byte=>byte.toString(16).padStart(2,'0')).join('').toUpperCase();
  return { id, stage, reason, version:currentRelease.id, recorded };
}
export type FaultReport = ReturnType<typeof makeFault>;
export async function reportFault(fault: FaultReport, signal: AbortSignal) {
  const {id,stage,reason,version} = fault;
  try {
    const response = await fetch('/api/faults',{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({id,stage,reason,version}),
      signal:AbortSignal.any([signal,AbortSignal.timeout(6000)])});
    if (response.ok) {
      const receipt = await response.json();
      fault.recorded = receipt.recorded === true && receipt.id === id;
    }
  } catch { /* The user can copy local diagnostics or retry this same event. */ }
}

export function showFaultPanel(fault: FaultReport, signal: AbortSignal, feedback: (()=>void) | undefined) {
  const panel = document.createElement('aside'); panel.className='fault-notice'; panel.dataset.faultId=fault.id;
  const status=document.createElement('div');status.setAttribute('role','status');
  const code=document.createElement('code');code.textContent=fault.id;
  const controls=document.createElement('div');
  const button=(label:string,run:()=>void)=>{
    const el=document.createElement('button');el.type='button';el.textContent=t(label);el.onclick=run;controls.append(el);return el;
  };
  const copy=button('复制故障编号',async()=>{
    const value=fault.recorded?fault.id:[location.host,fault.id,fault.version,fault.stage,fault.reason].join(' / ');
    try{await navigator.clipboard.writeText(value);if(!signal.aborted)copy.textContent=t('已复制');}
    catch{if(!signal.aborted)code.textContent=value;}
  });
  if(feedback)button('用户反馈',feedback);
  const retry=button('重试上报',()=>void submit());
  button('关闭',()=>panel.remove());
  const paint=()=>{status.textContent=t(fault.recorded?'服务器已记录':'尚未上报');copy.textContent=t(fault.recorded?'复制故障编号':'复制本地诊断');retry.hidden=fault.recorded;};
  const submit=async()=>{retry.disabled=true;await reportFault(fault,signal);if(!signal.aborted){paint();retry.disabled=false;}};
  panel.append(status,code,controls);document.body.append(panel);paint();
  if(!fault.recorded)void submit();
  return panel;
}
