import {createElement,Upload,KeyRound,Download} from 'lucide';
import { createArchiveCardImage, readArchiveCardImage } from './archive-card-image';
import { protectArchiveCard, unlockArchiveCard } from './room-archive-crypto';
import { restoreRoomArchive } from './room-archive';
import { saveVault, withVaultMutation, loadPrivateArchiveItems, type VaultSession } from './vault';
import { showExplanation } from './explanation-dialog';

type Options = {root:HTMLElement;session:VaultSession;signal:AbortSignal;active:()=>boolean;notice:(text:string,error?:boolean)=>void;back:()=>void;sync:()=>Promise<void>;restored:()=>void;beginPick:()=>boolean;finishPick:()=>Promise<boolean>;saveImage:(blob:Blob)=>Promise<void>};
export function mountArchiveSettings(o:Options):void {
  let pageAbort:AbortController|undefined;
  const begin=()=>{pageAbort?.abort();pageAbort=new AbortController();return AbortSignal.any([o.signal,pageAbort.signal]);};
  const active=()=>o.active()&&!o.signal.aborted;
  const shell=(title:string,content:string)=>`<main class="backup-page"><header class="subpage-header backup-header"><button class="icon-button" id="archive-back" data-back type="button" aria-label="返回">‹</button><div class="backup-heading"><h1>${title}</h1></div><span class="backup-header-spacer" aria-hidden="true"></span></header><section class="backup-content">${content}</section></main>`;
  const report=(cause:unknown)=>{if(active())o.notice(cause instanceof Error?cause.message:'操作未完成，请重试',true);};
  function bindHelp(signal:AbortSignal) {
    const button=document.createElement('button');button.className='text-button';button.type='button';button.dataset.archiveHelp='';
    button.textContent='忘记恢复口令？';o.root.querySelector('.backup-content')!.append(button);
    button.addEventListener('click',()=>showExplanation(o.root,'没有可用的恢复口令',[
      '恢复图片和对应的恢复口令缺一不可，服务器无法重置口令或解密图片。',
      '若原密室在本机仍能解锁，可进入那个密室重新保存恢复图片，并设置新的口令。这里生成的图片只对应当前密室的归档。',
      '重新保存不会让以前的恢复图片失效。请妥善保管旧图片及其口令。',
    ],{signal,active}));
  }
  const protectTask=(button:HTMLButtonElement,task:()=>Promise<void>)=>{
    if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');
    void task().catch(report).finally(()=>{if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy');}});
  };
  function bindFileInputs(signal:AbortSignal) {
    for(const input of o.root.querySelectorAll<HTMLInputElement>('input[type=file]')) {
      input.addEventListener('click',event=>{if(!o.beginPick())event.preventDefault();},{signal});
      const finish=async()=>{if(await o.finishPick()||signal.aborted||!active())input.value='';};
      input.addEventListener('change',()=>void finish(),{signal});
      input.addEventListener('cancel',()=>void finish(),{signal});
    }
  }
  function settings() {
    if(!active())return;const signal=begin();
    o.root.innerHTML=shell('备份与恢复',`<p class="backup-intro">记录和原图片自动加密备份。恢复图片只由你保管，恢复口令用于保护图片中的恢复材料。</p><div class="backup-settings-group"><section class="backup-setting"><div class="backup-setting-copy"><span class="backup-setting-icon" aria-hidden="true">${createElement(Upload).outerHTML}</span><div><h2>自动备份</h2><p data-archive-status>正在读取备份状态…</p></div></div><button class="secondary-button" data-sync>立即备份</button></section><section class="backup-setting"><div class="backup-setting-copy"><span class="backup-setting-icon" aria-hidden="true">${createElement(KeyRound).outerHTML}</span><div><h2>恢复图片</h2><p>${o.session.vault.roomArchiveV2?.cardVerified?'已保存并验证':'尚未保存，清除浏览器数据后可能无法恢复记录'}</p></div></div><button class="secondary-button" data-card>保存恢复图片</button></section><section class="backup-setting"><div class="backup-setting-copy"><span class="backup-setting-icon" aria-hidden="true">${createElement(Download).outerHTML}</span><div><h2>恢复到当前密室</h2><p>历史仅在本机展示，合并到你的当前备份，不发给对方。</p></div></div><button class="secondary-button" data-restore>恢复聊天记录</button></section></div>`);
    const status=o.root.querySelector<HTMLElement>('[data-archive-status]')!;
    void loadPrivateArchiveItems(o.session).then(items=>{if(!status.isConnected)return;const state=o.session.vault.archiveState;
      const complete=!!state?.completeAt&&!state.pending&&!state.preparing&&state.cursor>=o.session.vault.lastSeq&&(state.privateDone?.length??0)>=items.length;
      status.textContent=complete?`当前记录及原文件已备份 · ${new Date(state!.completeAt!).toLocaleString()}`:'部分记录或原文件尚未完成备份，请保持联网并解锁';
    }).catch(report);
    o.root.querySelector('[data-back]')!.addEventListener('click',()=>{pageAbort?.abort();o.back();});
    o.root.querySelector<HTMLButtonElement>('[data-sync]')!.addEventListener('click',event=>protectTask(event.currentTarget as HTMLButtonElement,async()=>{await o.sync();if(!signal.aborted&&active())settings();}));
    o.root.querySelector('[data-card]')!.addEventListener('click',card);
    o.root.querySelector('[data-restore]')!.addEventListener('click',restore);
  }
  function card() {
    const signal=begin();let imageUrl:string|undefined,imageBlob:Blob|undefined;
    signal.addEventListener('abort',()=>{if(imageUrl)URL.revokeObjectURL(imageUrl);},{once:true});
    o.root.innerHTML=shell('保存恢复图片',`<p class="backup-intro">设置至少 12 个字符的独立恢复口令。图片和口令都要保留，口令不会上传。</p><form class="backup-settings-group" data-card-form novalidate><label class="passkey-name-field">恢复口令<input name="password" type="password" autocomplete="new-password" maxlength="128" required></label><label class="passkey-name-field">再次输入<input name="confirm" type="password" autocomplete="new-password" maxlength="128" required></label><button class="primary-button" type="submit">生成恢复图片</button></form><section data-save hidden><p class="backup-intro">先保存原图，再选择刚保存的图片并输入口令进行验证。</p><a class="primary-button" data-download download="聊天归档恢复卡.png">保存恢复图片</a><img data-preview alt="已用恢复口令加密的归档恢复图片" style="width:100%;max-width:320px;display:block;margin:24px auto"><form data-verify novalidate><label class="passkey-name-field">选择已保存的恢复图片<input name="image" type="file" accept="image/png" required></label><label class="passkey-name-field">恢复口令<input name="password" type="password" autocomplete="off" maxlength="128" required></label><button class="primary-button" type="submit">验证已保存的图片</button></form></section>`);
    o.root.querySelector('[data-back]')!.addEventListener('click',settings);
    bindHelp(signal);
    bindFileInputs(signal);
    o.root.querySelector<HTMLAnchorElement>('[data-download]')!.addEventListener('click',event=>{event.preventDefault();if(imageBlob)void o.saveImage(imageBlob).catch(report);});
    const form=o.root.querySelector<HTMLFormElement>('[data-card-form]')!;
    form.addEventListener('submit',event=>{event.preventDefault();protectTask(form.querySelector('button')!,async()=>{
      const password=(form.elements.namedItem('password') as HTMLInputElement).value;
      if(password!==(form.elements.namedItem('confirm') as HTMLInputElement).value)throw new Error('两次输入的恢复口令不一致');
      const card=await protectArchiveCard(o.session.vault.roomArchiveV2!.key,password),blob=await createArchiveCardImage(card);
      if(signal.aborted||!active())return;form.reset();form.hidden=true;
      imageBlob=blob;imageUrl=URL.createObjectURL(blob);o.root.querySelector<HTMLAnchorElement>('[data-download]')!.href=imageUrl;
      o.root.querySelector<HTMLImageElement>('[data-preview]')!.src=imageUrl;o.root.querySelector<HTMLElement>('[data-save]')!.hidden=false;
    });});
    const verify=o.root.querySelector<HTMLFormElement>('[data-verify]')!;
    verify.addEventListener('submit',event=>{event.preventDefault();protectTask(verify.querySelector('button')!,async()=>{
      const file=(verify.elements.namedItem('image') as HTMLInputElement).files?.[0];if(!file)throw new Error('请选择刚保存的图片');
      const key=await unlockArchiveCard(await readArchiveCardImage(file),(verify.elements.namedItem('password') as HTMLInputElement).value);
      if(signal.aborted||!active())return;
      if(key.descriptor.id!==o.session.vault.roomArchiveV2!.key.descriptor.id)throw new Error('这张图片不属于当前密室的归档');
      await withVaultMutation(o.session,async lease=>{signal.throwIfAborted();const archive=o.session.vault.roomArchiveV2!,before=archive.cardVerified;archive.cardVerified=true;try{await saveVault(o.session,lease);}catch(cause){archive.cardVerified=before;throw cause;}});
      verify.reset();settings();o.notice('恢复图片已保存并验证');
    });});
  }
  function restore() {
    const signal=begin();
    o.root.innerHTML=shell('恢复聊天记录',`<p class="backup-intro">恢复内容归入当前密室，只有本机可见。无需对方同意，也不会向对方发送消息。</p><form data-restore-form novalidate><label class="passkey-name-field">恢复图片<input name="image" type="file" accept="image/png" required></label><label class="passkey-name-field">恢复口令<input name="password" type="password" autocomplete="off" maxlength="128" required></label><button class="primary-button" type="submit">恢复到本机</button><p class="backup-footnote" data-progress role="status"></p></form>`);
    o.root.querySelector('[data-back]')!.addEventListener('click',settings);
    bindHelp(signal);
    bindFileInputs(signal);
    const form=o.root.querySelector<HTMLFormElement>('form')!;
    form.addEventListener('submit',event=>{event.preventDefault();protectTask(form.querySelector('button')!,async()=>{
      const file=(form.elements.namedItem('image') as HTMLInputElement).files?.[0];if(!file)throw new Error('请选择恢复图片');
      const key=await unlockArchiveCard(await readArchiveCardImage(file),(form.elements.namedItem('password') as HTMLInputElement).value);
      if(signal.aborted||!active())return;(form.elements.namedItem('password') as HTMLInputElement).value='';
      const count=await restoreRoomArchive(o.session,key,signal,done=>{if(active()&&!signal.aborted)o.root.querySelector('[data-progress]')!.textContent=`已核验并暂存 ${done} 条记录及对应原文件…`;});
      if(signal.aborted||!active())return;o.restored();pageAbort?.abort();o.back();o.notice(`已在本机恢复 ${count} 条记录，正在合并到当前备份`);
    });});
  }
  settings();
}
