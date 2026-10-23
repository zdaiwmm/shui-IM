import { animatePageReplacement } from './motion';
import { chamberBrand } from './entry-art';

/** Reuse the welcome canvas and brand. Work readiness, never animation, authorizes entry. */
export function mountRoomCreation(root:HTMLElement,signal:AbortSignal){
  const previous=root.querySelector<HTMLElement>(':scope > .space-drawer-overlay:not(.is-closing)')??root.firstElementChild as HTMLElement|null;
  const source=root.querySelector<HTMLElement>(':scope > .gateway-welcome');
  const page=source??document.createElement('section');
  if(!source){page.className='gateway gateway-welcome gateway-intro';page.innerHTML=`<div class="gateway-intro-content">${chamberBrand()}<div class="gateway-heading"><h1></h1><div class="welcome-copy"><p></p></div></div></div><div class="welcome-actions"><button type="button" disabled></button></div>`;root.replaceChildren(page);}
  page.classList.remove('is-ready','is-failed');page.style.removeProperty('--creation-open');page.classList.add('room-creation-page');page.setAttribute('aria-label','正在创建密室');
  if(!source&&previous)animatePageReplacement(root,previous,page,false,signal,true);
  const heading=page.querySelector<HTMLElement>('h1')!,copy=page.querySelector<HTMLElement>('.welcome-copy')!,button=page.querySelector<HTMLButtonElement>('.welcome-actions button')!;
  // Freeze the existing rails before changing copy, preserving the exact brand position.
  heading.style.minHeight=`${heading.clientHeight}px`;copy.style.minHeight=`${copy.clientHeight}px`;
  heading.textContent='正在准备你的密室';copy.innerHTML='<p role="status">请稍等片刻</p>';
  button.disabled=true;button.classList.add('room-creation-indicator');button.setAttribute('aria-label','正在创建');button.innerHTML='<span class="room-creation-spinner" aria-hidden="true"></span><span class="room-creation-check" aria-hidden="true">✓</span>';
  page.querySelector('.gateway-heading')!.append(button);
  page.querySelector('.welcome-actions')?.remove();
  const order=['keys','save','connect'] as const,messages=['正在准备本机密钥','正在加密保存密室','正在建立安全连接'];
  let requested=0,displayed=0,started=performance.now(),readyAt=0,actualDone=false,frame=0,disposed=false,resolve!:()=>void;
  const finished=new Promise<void>(done=>{resolve=done;});
  const paint=()=>{copy.querySelector('p')!.textContent=messages[Math.min(2,displayed)]!;heading.textContent=displayed===0?'正在准备你的密室':displayed===1?'正在建立加密保护':'正在确认密室';page.dataset.creationStage=order[Math.min(2,displayed)];};
  const tick=(now:number)=>{
    if(disposed||signal.aborted)return;
    if(readyAt){const open=Math.min(1,(now-readyAt)/960);page.style.setProperty('--creation-open',String(matchMedia('(prefers-reduced-motion:reduce)').matches?0:open));if(now-readyAt>=1000){resolve();return;}}
    else if(now-started>=1200&&(requested>displayed||actualDone)){
      displayed++;started=now;
      if(displayed===3){readyAt=now;page.classList.add('is-ready');heading.textContent='密室已准备好';copy.querySelector('p')!.textContent='进入只属于你们的对话';button.setAttribute('aria-label','密室已准备好');}
      else paint();
    }
    frame=requestAnimationFrame(tick);
  };
  paint();frame=requestAnimationFrame(tick);
  // The caller replaces this opaque page with chat or the durable pending-create page.
  const dispose=()=>{disposed=true;cancelAnimationFrame(frame);signal.removeEventListener('abort',dispose);resolve();};
  signal.addEventListener('abort',dispose,{once:true});
  return {finished,complete(){actualDone=true;},fail(message:string){if(disposed)return;page.classList.add('is-failed');heading.textContent='暂未完成创建';copy.querySelector('p')!.textContent=message;button.setAttribute('aria-label','创建未完成');},status(message:string){if(!disposed&&!readyAt)copy.querySelector('p')!.textContent=message;},step(step:typeof order[number],message:string){requested=Math.max(requested,order.indexOf(step));messages[order.indexOf(step)]=message;},dispose};
}
