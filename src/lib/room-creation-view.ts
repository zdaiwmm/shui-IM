import { uiLiteral } from './language';
import { animatePageReplacement } from './motion';
import { chamberBrand } from './entry-art';
import { createElement, Check } from 'lucide';

/** Reuse the welcome canvas and brand. Work readiness, never animation, authorizes entry. */
export function mountRoomCreation(root:HTMLElement,signal:AbortSignal){
  const previous=root.querySelector<HTMLElement>(':scope > .space-drawer-overlay:not(.is-closing)')??root.firstElementChild as HTMLElement|null;
  const source=root.querySelector<HTMLElement>(':scope > .gateway-welcome');
  const page=source??document.createElement('section');
  if(!source){page.className='gateway gateway-welcome gateway-intro';page.innerHTML=`<div class="gateway-intro-content">${chamberBrand()}<div class="gateway-heading"><h1></h1><div class="welcome-copy"><p></p></div></div></div><div class="welcome-actions"><button type="button" disabled></button></div>`;root.replaceChildren(page);}
  page.classList.remove('is-ready','is-failed');page.style.removeProperty('--creation-open');page.classList.add('room-creation-page');page.setAttribute('aria-label',uiLiteral('正在创建密室'));
  if(!source&&previous)animatePageReplacement(root,previous,page,false,signal,true);
  const heading=page.querySelector<HTMLElement>('h1')!,copy=page.querySelector<HTMLElement>('.welcome-copy')!,button=page.querySelector<HTMLButtonElement>('.welcome-actions button')!;
  heading.setAttribute('role','status');copy.hidden=true;
  button.disabled=true;button.classList.add('room-creation-indicator');button.setAttribute('aria-label',uiLiteral('正在创建'));button.innerHTML='<span class="room-creation-spinner" aria-hidden="true"></span><span class="room-creation-check" aria-hidden="true"></span>';
  button.querySelector('.room-creation-check')!.append(createElement(Check));
  page.querySelector('.gateway-heading')!.append(button);
  page.querySelector('.welcome-actions')?.remove();
  const order=['keys','save','connect'] as const;
  let requested=0,displayed=0,started=performance.now(),readyAt=0,actualDone=false,frame=0,disposed=false,resolve!:()=>void;
  const finished=new Promise<void>(done=>{resolve=done;});
  const labels=[uiLiteral('准备密钥'),uiLiteral('保存密室'),uiLiteral('建立连接')];
  const paint=()=>{heading.textContent=labels[Math.min(2,displayed)]!;page.dataset.creationStage=order[Math.min(2,displayed)];};
  const tick=(now:number)=>{
    if(disposed||signal.aborted)return;
    if(readyAt){const open=Math.min(1,(now-readyAt)/960);page.style.setProperty('--creation-open',String(matchMedia('(prefers-reduced-motion:reduce)').matches?0:open));if(now-readyAt>=1000){resolve();return;}}
    else if(now-started>=1200&&(requested>displayed||actualDone)){
      displayed++;started=now;
      if(displayed===3){readyAt=now;page.classList.add('is-ready');heading.textContent=uiLiteral('密室已就绪');button.setAttribute('aria-label',uiLiteral('密室已就绪'));}
      else paint();
    }
    frame=requestAnimationFrame(tick);
  };
  paint();frame=requestAnimationFrame(tick);
  // The caller replaces this opaque page with chat or the durable pending-create page.
  const dispose=()=>{disposed=true;cancelAnimationFrame(frame);signal.removeEventListener('abort',dispose);resolve();};
  signal.addEventListener('abort',dispose,{once:true});
  return {finished,complete(){actualDone=true;},fail(message:string){if(disposed)return;page.classList.add('is-failed');heading.textContent=uiLiteral('暂未完成创建');copy.hidden=false;copy.textContent=message;button.setAttribute('aria-label',uiLiteral('创建未完成'));},status(message:string){if(!disposed&&!readyAt)heading.textContent=message;},step(step:typeof order[number],_message:string){requested=Math.max(requested,order.indexOf(step));},dispose};
}
