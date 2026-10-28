import '../language-feedback.css';
import { LANGUAGES, languagePreference, setLanguage, t } from './language';

const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
type Options={ root:HTMLElement; signal:AbortSignal; active:()=>boolean; back:()=>void; notice:(message:string)=>void };
const page=(root:HTMLElement,title:string,body:string,back:()=>void)=>{
  root.innerHTML=`<section class="language-feedback-page"><main class="language-feedback-content"><h1>${escape(title)}</h1>${body}</main><footer class="page-back-footer"><button class="page-back-button" type="button">${escape(t('返回'))}</button></footer></section>`;
  root.querySelector('.page-back-button')!.addEventListener('click',back);
  return root.firstElementChild as HTMLElement;
};
export function renderLanguagePage(options:Options):void {
  const {root,signal,active,back,notice}=options;
  const preference=languagePreference();
  const choices=[{id:'system',name:t('跟随系统')},...LANGUAGES];
  const host=page(root,t('语言 / Language'),`<fieldset class="language-options" aria-label="${escape(t('语言 / Language'))}">${choices.map(({id,name})=>`<label class="language-choice"><span dir="auto" lang="${id==='system'?'':id}">${escape(name)}</span><input type="radio" name="language" value="${id}" ${preference===id?'checked':''}></label>`).join('')}</fieldset>`,back);
  host.addEventListener('change',async event=>{
    const target=event.target;if(!(target instanceof HTMLInputElement)||!active())return;
    host.querySelectorAll('input').forEach(input=>input.disabled=true);
    try { await setLanguage(target.value as Parameters<typeof setLanguage>[0]); if(active()&&host.isConnected)renderLanguagePage(options); }
    catch {if(active()&&host.isConnected){renderLanguagePage(options);notice(t('未能保存，请重试'));}}
  },{signal});
}
export function renderFeedbackPage({root,signal,active,back,notice}:Options):void {
  let clear=()=>{};
  const host=page(root,t('用户反馈'),`<form class="feedback-form" novalidate><label for="feedback-email">${escape(t('邮箱'))}<span>${escape(t('必填'))}</span></label><input id="feedback-email" name="email" type="email" dir="ltr" autocomplete="email" autocapitalize="none" maxlength="254" required aria-describedby="feedback-email-error"><p id="feedback-email-error" class="feedback-error" role="alert"></p><label for="feedback-message">${escape(t('反馈内容'))}<span>${escape(t('必填'))}</span></label><textarea id="feedback-message" name="message" rows="7" dir="auto" required aria-describedby="feedback-message-error feedback-count"></textarea><p id="feedback-count" class="feedback-count">0 / 5,000</p><p id="feedback-message-error" class="feedback-error" role="alert"></p><button class="primary-button" type="submit">${escape(t('提交反馈'))}</button></form>`,()=>{clear();back();});
  const form=host.querySelector('form')!,email=host.querySelector<HTMLInputElement>('#feedback-email')!,message=host.querySelector<HTMLTextAreaElement>('#feedback-message')!,submit=host.querySelector<HTMLButtonElement>('[type="submit"]')!;
  let busy=false,requestId=crypto.randomUUID(),payload='';
  const pageAbort=new AbortController(),pageSignal=AbortSignal.any([signal,pageAbort.signal]);
  const live=()=>!pageSignal.aborted&&active()&&host.isConnected;
  clear=()=>{email.value='';message.value='';payload='';};
  const departure=new MutationObserver(()=>{if(!host.isConnected){clear();pageAbort.abort();departure.disconnect();}});
  departure.observe(root,{childList:true});
  pageSignal.addEventListener('abort',()=>{clear();departure.disconnect();},{once:true});
  const count=()=>{host.querySelector('#feedback-count')!.textContent=`${[...message.value].length.toLocaleString()} / 5,000`;};
  message.addEventListener('input',count,{signal});message.addEventListener('change',count,{signal});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!live())return;
    const e=email.value.trim(),m=message.value.trim();
    const emailError=!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e)||e.length>254||/[\x00-\x1f\x7f]/.test(e);
    const messageError=!m||[...m].length>5000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(m);
    host.querySelector('#feedback-email-error')!.textContent=emailError?t('请输入有效的邮箱地址'):'';
    host.querySelector('#feedback-message-error')!.textContent=messageError?t('请填写 1 至 5,000 字的反馈内容'):'';
    email.setAttribute('aria-invalid',String(emailError));message.setAttribute('aria-invalid',String(messageError));
    if(emailError||messageError){(emailError?email:message).focus();return;}
    const fingerprint=JSON.stringify([e,m]);if(payload&&payload!==fingerprint)requestId=crypto.randomUUID();payload=fingerprint;
    busy=true;submit.disabled=true;submit.textContent=t('正在提交…');email.readOnly=true;message.readOnly=true;
    try {
      const response=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:requestId,email:e,message:m}),signal:AbortSignal.any([pageSignal,AbortSignal.timeout(15000)]),credentials:'same-origin'});
      if(!response.ok)throw new Error(response.status===429?'RATE_LIMITED':'FAILED');
      const result=await response.json();if(result.accepted!==true)throw new Error('FAILED');
      if(!live())return;
      clear();page(root,t('反馈已提交'),'<div class="feedback-success" aria-hidden="true">✓</div>',back);
    }catch(error){if(live())notice(t(error instanceof Error&&error.message==='RATE_LIMITED'?'提交过于频繁，请稍后重试':'提交失败，内容已保留，请重试'));}
    finally{busy=false;if(live()){submit.disabled=false;submit.textContent=t('提交反馈');email.readOnly=false;message.readOnly=false;}}
  },{signal});
}
