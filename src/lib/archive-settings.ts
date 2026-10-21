import { createElement, Upload, KeyRound, Download, Eye, EyeOff, Check, Image, FileText, Video, AudioLines, MessageSquare } from 'lucide';
import { createArchiveCardImage, readArchiveCardImage, archiveCardLabel } from './archive-card-image';
import { protectArchiveCard, unlockArchiveCard, archiveAccessToken, archiveAccessHash, archiveAccessProof } from './room-archive-crypto';
import { restoreRoomArchive, type ArchiveRestoreProgress } from './room-archive';
import { saveVault, withVaultMutation, loadPrivateArchiveItems, type VaultSession } from './vault';
import { showExplanation } from './explanation-dialog';
import { mountDialog } from './dialog';
import { authorizedFetch } from './api';
import { toBase64Url } from './base64';

type Options = { startWithCredential?: boolean; startWithRestore?: boolean; name:()=>string; verify:()=>Promise<void>; root:HTMLElement; session:VaultSession; signal:AbortSignal; active:()=>boolean; notice:(text:string,error?:boolean)=>void; back:()=>void; sync:()=>Promise<void>; restored:()=>void; beginPick:()=>boolean; finishPick:()=>Promise<boolean>; saveImage:(blob:Blob)=>Promise<void> };
const escape = (text:string) => text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const icon = (value:Parameters<typeof createElement>[0]) => createElement(value).outerHTML;
export function mountArchiveSettings(o:Options):void {
  let pageAbort:AbortController|undefined, previewAuthorized=false;
  const begin=()=>{pageAbort?.abort();pageAbort=new AbortController();return AbortSignal.any([o.signal,pageAbort.signal]);};
  const active=()=>o.active()&&!o.signal.aborted;
  const shell=(title:string,content:string)=>`<main class="backup-page archive-page"><header class="subpage-header backup-header"><button class="icon-button" id="archive-back" data-back type="button" aria-label="返回">‹</button><div class="backup-heading"><h1>${title}</h1></div><span class="backup-header-spacer" aria-hidden="true"></span></header><section class="backup-content">${content}</section></main>`;
  const report=(cause:unknown)=>{if(active()&&!(cause instanceof DOMException&&cause.name==='AbortError'))o.notice(cause instanceof Error?cause.message:'操作未完成，请重试',true);};
  const leave=()=>{previewAuthorized=false;pageAbort?.abort();o.back();};
  const protectTask=(button:HTMLButtonElement,task:()=>Promise<void>)=>{
    if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');
    void task().catch(report).finally(()=>{if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy');}});
  };
  function bindBack(callback=leave){o.root.querySelector('[data-back]')!.addEventListener('click',callback);}
  function bindHelp(signal:AbortSignal) {
    const button=document.createElement('button');button.className='text-button archive-help';button.type='button';button.dataset.archiveHelp='';button.textContent='忘记凭证密码？';o.root.querySelector('.backup-content')!.append(button);
    button.addEventListener('click',()=>showExplanation(o.root,'忘记凭证密码？',[
      '恢复聊天记录需要凭证原图和对应密码，两者缺一不可。',
      '修改密码需要原凭证密码。忘记后无法重置，请保留仍可打开的浏览器数据。',
      '修改成功后，旧凭证停止在线恢复。服务器无法找回密码。',
    ],{signal,active}));
  }
  function bindFile(input:HTMLInputElement,signal:AbortSignal,change:(file:File|undefined)=>void) {
    input.addEventListener('click',event=>{if(!o.beginPick())event.preventDefault();},{signal});
    input.addEventListener('change',()=>void(async()=>{const file=input.files?.[0];if(await o.finishPick()||signal.aborted||!active()){input.value='';return;}change(file);})(),{signal});
    input.addEventListener('cancel',()=>void o.finishPick(),{signal});
  }
  async function saveCredential(credential:string,signal:AbortSignal,verified=false){
    await withVaultMutation(o.session,async lease=>{
      signal.throwIfAborted();if(!active())throw new DOMException('操作已结束','AbortError');
      const previous=o.session.vault.roomArchiveV2!;
      o.session.vault.roomArchiveV2={...previous,credential,cardVerified:verified};
      try{await saveVault(o.session,lease);}catch(cause){o.session.vault.roomArchiveV2=previous;throw cause;}
    });
  }
  function settings() {
    const signal=begin();
    o.root.innerHTML=shell('备份与恢复',`<p class="backup-intro">聊天记录和原文件会在联网、解锁时自动加密备份。</p><div class="backup-settings-group"><section class="backup-setting"><div class="backup-setting-copy"><span class="backup-setting-icon">${icon(Upload)}</span><div><h2>自动备份</h2><p data-archive-status>正在读取备份状态…</p></div></div><button class="secondary-button" data-sync>立即备份</button></section><button class="archive-entry" data-card>${icon(KeyRound)}<span>恢复凭证<small>设置密码，保存恢复卡片</small></span><b>›</b></button><button class="archive-entry" data-restore>${icon(Download)}<span>聊天记录恢复<small>用已保存的凭证找回记录</small></span><b>›</b></button></div>`);
    bindBack();
    const status=o.root.querySelector<HTMLElement>('[data-archive-status]')!;
    void loadPrivateArchiveItems(o.session).then(items=>{if(!status.isConnected)return;const state=o.session.vault.archiveState;
      const complete=!!state?.completeAt&&!state.pending&&!state.preparing&&state.cursor>=o.session.vault.lastSeq&&(state.privateDone?.length??0)>=items.length;
      status.textContent=complete?'当前记录及原文件已备份':'部分内容尚未备份，请保持联网并解锁';
    }).catch(report);
    o.root.querySelector<HTMLButtonElement>('[data-sync]')!.addEventListener('click',event=>protectTask(event.currentTarget as HTMLButtonElement,async()=>{await o.sync();if(!signal.aborted&&active())settings();}));
    o.root.querySelector('[data-card]')!.addEventListener('click',()=>card());
    o.root.querySelector('[data-restore]')!.addEventListener('click',restore);
  }
  const steps=(current:number)=>`<ol class="archive-steps" aria-label="凭证设置步骤">${['设置密码','导出凭证','回验原图'].map((label,index)=>`<li ${index+1===current?'aria-current="step"':''} data-state="${index+1<current?'done':index+1===current?'active':'waiting'}"><b>${index+1<current?icon(Check):index+1}</b><span>${label}</span></li>`).join('')}</ol>`;
  const field=(name:string,label:string,placeholder:string,autocomplete='new-password')=>`<label class="passkey-name-field"><span>${label}</span><span class="archive-password-control"><input aria-label="${label}" name="${name}" type="password" autocomplete="${autocomplete}" placeholder="${placeholder}" maxlength="256" required><button type="button" data-password-toggle aria-label="显示${label}" aria-pressed="false">${icon(Eye)}</button></span></label>`;
  function eyes(scope:HTMLElement,signal:AbortSignal){
    scope.querySelectorAll<HTMLButtonElement>('[data-password-toggle]').forEach(button=>{
      const input=button.parentElement!.querySelector<HTMLInputElement>('input')!;
      button.addEventListener('pointerdown',event=>event.preventDefault(),{signal});
      button.addEventListener('click',()=>{const show=input.type==='password';input.type=show?'text':'password';button.setAttribute('aria-pressed',String(show));button.setAttribute('aria-label',`${show?'隐藏':'显示'}${input.getAttribute('aria-label')??'密码'}`);button.innerHTML=icon(show?EyeOff:Eye);},{signal});
      signal.addEventListener('abort',()=>{input.type='password';input.value='';},{once:true});
    });
  }
  async function changeArchive(signal:AbortSignal,change:(archive:NonNullable<VaultSession['vault']['roomArchiveV2']>)=>void){
    await withVaultMutation(o.session,async lease=>{
      signal.throwIfAborted();if(!active())throw new DOMException('操作已结束','AbortError');
      const previous=o.session.vault.roomArchiveV2!;
      const next=structuredClone(previous);change(next);o.session.vault.roomArchiveV2=next;
      try{await saveVault(o.session,lease);}catch(cause){o.session.vault.roomArchiveV2=previous;throw cause;}
    });
  }
  async function resumeRotation(signal:AbortSignal){
    const pending=o.session.vault.roomArchiveV2!.rotation;if(!pending)return;
    // The encrypted pending record predates the network operation. Lost replies
    // repeat the same signed compare-and-swap, never a second rotation.
    await authorizedFetch(`/api/rooms/${o.session.vault.roomId}/private-archives/${pending.key.descriptor.id}/access`,o.session.vault.accessToken,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected:pending.expected,next:pending.next,proof:pending.proof}),signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
    await changeArchive(signal,archive=>{if(archive.rotation?.next!==pending.next)throw new Error('凭证状态已改变');archive.key=pending.key;archive.credential=pending.credential;archive.cardVerified=false;archive.exported=false;delete archive.rotation;});
  }
  function confirmRotation(signal:AbortSignal):Promise<boolean>{
    return new Promise(resolve=>{
      const sheet=document.createElement('section');sheet.className='confirm-overlay archive-change-confirm';sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label','确认修改凭证密码');
      sheet.innerHTML='<div class="confirm-dialog simple-confirm"><h2>修改凭证密码？</h2><p>修改成功后，此归档以前导出的凭证图片将无法再在线恢复聊天记录。请重新导出并验证新凭证。</p><div class="simple-confirm-actions"><button type="button" class="text-button" data-cancel>取消</button><button type="button" class="primary-button" data-confirm>确认修改</button></div></div>';
      o.root.append(sheet);let settled=false;const done=(value:boolean)=>{if(settled)return;settled=true;dialog.dispose();resolve(value);};
      const dialog=mountDialog(sheet,{signal,isActive:active,onClose:()=>done(false)});
      sheet.querySelector('[data-cancel]')!.addEventListener('click',()=>done(false));sheet.querySelector('[data-confirm]')!.addEventListener('click',()=>done(true));
      signal.addEventListener('abort',()=>done(false),{once:true});
    });
  }
  function card(editing=false) {
    if(!active())return;const signal=begin(),archive=o.session.vault.roomArchiveV2!;
    if(archive.rotation){
      o.root.innerHTML=shell('正在完成密码修改','<p class="backup-intro">正在核对上次修改结果，请保持联网。新凭证已在本浏览器加密保留。</p><button class="primary-button" data-resume>继续完成修改</button>');bindBack();
      const button=o.root.querySelector<HTMLButtonElement>('[data-resume]')!;const resume=()=>protectTask(button,async()=>{await resumeRotation(signal);if(active()&&!signal.aborted)card();});button.addEventListener('click',resume);resume();return;
    }
    const credential=archive.credential;
    if(!credential||editing){
      o.root.innerHTML=shell(editing?'修改凭证密码':'恢复凭证',`${editing?'':steps(1)}${editing?'':'<h2 class="archive-form-title">先设置凭证密码</h2>'}<p class="backup-intro">${editing?'输入原密码后设置新密码。修改成功后，需要重新保存并验证新凭证。':'凭证密码仅用于本浏览器加密，不上传服务器。完成密码设置、导出和原图回验后，隐私引导才会显示「已设置」。'}</p><form class="archive-password-form" data-card-form novalidate>${editing?field('original','原凭证密码','输入当前凭证密码','current-password'):''}${field('password',editing?'新凭证密码':'凭证密码','12–128 个字符')}${field('confirm','确认凭证密码','再次输入凭证密码')}<p class="archive-form-note">凭证密码与应用锁独立，请分开保管。</p><button class="primary-button" type="submit">${editing?'保存新密码':'下一步：导出凭证'}</button></form>`);
      bindBack(editing?()=>card():o.startWithCredential?leave:settings);eyes(o.root,signal);
      const form=o.root.querySelector<HTMLFormElement>('[data-card-form]')!;
      signal.addEventListener('abort',()=>form.reset(),{once:true});
      form.addEventListener('submit',event=>{event.preventDefault();protectTask(form.querySelector<HTMLButtonElement>('button[type=submit]')!,async()=>{
        if(o.session.vault.roomArchiveV2?.rotation){await resumeRotation(signal);if(active()&&!signal.aborted)card();return;}
        const password=(form.elements.namedItem('password') as HTMLInputElement).value;
        if(password!==(form.elements.namedItem('confirm') as HTMLInputElement).value)throw new Error('两次输入的凭证密码不一致');
        if(editing){
          const old=await unlockArchiveCard(credential!,(form.elements.namedItem('original') as HTMLInputElement).value);
          if(old.descriptor.id!==archive.key.descriptor.id||archiveAccessToken(old)!==archiveAccessToken(archive.key))throw new Error('原凭证与当前状态不一致');
          if(signal.aborted||!active()||!await confirmRotation(signal))return;
          await o.verify();if(signal.aborted||!active())return;
          // Ensure an empty archive is registered before rotating its read authority.
          await o.sync();if(signal.aborted||!active())return;
          const key={...archive.key,readToken:toBase64Url(crypto.getRandomValues(new Uint8Array(32)))},expected=archiveAccessHash(archiveAccessToken(archive.key)),next=archiveAccessHash(key.readToken);
          const envelope=await protectArchiveCard(key,password),proof=archiveAccessProof(archive.key,o.session.vault.roomId,o.session.vault.identity.publicBundle.deviceId,expected,next);
          await changeArchive(signal,current=>{if(current.credential!==credential)throw new Error('凭证状态已改变');if(current.rotation)throw new Error('上次修改尚未完成，请先继续完成');current.cardVerified=false;current.exported=false;current.rotation={key,credential:envelope,expected,next,proof};});
          try{await resumeRotation(signal);}catch(cause){if(active()&&!signal.aborted)card();throw cause;}
        }else{
          const envelope=await protectArchiveCard(archive.key,password);if(signal.aborted||!active())return;await saveCredential(envelope,signal);
        }
        form.reset();if(!signal.aborted&&active()){card();o.notice(editing?'密码已修改，请导出并回验新凭证':'密码已保存，还需导出并回验原图');}
      });});return;
    }
    const current=archive.cardVerified?4:archive.exported?3:2;
    o.root.innerHTML=shell('恢复凭证',`${archive.cardVerified?'':steps(current)}${archive.cardVerified?'':`<p class="archive-step-note">${current===2?'第 2 步：导出凭证并保存原图，随后验证是否可用。':'第 3 步：选取已保存的凭证原图，输入密码完成回验。'}</p>`}<figure class="archive-image-preview" aria-label="恢复凭证原图"><img data-card-image alt="${escape(o.name())}的恢复凭证，内容与导出原图一致"><p data-card-loading role="status">验证应用锁后显示完整凭证…</p></figure><div class="archive-card-status" data-card-status>${archive.cardVerified?'已保存并验证':'尚未完成 · 导出并回验后显示已设置'}</div><div class="archive-card-actions"><button class="primary-button" data-download type="button">${icon(Download)}导出凭证</button>${current===3?'<button class="secondary-button" data-verify-saved type="button">回验已保存的原图</button>':''}</div>`);
    o.root.querySelector('main')!.classList.add('archive-credential-page');
    const header=o.root.querySelector('header')!,change=document.createElement('button');change.className='text-button archive-change-password';change.type='button';change.dataset.changePassword='';change.textContent='修改凭证密码';header.append(change);
    bindBack(o.startWithCredential?leave:settings);
    let blob:Blob|undefined,url:string|undefined;
    signal.addEventListener('abort',()=>{if(url)URL.revokeObjectURL(url);blob=undefined;},{once:true});
    const preview=async()=>{if(!previewAuthorized){await o.verify();if(signal.aborted||!active())return;previewAuthorized=true;}const generated=await createArchiveCardImage(credential,o.name());if(signal.aborted||!active())return;blob=generated;url=URL.createObjectURL(blob);o.root.querySelector<HTMLImageElement>('[data-card-image]')!.src=url;o.root.querySelector('[data-card-loading]')?.remove();};
    const ready=preview().catch(report);
    change.addEventListener('click',()=>card(true));
    o.root.querySelector('[data-verify-saved]')?.addEventListener('click',()=>verifySaved(signal,credential));
    o.root.querySelector<HTMLButtonElement>('[data-download]')!.addEventListener('click',event=>protectTask(event.currentTarget as HTMLButtonElement,async()=>{
      await ready;if(!blob){await preview();}if(!blob||signal.aborted||!active())return;
      await o.verify();if(signal.aborted||!active())return;await o.saveImage(blob);
      if(signal.aborted||!active())return;await changeArchive(signal,current=>{current.exported=true;});
      // System handoff alone is not evidence that a file was saved.
      verifySaved(signal,credential);
    }));
  }
  function verifySaved(signal:AbortSignal,credential:string){
    const sheet=document.createElement('section');sheet.className='confirm-overlay archive-verification-overlay';sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label','验证已保存的凭证');
    sheet.innerHTML=`<div class="confirm-dialog archive-dialog">${steps(3)}<h2>确认凭证已保存</h2><p>选择刚保存的原图，验证后即可放心保管。</p><form data-verify novalidate><label class="archive-upload">选择凭证原图<input name="image" type="file" accept="image/png" required></label>${field('password','凭证密码','输入这张凭证的密码','off')}<button class="primary-button" type="submit">验证已保存的凭证</button></form><button class="text-button" data-close type="button">稍后验证</button></div>`;
    o.root.append(sheet);const form=sheet.querySelector<HTMLFormElement>('form')!;
    const dialog=mountDialog(sheet,{signal,isActive:active,onClose:()=>form.reset()});eyes(sheet,signal);
    sheet.querySelector('[data-close]')!.addEventListener('click',()=>dialog.close());
    bindFile(form.querySelector('input[type=file]')!,signal,()=>{});
    form.addEventListener('submit',event=>{event.preventDefault();protectTask(form.querySelector<HTMLButtonElement>('button[type=submit]')!,async()=>{
      const file=(form.elements.namedItem('image') as HTMLInputElement).files?.[0];if(!file)throw new Error('请选择刚保存的凭证原图');
      const text=await readArchiveCardImage(file);if(text!==credential)throw new Error('这不是本次导出的凭证，请重新选择');
      const key=await unlockArchiveCard(text,(form.elements.namedItem('password') as HTMLInputElement).value);
      if(signal.aborted||!active()||!sheet.isConnected)return;
      if(key.descriptor.id!==o.session.vault.roomArchiveV2!.key.descriptor.id)throw new Error('这张凭证不属于当前密室');
      await saveCredential(credential,signal,true);dialog.dispose();card();o.notice('凭证已保存并验证');
    });});
  }
  function restore() {
    const signal=begin();let envelope:string|undefined,selection=0,previewUrl:string|undefined;
    o.root.innerHTML=shell('聊天记录恢复',`<p class="backup-intro">选择凭证原图，输入对应密码，将历史恢复到当前密室，仅自己可见。</p><form data-restore-form novalidate><label class="archive-upload archive-upload-main">${icon(Upload)}<strong data-upload-title>上传恢复凭证</strong><span>选择已保存的 PNG 原图</span><input name="image" type="file" accept="image/png" required></label><progress class="archive-file-progress" max="100" value="0" aria-label="凭证读取进度" hidden></progress><div class="archive-selected" hidden><img alt="所选凭证预览"><div><strong data-card-label></strong><p data-selected-status role="status"></p></div></div>${field('password','凭证密码','输入这张凭证的密码','off')}<button class="primary-button" data-restore-submit type="submit" disabled>恢复聊天记录</button></form>`);
    bindBack(o.startWithRestore?leave:settings);eyes(o.root,signal);
    const form=o.root.querySelector<HTMLFormElement>('form')!,button=form.querySelector<HTMLButtonElement>('[data-restore-submit]')!,progress=form.querySelector<HTMLProgressElement>('progress')!;
    bindFile(form.querySelector('input[type=file]')!,signal,file=>{
      const attempt=++selection;envelope=undefined;button.disabled=true;progress.hidden=true;progress.value=0;if(previewUrl)URL.revokeObjectURL(previewUrl);form.querySelector<HTMLElement>('.archive-selected')!.hidden=true;
      if(!file)return;
      if(file.size>4*1024*1024){report(new Error('请选择 4 MB 以内的凭证原图'));return;}
      progress.hidden=false;progress.value=0;
      const reader=new FileReader(),abortRead=()=>reader.abort();signal.addEventListener('abort',abortRead,{once:true});reader.onloadend=()=>signal.removeEventListener('abort',abortRead);
      reader.onprogress=event=>{if(attempt===selection&&!signal.aborted&&event.lengthComputable)progress.value=event.loaded/event.total*90;};
      reader.onerror=()=>{if(attempt===selection&&!signal.aborted){progress.hidden=true;report(new Error('图片读取失败，请重新选择'));}};
      reader.onload=()=>void(async()=>{
        try{
          const image=new Blob([reader.result as ArrayBuffer],{type:'image/png'}),text=await readArchiveCardImage(image),label=await archiveCardLabel(image);
          if(attempt!==selection||signal.aborted||!active())return;
          envelope=text;progress.value=100;previewUrl=URL.createObjectURL(image);
          form.querySelector<HTMLImageElement>('.archive-selected img')!.src=previewUrl;form.querySelector<HTMLElement>('.archive-selected')!.hidden=false;
          form.querySelector('[data-card-label]')!.textContent=label||'恢复凭证原图';form.querySelector('[data-selected-status]')!.textContent='图片已就绪 · 凭证名称仅供辨认，待密码验证';
          form.querySelector('[data-upload-title]')!.textContent='重新选择凭证';button.disabled=false;
        }catch(cause){if(attempt===selection&&!signal.aborted){progress.hidden=true;report(cause);}}
      })();reader.readAsArrayBuffer(file);
    });
    signal.addEventListener('abort',()=>{selection++;envelope=undefined;form.reset();if(previewUrl)URL.revokeObjectURL(previewUrl);},{once:true});
    form.addEventListener('submit',event=>{event.preventDefault();if(!envelope)return;protectTask(button,async()=>{
      const key=await unlockArchiveCard(envelope!,(form.elements.namedItem('password') as HTMLInputElement).value);
      if(signal.aborted||!active())return;
      (form.elements.namedItem('password') as HTMLInputElement).value='';(document.activeElement as HTMLElement|null)?.blur();
      await runRestore(key,signal);
    });});
  }
  async function runRestore(key:Parameters<typeof restoreRoomArchive>[1],pageSignal:AbortSignal){
    const abort=new AbortController(),signal=AbortSignal.any([pageSignal,abort.signal]);
    const sheet=document.createElement('section');sheet.className='confirm-overlay archive-progress-overlay';sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label','恢复进度');
    const kinds=[['messages','聊天记录',MessageSquare],['images','图片',Image],['videos','视频',Video],['files','文件',FileText],['audio','语音',AudioLines]] as const;
    sheet.innerHTML=`<div class="confirm-dialog archive-dialog"><h2 data-progress-title>正在恢复</h2><p data-progress role="status">正在读取备份目录…</p><progress max="100" aria-label="恢复进度"></progress><dl class="archive-restore-details">${kinds.map(([id,label,symbol])=>`<div>${icon(symbol)}<dt>${label}</dt><dd data-count="${id}">0</dd></div>`).join('')}</dl><p class="archive-inline-note" data-progress-note>正在本机校验，完成后统一显示。</p><button class="secondary-button" data-finish type="button">取消恢复</button></div>`;
    o.root.append(sheet);let complete=false,failed=false;
    const dialog=mountDialog(sheet,{signal:pageSignal,isActive:active,onClose:()=>abort.abort()});
    sheet.querySelector('[data-finish]')!.addEventListener('click',()=>{dialog.dispose();if(complete)leave();});
    const update=(state:ArchiveRestoreProgress)=>{
      if(signal.aborted||!active()||!sheet.isConnected)return;
      const progress=sheet.querySelector('progress')!;
      if(state.stage==='complete')progress.value=100;else if(state.stage!=='reading'&&state.totalObjects>0)progress.value=Math.min(99,Math.floor(state.objects/state.totalObjects*100));else progress.removeAttribute('value');
      sheet.querySelector('[data-progress]')!.textContent=state.stage==='reading'?'正在读取备份目录…':state.stage==='committing'?'正在整理并保存记录…':state.stage==='complete'?'聊天记录和原文件已恢复':state.totalObjects>0?`正在校验内容 · ${progress.value}%`:`正在校验内容 · 已读取 ${state.objects} 项`;
      for(const [id]of kinds)sheet.querySelector(`[data-count="${id}"]`)!.textContent=state.totals?`${state[id]} / ${state.totals[id]}`:`${state[id]} / 统计中`;
    };
    try{await restoreRoomArchive(o.session,key,signal,()=>{},update);if(signal.aborted||!active())return;complete=true;o.restored();sheet.querySelector('[data-progress-title]')!.textContent='恢复完成';sheet.querySelector('[data-progress-note]')!.textContent='已保存到当前密室，仅自己可见。自动备份将在联网时继续。';}
    catch(cause){if(signal.aborted||!active())return;failed=true;sheet.querySelector('[data-progress-title]')!.textContent='恢复未完成';sheet.querySelector('[data-progress]')!.textContent=cause instanceof Error?cause.message:'请检查网络后重试';sheet.querySelector('[data-progress-note]')!.textContent='尚未导入任何不完整记录。关闭后可重新恢复。';}
    finally{if(sheet.isConnected&&(complete||failed))sheet.querySelector('[data-finish]')!.textContent=complete?'完成':'关闭并重试';}
  }
  if(o.startWithCredential)card();else if(o.startWithRestore)restore();else settings();
}
