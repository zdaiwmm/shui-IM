import { createElement, Upload, KeyRound, Download, Eye, EyeOff, Check, Image, FileText, Video, AudioLines, MessageSquare } from 'lucide';
import { createArchiveCardImage, readArchiveCardImage, archiveCardLabel } from './archive-card-image';
import { protectArchiveCard, unlockArchiveCard, archiveAccessToken, archiveAccessHash, archiveAccessProof } from './room-archive-crypto';
import { restoreRoomArchive, readRoomArchiveCounts, type ArchiveRestoreProgress } from './room-archive';
import { saveVault, withVaultMutation, loadPrivateArchiveItems, type VaultSession } from './vault';
import { showExplanation } from './explanation-dialog';
import { mountDialog } from './dialog';
import { authorizedFetch } from './api';
import { toBase64Url } from './base64';
import { animatePageReplacement } from './motion';

type Options = { startWithCredential?: boolean; startWithRestore?: boolean; name:()=>string; verify:()=>Promise<void>; root:HTMLElement; session:VaultSession; signal:AbortSignal; active:()=>boolean; notice:(text:string,error?:boolean)=>void; back:()=>void; sync:()=>Promise<void>; backupChanged?:(enabled:boolean)=>void; restored:()=>void; beginPick:()=>boolean; finishPick:()=>Promise<boolean>; saveImage:(blob:Blob)=>Promise<void> };
const escape = (text:string) => text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const icon = (value:Parameters<typeof createElement>[0]) => createElement(value).outerHTML;
export function mountArchiveSettings(o:Options):void {
  let pageAbort:AbortController|undefined, initial=true, requiresOperationProof=false;
  const begin=()=>{pageAbort?.abort();pageAbort=new AbortController();return AbortSignal.any([o.signal,pageAbort.signal]);};
  const active=()=>o.active()&&!o.signal.aborted;
  const shell=(title:string,content:string)=>`<main class="backup-page archive-page"><header class="subpage-header backup-header"><button class="icon-button" id="archive-back" data-back type="button" aria-label="返回">‹</button><div class="backup-heading"><h1>${title}</h1></div><span class="backup-header-spacer" aria-hidden="true"></span></header><section class="backup-content">${content}</section></main>`;
  const report=(cause:unknown)=>{if(active()&&!(cause instanceof DOMException&&cause.name==='AbortError'))o.notice(cause instanceof Error?cause.message:'操作未完成，请重试',true);};
  const show=(html:string,backward=false)=>{const previous=initial?null:o.root.querySelector<HTMLElement>(':scope > .archive-page');initial=false;o.root.innerHTML=html;animatePageReplacement(o.root,previous,o.root.firstElementChild as HTMLElement,backward,o.signal);};
  const leave=()=>{pageAbort?.abort();o.back();};
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
    show(shell('备份与恢复',`<p class="backup-intro">聊天记录和原文件会在联网、解锁时自动加密备份。</p><div class="backup-settings-group"><section class="backup-setting"><div class="backup-setting-copy"><span class="backup-setting-icon">${icon(Upload)}</span><div><h2>自动备份</h2><p data-archive-status>正在读取备份状态…</p></div></div><button class="secondary-button" data-sync>立即备份</button></section><button class="archive-entry" data-card>${icon(KeyRound)}<span>恢复凭证<small>设置密码，保存恢复卡片</small></span><b>›</b></button><button class="archive-entry" data-restore>${icon(Download)}<span>聊天记录恢复<small>用已保存的凭证找回记录</small></span><b>›</b></button></div>`));
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
  const countLabels=[['messages','消息（含附件）'],['images','图片'],['videos','视频'],['audio','语音'],['files','文件']] as const;
  function automaticBackupCard():string {
    return `<section class="archive-backup-card" aria-labelledby="archive-auto-heading"><div class="archive-backup-heading"><h2 id="archive-auto-heading">自动备份</h2><button class="backup-toggle" type="button" role="switch" aria-labelledby="archive-auto-heading" aria-checked="${o.session.vault.roomArchiveV2!.automaticBackup!==false}" data-archive-auto><span></span></button></div><p>仅备份加密后的数据，解密在本机完成。服务器及未持有恢复凭证原图和密码的人无法解密。</p><p class="archive-backup-state" data-archive-auto-state role="status"></p><h3>已备份</h3><dl class="archive-backup-counts">${countLabels.map(([kind,label])=>`<div><dt>${label}</dt><dd data-archive-count="${kind}">正在读取</dd></div>`).join('')}</dl></section>`;
  }
  function bindAutomaticBackup(signal:AbortSignal):void {
    const card=o.root.querySelector<HTMLElement>('.archive-backup-card')!,button=card.querySelector<HTMLButtonElement>('[data-archive-auto]')!;
    const paint=()=>{
      const enabled=o.session.vault.roomArchiveV2!.automaticBackup!==false;
      button.setAttribute('aria-checked',String(enabled));
      card.querySelector('[data-archive-auto-state]')!.textContent=enabled?'本浏览器在联网、解锁时自动备份。':'自动备份已关闭，已有备份仍然保留。';
    };
    let reading=false,refreshAgain=false;
    const refresh=()=>{
      if(signal.aborted||!active()||!card.isConnected)return;
      if(reading){refreshAgain=true;return;}
      reading=true;card.setAttribute('aria-busy','true');
      void readRoomArchiveCounts(o.session,signal).then(counts=>{
        if(signal.aborted||!active()||!card.isConnected)return;
        for(const [kind] of countLabels)card.querySelector(`[data-archive-count="${kind}"]`)!.textContent=counts[kind].toLocaleString();
      }).catch(cause=>{
        if(signal.aborted||!active()||!card.isConnected)return;
        if(cause instanceof DOMException&&cause.name==='AbortError'){refreshAgain=true;return;}
        for(const node of card.querySelectorAll('[data-archive-count]'))node.textContent='暂不可用';
      }).finally(()=>{reading=false;card.removeAttribute('aria-busy');if(refreshAgain){refreshAgain=false;queueMicrotask(refresh);}});
    };
    button.addEventListener('click',()=>protectTask(button,async()=>{
      const enabled=o.session.vault.roomArchiveV2!.automaticBackup===false;
      await changeArchive(signal,archive=>{archive.automaticBackup=enabled;});
      if(signal.aborted||!active())return;
      paint();o.backupChanged?.(enabled);refresh();
    }),{signal});
    o.root.addEventListener('archivebackupchange',refresh,{signal});paint();refresh();
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
      show(shell('正在完成密码修改','<p class="backup-intro">正在核对上次修改结果，请保持联网。新凭证已在本浏览器加密保留。</p><button class="primary-button" data-resume>继续完成修改</button>'));bindBack();
      const button=o.root.querySelector<HTMLButtonElement>('[data-resume]')!;const resume=()=>protectTask(button,async()=>{await resumeRotation(signal);if(active()&&!signal.aborted)card();});button.addEventListener('click',resume);resume();return;
    }
    const credential=archive.credential;
    if(!credential||editing){
      show(shell(editing?'修改凭证密码':'恢复凭证',`${editing?'':steps(1)}${editing?'':'<h2 class="archive-form-title">先设置凭证密码</h2>'}<p class="backup-intro">${editing?'输入原密码后设置新密码。修改成功后，需要重新保存并验证新凭证。':'凭证密码仅用于本浏览器加密，不上传服务器。完成密码设置、导出和原图回验后，隐私引导才会显示「已设置」。'}</p><form class="archive-password-form" data-card-form autocomplete="off" novalidate>${editing?field('original','原凭证密码','输入当前凭证密码','current-password'):''}${field('password',editing?'新凭证密码':'凭证密码','12–128 个字符')}${field('confirm','确认凭证密码','再次输入凭证密码')}<p class="archive-inline-error" data-archive-error role="alert"></p><p class="archive-form-note">凭证密码与应用锁独立，请分开保管。</p><button class="primary-button" type="submit">${editing?'保存新密码':'下一步：导出凭证'}</button></form>`));
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
          await o.verify();requiresOperationProof=true;if(signal.aborted||!active())return;
          // Ensure an empty archive is registered before rotating its read authority.
          await o.sync();if(signal.aborted||!active())return;
          const key={...archive.key,readToken:toBase64Url(crypto.getRandomValues(new Uint8Array(32)))},expected=archiveAccessHash(archiveAccessToken(archive.key)),next=archiveAccessHash(key.readToken);
          const envelope=await protectArchiveCard(key,password),proof=archiveAccessProof(archive.key,o.session.vault.roomId,o.session.vault.identity.publicBundle.deviceId,expected,next);
          await changeArchive(signal,current=>{if(current.credential!==credential)throw new Error('凭证状态已改变');if(current.rotation)throw new Error('上次修改尚未完成，请先继续完成');current.cardVerified=false;current.exported=false;current.rotation={key,credential:envelope,expected,next,proof};});
          try{await resumeRotation(signal);}catch(cause){if(active()&&!signal.aborted)card();throw cause;}
        }else{
          const envelope=await protectArchiveCard(archive.key,password);if(signal.aborted||!active())return;await saveCredential(envelope,signal);
        }
        form.reset();if(!signal.aborted&&active()){exportPage();}
      });});return;
    }

    if(!archive.cardVerified){if(archive.exported)verifySaved(credential);else exportPage();return;}
    requiresOperationProof=true;
    show(shell('恢复凭证',`<div class="archive-managed-status">${icon(Check)}<h2>凭证已设置</h2><p>已保存并验证，可用于找回聊天记录。</p></div><div class="backup-settings-group"><button class="archive-entry" data-change-password>${icon(KeyRound)}<span>修改凭证密码<small>需要当前凭证密码</small></span><b>›</b></button><button class="archive-entry" data-download>${icon(Download)}<span>导出凭证<small>保存当前恢复凭证原图</small></span><b>›</b></button></div>${automaticBackupCard()}<p class="archive-inline-error" data-archive-error role="alert"></p>`));
    bindBack(o.startWithCredential?leave:settings);
    bindAutomaticBackup(signal);
    o.root.querySelector('[data-change-password]')!.addEventListener('click',()=>card(true));
    o.root.querySelector<HTMLButtonElement>('[data-download]')!.addEventListener('click',event=>protectTask(event.currentTarget as HTMLButtonElement,async()=>{
      await o.verify();if(signal.aborted||!active())return;
      const blob=await createArchiveCardImage(credential,o.name());if(signal.aborted||!active())return;await o.saveImage(blob);
    }));
  }
  function exportPage(){
    const signal=begin(),credential=o.session.vault.roomArchiveV2!.credential!;
    show(shell('导出恢复凭证',`${steps(2)}<h2 class="archive-form-title">保存凭证原图</h2><p class="backup-intro">请保存原图，并单独保管凭证密码。</p><figure class="archive-image-preview" aria-label="恢复凭证原图"><img data-card-image alt="${escape(o.name())}的恢复凭证，内容与导出原图一致"><p data-card-loading role="status">正在准备凭证…</p></figure><p class="archive-inline-error" data-archive-error role="alert"></p><div class="archive-card-actions"><button class="primary-button" data-download type="button">${icon(Download)}导出凭证</button>${o.session.vault.roomArchiveV2!.exported?'<button class="secondary-button" data-verify-saved type="button">回验已保存的原图</button>':''}</div>`));
    o.root.querySelector('main')!.classList.add('archive-credential-page');bindBack(o.startWithCredential?leave:settings);
    let blob:Blob|undefined,url:string|undefined;
    signal.addEventListener('abort',()=>{if(url)URL.revokeObjectURL(url);blob=undefined;},{once:true});
    const ready=createArchiveCardImage(credential,o.name()).then(generated=>{if(signal.aborted||!active())return;blob=generated;url=URL.createObjectURL(blob);o.root.querySelector<HTMLImageElement>(':scope > .archive-page [data-card-image]')!.src=url;o.root.querySelector(':scope > .archive-page [data-card-loading]')?.remove();});
    void ready.catch(report);
    o.root.querySelector('[data-verify-saved]')?.addEventListener('click',()=>verifySaved(credential));
    o.root.querySelector<HTMLButtonElement>('[data-download]')!.addEventListener('click',event=>protectTask(event.currentTarget as HTMLButtonElement,async()=>{
      await ready;if(!blob||signal.aborted||!active())return;
      if(requiresOperationProof){await o.verify();if(signal.aborted||!active())return;}
      await o.saveImage(blob);if(signal.aborted||!active())return;
      await changeArchive(signal,current=>{current.exported=true;});if(signal.aborted||!active())return;verifySaved(credential);
    }));
  }
  const selectionMarkup=()=>`<label class="archive-upload archive-upload-main">${icon(Upload)}<strong data-upload-title>选择凭证原图</strong><input name="image" type="file" accept="image/png" required></label><div class="archive-selected" hidden><img alt="所选凭证预览"><div><strong data-card-label></strong><p data-selected-status role="status"></p></div></div>`;
  function selection(form:HTMLFormElement,signal:AbortSignal,selected:(text:string|undefined)=>void){
    let attempt=0,url:string|undefined;
    const button=form.querySelector<HTMLButtonElement>('button[type=submit]')!,upload=form.querySelector<HTMLElement>('.archive-upload')!;
    bindFile(form.querySelector('input[type=file]')!,signal,file=>{
      const id=++attempt;selected(undefined);button.disabled=true;upload.hidden=false;if(url)URL.revokeObjectURL(url);url=undefined;
      form.querySelector<HTMLElement>('.archive-selected')!.hidden=true;form.querySelector<HTMLElement>('[data-archive-error]')!.textContent='';
      if(!file)return;if(file.size>4*1024*1024||file.type!=='image/png'){report(new Error('请选择 4 MB 以内的 PNG 凭证原图'));return;}
      upload.setAttribute('aria-busy','true');
      const reader=new FileReader(),abort=()=>reader.abort();signal.addEventListener('abort',abort,{once:true});reader.onloadend=()=>{signal.removeEventListener('abort',abort);upload.removeAttribute('aria-busy');};
      reader.onerror=()=>{if(id===attempt&&!signal.aborted){report(new Error('图片读取失败，请重新选择'));}};
      reader.onload=()=>void(async()=>{try{
        const image=new Blob([reader.result as ArrayBuffer],{type:'image/png'}),text=await readArchiveCardImage(image),label=await archiveCardLabel(image);
        if(id!==attempt||signal.aborted||!active())return;
        selected(text);upload.hidden=true;url=URL.createObjectURL(image);form.querySelector<HTMLImageElement>('.archive-selected img')!.src=url;form.querySelector<HTMLElement>('.archive-selected')!.hidden=false;
        form.querySelector('[data-card-label]')!.textContent=file.name||label||'恢复凭证原图';form.querySelector('[data-selected-status]')!.textContent='图片已就绪 · 等待密码验证';button.disabled=false;
      }catch(cause){if(id===attempt&&!signal.aborted){report(cause);}}})();reader.readAsArrayBuffer(file);
    });
    signal.addEventListener('abort',()=>{attempt++;selected(undefined);form.reset();if(url)URL.revokeObjectURL(url);},{once:true});
  }
  function verifySaved(credential:string){
    const signal=begin();let envelope:string|undefined;
    show(shell('回验凭证原图',`${steps(3)}<h2 class="archive-form-title">确认凭证真的可用</h2><p class="backup-intro">选择刚保存的原图，并输入对应的凭证密码。</p><form data-verify novalidate><div class="archive-material-card">${selectionMarkup()}${field('password','凭证密码','输入这张凭证的密码','off')}</div><p class="archive-inline-error" data-archive-error role="alert"></p><button class="primary-button" type="submit" disabled>验证凭证</button></form>`));
    bindBack(exportPage);const form=o.root.querySelector<HTMLFormElement>('[data-verify]')!;eyes(form,signal);selection(form,signal,text=>{envelope=text;});
    form.addEventListener('submit',event=>{event.preventDefault();protectTask(form.querySelector<HTMLButtonElement>('button[type=submit]')!,async()=>{
      if(!envelope)throw new Error('请选择刚保存的凭证原图');if(envelope!==credential)throw new Error('这不是本次导出的凭证，请重新选择');
      const key=await unlockArchiveCard(envelope,(form.elements.namedItem('password') as HTMLInputElement).value);
      if(signal.aborted||!active())return;if(key.descriptor.id!==o.session.vault.roomArchiveV2!.key.descriptor.id)throw new Error('这张凭证不属于当前密室');
      await saveCredential(credential,signal,true);if(signal.aborted||!active())return;card();o.notice('凭证已保存并验证');
    });});
  }
  function restore(){
    const signal=begin();let envelope:string|undefined;
    show(shell('聊天记录恢复',`<h2 class="archive-form-title">找回你的聊天记录</h2><p class="backup-intro">选择凭证原图，输入对应密码。恢复的历史仅自己可见。</p><form data-restore-form novalidate><div class="archive-material-card">${selectionMarkup()}${field('password','凭证密码','输入这张凭证的密码','off')}</div><p class="archive-inline-error" data-archive-error role="alert"></p><button class="primary-button" data-restore-submit type="submit" disabled>恢复聊天记录</button></form>`));
    bindBack(o.startWithRestore?leave:settings);const form=o.root.querySelector<HTMLFormElement>('form')!;eyes(form,signal);selection(form,signal,text=>{envelope=text;});
    form.addEventListener('submit',event=>{event.preventDefault();if(!envelope)return;protectTask(form.querySelector<HTMLButtonElement>('[data-restore-submit]')!,async()=>{
      const key=await unlockArchiveCard(envelope!,(form.elements.namedItem('password') as HTMLInputElement).value);if(signal.aborted||!active())return;
      (form.elements.namedItem('password') as HTMLInputElement).value='';(document.activeElement as HTMLElement|null)?.blur();await runRestore(key);
    });});
  }
  async function runRestore(key:Parameters<typeof restoreRoomArchive>[1]){
    const pageSignal=begin(),abort=new AbortController(),signal=AbortSignal.any([pageSignal,abort.signal]);let complete=false,failed=false;
    const kinds=[['messages','聊天记录',MessageSquare],['images','图片',Image],['videos','视频',Video],['files','文件',FileText],['audio','语音',AudioLines]] as const;
    show(shell('聊天记录恢复',`<div class="archive-restoration-symbol">${icon(Download)}</div><h2 data-progress-title>正在恢复</h2><p data-progress role="status">正在读取备份目录…</p><progress max="100" aria-label="恢复进度"></progress><dl class="archive-restore-details">${kinds.map(([id,label,symbol])=>`<div>${icon(symbol)}<dt>${label}</dt><dd data-count="${id}">0 / 统计中</dd></div>`).join('')}</dl><p class="archive-inline-note" data-progress-note>正在本机校验，完成后统一显示。</p><button class="secondary-button" data-finish type="button">取消恢复</button><button class="text-button" data-again type="button" hidden>重新选择凭证</button>`));
    const page=o.root.querySelector<HTMLElement>(':scope > .archive-page')!;
    const cancel=()=>{if(complete){leave();return;}if(failed){restore();return;}showExplanation(o.root,'取消本次恢复？',['尚未完成的内容不会导入。你可以稍后使用同一凭证重新恢复。'],{signal:pageSignal,active,closeLabel:'继续恢复',action:{label:'取消恢复',closeBeforeRun:true,run:async()=>{abort.abort();restore();}}});};
    bindBack(cancel);page.querySelector('[data-finish]')!.addEventListener('click',()=>{if(failed)void runRestore(key);else cancel();});page.querySelector('[data-again]')!.addEventListener('click',restore);
    const update=(state:ArchiveRestoreProgress)=>{
      if(signal.aborted||!active()||!page.isConnected)return;const progress=page.querySelector('progress')!;
      if(state.stage==='complete')progress.value=100;else if(state.stage!=='reading'&&state.totalObjects>0)progress.value=Math.min(99,Math.floor(state.objects/state.totalObjects*100));else progress.removeAttribute('value');
      page.querySelector('[data-progress]')!.textContent=state.stage==='reading'?'正在读取备份目录…':state.stage==='committing'?'正在整理并保存记录…':state.stage==='complete'?'聊天记录和原文件已恢复':state.totalObjects>0?`正在校验内容 · ${progress.value}%`:`正在校验内容 · 已读取 ${state.objects} 项`;
      for(const [id]of kinds)page.querySelector(`[data-count="${id}"]`)!.textContent=state.totals?`${state[id]} / ${state.totals[id]}`:`${state[id]} / 统计中`;
    };
    try{await restoreRoomArchive(o.session,key,signal,()=>{},update);if(signal.aborted||!active())return;complete=true;o.restored();page.querySelector('[data-progress-title]')!.textContent='恢复完成';page.querySelector('[data-progress-note]')!.textContent='已保存到当前密室，仅自己可见。';}
    catch(cause){if(signal.aborted||!active())return;failed=true;page.querySelector('[data-progress-title]')!.textContent='恢复未完成';page.querySelector('[data-progress]')!.textContent='恢复已暂停';report(cause);page.querySelector('[data-progress-note]')!.textContent='尚未导入不完整记录，可以重新尝试。';}
    finally{if(page.isConnected&&(complete||failed)){page.querySelector('[data-finish]')!.textContent=complete?'回聊天查看':'重新尝试';(page.querySelector('[data-again]') as HTMLElement).hidden=!failed;}}
  }
  if(o.startWithCredential)card();else if(o.startWithRestore)restore();else settings();
}
