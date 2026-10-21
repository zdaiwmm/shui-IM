import { chamberBrand } from './entry-art';
import { mountDialog } from './dialog';

/** Actual work may finish early, but every reported stage has a complete presentation. */
export function mountRoomCreation(root:HTMLElement,signal:AbortSignal){
  const sheet=document.createElement('section');sheet.className='confirm-overlay room-creation-overlay';sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label','正在创建密室');
  sheet.innerHTML=`<div class="confirm-dialog room-creation-dialog">${chamberBrand()}<h2>正在创建密室</h2><p role="status">正在准备本机密钥</p><ol><li data-step="keys">准备本机密钥</li><li data-step="save">加密保存密室</li><li data-step="connect">建立安全连接</li></ol><div class="creation-track" aria-hidden="true"><span></span></div></div>`;root.append(sheet);
  const dialog=mountDialog(sheet,{signal,isActive:()=>!signal.aborted,beforeClose:()=>false});
  const order=['keys','save','connect'] as const,messages=['正在准备本机密钥','正在加密保存密室','正在建立安全连接'];
  let requested=0,displayed=0,started=performance.now(),actualDone=false,frame=0,disposed=false,resolve!:()=>void;
  const finished=new Promise<void>(done=>{resolve=done;});
  const paint=()=>{for(const [index,row]of [...sheet.querySelectorAll<HTMLElement>('[data-step]')].entries())row.dataset.state=index<displayed?'done':index===displayed?'active':'waiting';sheet.querySelector('p')!.textContent=messages[Math.min(2,displayed)]!;};
  const tick=(now:number)=>{
    if(disposed||signal.aborted)return;
    const progress=Math.min(1,(now-started)/1200);
    if(progress===1&&(requested>displayed||actualDone)){
      displayed++;started=now;paint();
      if(displayed===3){sheet.querySelector('p')!.textContent='密室已就绪';sheet.querySelector<HTMLElement>('.creation-track span')!.style.transform='scaleX(1)';resolve();return;}
    }
    sheet.querySelector<HTMLElement>('.creation-track span')!.style.transform=`scaleX(${Math.min(1,(displayed+Math.min(.98,(now-started)/1200))/3)})`;
    frame=requestAnimationFrame(tick);
  };
  paint();frame=requestAnimationFrame(tick);
  const dispose=()=>{disposed=true;cancelAnimationFrame(frame);resolve();dialog.dispose();};signal.addEventListener('abort',dispose,{once:true});
  return {finished,complete(){actualDone=true;},step(step:typeof order[number],message:string){requested=Math.max(requested,order.indexOf(step));messages[order.indexOf(step)]=message;},dispose};
}
