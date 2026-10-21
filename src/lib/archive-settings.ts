import { createElement, Upload, KeyRound, Download, ShieldCheck, Image, FileText, Video, AudioLines, MessageSquare } from 'lucide';
import QRCode from 'qrcode';
import { createArchiveCardImage, readArchiveCardImage } from './archive-card-image';
import { protectArchiveCard, unlockArchiveCard } from './room-archive-crypto';
import { restoreRoomArchive, type ArchiveRestoreProgress } from './room-archive';
import { saveVault, withVaultMutation, loadPrivateArchiveItems, type VaultSession } from './vault';
import { showExplanation } from './explanation-dialog';
import { mountDialog } from './dialog';
import { chamberBrand } from './entry-art';

type Options = { startWithCredential?: boolean; startWithRestore?: boolean; name:()=>string; verify:()=>Promise<void>; root:HTMLElement; session:VaultSession; signal:AbortSignal; active:()=>boolean; notice:(text:string,error?:boolean)=>void; back:()=>void; sync:()=>Promise<void>; restored:()=>void; beginPick:()=>boolean; finishPick:()=>Promise<boolean>; saveImage:(blob:Blob)=>Promise<void> };
const escape = (text:string) => text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const icon = (value:Parameters<typeof createElement>[0]) => createElement(value).outerHTML;
export function mountArchiveSettings(o:Options):void {
  let pageAbort:AbortController|undefined;
  const begin=()=>{pageAbort?.abort();pageAbort=new AbortController();return AbortSignal.any([o.signal,pageAbort.signal]);};
  const active=()=>o.active()&&!o.signal.aborted;
  const shell=(title:string,content:string)=>`<main class="backup-page archive-page"><header class="subpage-header backup-header"><button class="icon-button" id="archive-back" data-back type="button" aria-label="返回">‹</button><div class="backup-heading"><h1>${title}</h1></div><span class="backup-header-spacer" aria-hidden="true"></span></header><section class="backup-content">${content}</section></main>`;
  const report=(cause:unknown)=>{if(active()&&!(cause instanceof DOMException&&cause.name==='AbortError'))o.notice(cause instanceof Error?cause.message:'操作未完成，请重试',true);};
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
      '原密室仍能打开时，可在该密室的「恢复凭证」中修改密码并重新导出。',
      '旧凭证仍可配合旧密码使用。服务器无法找回密码。',
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
  function card(editing=false) {
    if(!active())return;const signal=begin(),archive=o.session.vault.roomArchiveV2!;
    const credential=archive.credential;
    if(!credential||editing){
      o.root.innerHTML=shell(editing?'修改凭证密码':'恢复凭证',`<div class="archive-intro-symbol" aria-hidden="true">${icon(KeyRound)}</div><h2 class="archive-form-title">${editing?'设置新的凭证密码':'为聊天记录留一份凭证'}</h2><p class="backup-intro">恢复时需要凭证原图和此密码。请使用与应用锁不同的长密码，密码不上传服务器。</p><form class="archive-password-form" data-card-form novalidate><label class="passkey-name-field">${editing?'新凭证密码':'凭证密码'}<input name="password" type="password" autocomplete="new-password" placeholder="12–128 个字符" maxlength="256" required></label><label class="passkey-name-field">确认凭证密码<input name="confirm" type="password" autocomplete="new-password" placeholder="再次输入 12–128 个字符的密码" maxlength="256" required></label>${editing?'<p class="archive-inline-note">修改后请重新导出。已保存的旧凭证仍可用旧密码恢复。</p>':''}<button class="primary-button" type="submit">${editing?'保存新密码':'生成恢复凭证'}</button></form>`);
      bindBack(editing?()=>card():o.startWithCredential?leave:settings);
      const form=o.root.querySelector<HTMLFormElement>('[data-card-form]')!;
      signal.addEventListener('abort',()=>form.reset(),{once:true});
      form.addEventListener('submit',event=>{event.preventDefault();protectTask(form.querySelector('button')!,async()=>{
        const password=(form.elements.namedItem('password') as HTMLInputElement).value;
        if(password!==(form.elements.namedItem('confirm') as HTMLInputElement).value)throw new Error('两次输入的凭证密码不一致');
        const envelope=await protectArchiveCard(o.session.vault.roomArchiveV2!.key,password);
        if(signal.aborted||!active())return;
        await saveCredential(envelope,signal);form.reset();if(!signal.aborted&&active()){card();o.notice(editing?'凭证密码已修改，请重新导出':'恢复凭证已设置，请导出保存');}
      });});return;
    }
    o.root.innerHTML=shell('恢复凭证',`<p class="backup-intro">用这张卡片和凭证密码，找回已备份的聊天记录。</p><article class="archive-credential-card"><div class="archive-card-brand">${chamberBrand()}<span>RECOVERY CREDENTIAL</span></div><h2 data-card-room-name>${escape(o.name())}</h2><p>聊天记录恢复凭证</p><div class="archive-qr-wrap"><canvas data-credential-qr aria-hidden="true"></canvas><span>${icon(ShieldCheck)}<b>已隐藏二维码</b><small>验证应用锁后导出完整凭证</small></span></div><div class="archive-card-status" data-card-status>${archive.cardVerified?'已保存并验证':'已设置 · 请导出并验证原图'}</div></article><div class="archive-card-actions"><button class="primary-button" data-download type="button">${icon(Download)}导出凭证</button><button class="secondary-button" data-change-password type="button">修改凭证密码</button></div><p class="archive-inline-note">凭证图片与密码请分开保管。密室改名后，重新导出即可更新卡片名称。</p><button class="text-button" data-sync type="button">立即备份聊天记录</button>`);
    bindBack(o.startWithCredential?leave:settings);bindHelp(signal);
    // A non-capability preview is deliberately used under the blur; a full card
    // is created only after fresh authorization, never left in a hidden DOM node.
    void QRCode.toCanvas(o.root.querySelector<HTMLCanvasElement>('[data-credential-qr]')!,`Chamber preview ${archive.key.descriptor.id}`,{width:200,margin:2,color:{dark:'#21382a',light:'#f5f7f5'}}).catch(report);
    o.root.querySelector<HTMLButtonElement>('[data-sync]')!.addEventListener('click',event=>protectTask(event.currentTarget as HTMLButtonElement,o.sync));
    o.root.querySelector<HTMLButtonElement>('[data-change-password]')!.addEventListener('click',event=>protectTask(event.currentTarget as HTMLButtonElement,async()=>{await o.verify();if(!signal.aborted&&active())card(true);}));
    o.root.querySelector<HTMLButtonElement>('[data-download]')!.addEventListener('click',event=>protectTask(event.currentTarget as HTMLButtonElement,async()=>{
      await o.verify();if(signal.aborted||!active())return;
      const blob=await createArchiveCardImage(credential,o.name());if(signal.aborted||!active())return;
      await o.saveImage(blob);if(!signal.aborted&&active())verifySaved(signal,credential);
    }));
  }
  function verifySaved(signal:AbortSignal,credential:string){
    const sheet=document.createElement('section');sheet.className='confirm-overlay archive-verification-overlay';sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label','验证已保存的凭证');
    sheet.innerHTML='<div class="confirm-dialog archive-dialog"><h2>确认凭证已保存</h2><p>选择刚保存的原图，验证后即可放心保管。</p><form data-verify novalidate><label class="archive-upload">选择凭证原图<input name="image" type="file" accept="image/png" required></label><label class="passkey-name-field">凭证密码<input name="password" type="password" autocomplete="off" placeholder="输入这张凭证的密码" required></label><button class="primary-button" type="submit">验证已保存的凭证</button></form><button class="text-button" data-close type="button">稍后验证</button></div>';
    o.root.append(sheet);const form=sheet.querySelector<HTMLFormElement>('form')!;
    const dialog=mountDialog(sheet,{signal,isActive:active,onClose:()=>form.reset()});
    sheet.querySelector('[data-close]')!.addEventListener('click',()=>dialog.close());
    bindFile(form.querySelector('input[type=file]')!,signal,()=>{});
    form.addEventListener('submit',event=>{event.preventDefault();protectTask(form.querySelector('button')!,async()=>{
      const file=(form.elements.namedItem('image') as HTMLInputElement).files?.[0];if(!file)throw new Error('请选择刚保存的凭证原图');
      const text=await readArchiveCardImage(file);if(text!==credential)throw new Error('这不是本次导出的凭证，请重新选择');
      const key=await unlockArchiveCard(text,(form.elements.namedItem('password') as HTMLInputElement).value);
      if(signal.aborted||!active()||!sheet.isConnected)return;
      if(key.descriptor.id!==o.session.vault.roomArchiveV2!.key.descriptor.id)throw new Error('这张凭证不属于当前密室');
      await saveCredential(credential,signal,true);dialog.dispose();card();o.notice('凭证已保存并验证');
    });});
  }
  function restore() {
    const signal=begin();let selected:File|undefined;
    o.root.innerHTML=shell('聊天记录恢复',`<p class="backup-intro">上传凭证原图，将已备份的记录恢复到当前密室。恢复内容仅自己可见。</p><form data-restore-form novalidate><label class="archive-upload archive-upload-main">${icon(Upload)}<strong data-upload-title>上传恢复凭证</strong><span>选择已保存的 PNG 原图</span><input name="image" type="file" accept="image/png" required></label><button class="primary-button" data-restore-submit type="submit" disabled>恢复聊天记录</button></form>`);
    bindBack(o.startWithRestore?leave:settings);
    const form=o.root.querySelector<HTMLFormElement>('form')!,button=form.querySelector<HTMLButtonElement>('button')!;
    bindFile(form.querySelector('input')!,signal,file=>{selected=file;button.disabled=!file;form.querySelector('[data-upload-title]')!.textContent=file?.name??'上传恢复凭证';});
    signal.addEventListener('abort',()=>{selected=undefined;form.reset();},{once:true});
    form.addEventListener('submit',event=>{event.preventDefault();if(!selected)return;const file=selected;protectTask(button,async()=>{
      const envelope=await readArchiveCardImage(file);if(signal.aborted||!active())return;
      const sheet=document.createElement('section');sheet.className='confirm-overlay archive-password-overlay';sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label','验证凭证密码');
      sheet.innerHTML='<div class="confirm-dialog archive-dialog"><h2>输入凭证密码</h2><p>使用生成这张凭证时设置的密码。</p><form data-unlock-card novalidate><label class="passkey-name-field">凭证密码<input name="password" type="password" autocomplete="off" placeholder="输入凭证密码" required></label><button class="primary-button" type="submit">验证并恢复</button></form><button class="text-button" data-cancel type="button">取消</button></div>';
      o.root.append(sheet);const passwordForm=sheet.querySelector<HTMLFormElement>('form')!;
      const dialog=mountDialog(sheet,{signal,isActive:active,onClose:()=>passwordForm.reset()});
      sheet.querySelector('[data-cancel]')!.addEventListener('click',()=>dialog.close());
      passwordForm.addEventListener('submit',e=>{e.preventDefault();protectTask(passwordForm.querySelector('button')!,async()=>{
        const key=await unlockArchiveCard(envelope,(passwordForm.elements.namedItem('password') as HTMLInputElement).value);
        if(signal.aborted||!active()||!sheet.isConnected)return;
        passwordForm.reset();dialog.dispose();await runRestore(key,signal);
      });});
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
      if(state.stage==='complete')progress.value=100;else if(state.totalObjects>0)progress.value=Math.min(99,Math.floor(state.objects/state.totalObjects*100));else progress.removeAttribute('value');
      sheet.querySelector('[data-progress]')!.textContent=state.stage==='reading'?'正在读取备份目录…':state.stage==='committing'?'正在整理并保存记录…':state.stage==='complete'?'聊天记录和原文件已恢复':state.totalObjects>0?`正在校验内容 · ${progress.value}%`:`正在校验内容 · 已读取 ${state.objects} 项`;
      for(const [id]of kinds)sheet.querySelector(`[data-count="${id}"]`)!.textContent=String(state[id]);
    };
    try{await restoreRoomArchive(o.session,key,signal,()=>{},update);if(signal.aborted||!active())return;complete=true;o.restored();sheet.querySelector('[data-progress-title]')!.textContent='恢复完成';sheet.querySelector('[data-progress-note]')!.textContent='已保存到当前密室，仅自己可见。自动备份将在联网时继续。';}
    catch(cause){if(signal.aborted||!active())return;failed=true;sheet.querySelector('[data-progress-title]')!.textContent='恢复未完成';sheet.querySelector('[data-progress]')!.textContent=cause instanceof Error?cause.message:'请检查网络后重试';sheet.querySelector('[data-progress-note]')!.textContent='尚未导入任何不完整记录。关闭后可重新恢复。';}
    finally{if(sheet.isConnected&&(complete||failed))sheet.querySelector('[data-finish]')!.textContent=complete?'完成':'关闭并重试';}
  }
  if(o.startWithCredential)card();else if(o.startWithRestore)restore();else settings();
}
