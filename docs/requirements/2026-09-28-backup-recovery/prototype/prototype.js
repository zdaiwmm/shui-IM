// Presentation-only simulation. Native file chooser reads the name only; no file content, network, storage or cryptography.
const app = document.querySelector('#app');
const state = { page:'backup', enabled:false, consent:false, synced:false, scenario:'normal', role:'creator', offline:false, locked:false, source:'cloud', task:null, timer:null, ticks:0, failed:false, supplemented:false, notice:'', cloudState:'off', cloudTimer:null, cloudFailed:false, fileName:'' };
const btn = (id, text, kind='primary') => `<button data-action="${id}" class="${kind}">${text}</button>`;
const row = (label, value) => `<div class="item"><span>${label}</span><strong>${value}</strong></div>`;
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function announce(text) { document.querySelector('#announcement').textContent=text; }
function stop() { clearTimeout(state.timer); state.timer=null; }
function page(name) { announce(''); state.page=name; render(); }
function reset() {
  clearTimeout(state.cloudTimer); closePrivacy(); stop(); announce(''); Object.assign(state,{page:'backup',enabled:state.scenario==='existing',consent:false,synced:state.scenario==='existing',task:null,ticks:0,failed:false,supplemented:false,notice:'',locked:false,cloudState:state.scenario==='existing'?'done':'off',cloudFailed:false,fileName:''}); render();
}
const sheet = document.querySelector('#privacy-sheet');
const filePicker = document.querySelector('#backup-file');
let sheetReturn = null;
function closePrivacy() { if(sheet.open)sheet.close(); state.consent=false; }
function openPrivacy(readOnly=false) {
  sheetReturn=document.activeElement;
  state.consent=!readOnly;
  sheet.innerHTML=`<div class="sheet-handle" aria-hidden="true"></div><header class="sheet-heading"><h2 id="privacy-title">${readOnly?'关于云端备份':'开启云端备份'}</h2><button class="sheet-close" aria-label="关闭">×</button></header>
    <div class="sheet-body"><p class="sheet-intro">记录先在你的设备上加密，再存到云端。<strong>平台无法直接读取聊天内容。</strong></p>
    <ul class="privacy-points"><li><strong>请保管好恢复码</strong><span>换设备时用它找回记录。泄露可能让他人看到备份，丢失后平台也无法帮你解开。</span></li><li><strong>打开页面时自动备份</strong><span>需要联网并解锁，不影响你继续使用。关闭后暂停。</span></li></ul>
    <details><summary>还有哪些需要了解？</summary><p>平台仍能看到备份时间、大小，以及对应的空间和设备。照片、语音、文件能否找回，还取决于云端原文件是否保留。</p><p>只备份这个空间里你自己的记录，不改变对方的设置。其他离线设备联网后才同步设置。</p><p>关闭开关不会删除已有备份。用于找回私密空间的加密身份信息仍会保留，但不再备份新聊天。</p></details></div>
    <footer class="sheet-actions">${btn(readOnly?'close-privacy':'enable',readOnly?'知道了':'同意并开启')}${readOnly?'':btn('close-privacy','暂不开启','text full')}</footer>`;
  sheet.querySelector('.sheet-close').onclick=closePrivacy;
  sheet.querySelectorAll('[data-action]').forEach(el=>el.onclick=()=>action(el.dataset.action));
  sheet.showModal();
}
sheet.addEventListener('click',event=>{if(event.target===sheet){const box=sheet.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)closePrivacy();}});
sheet.addEventListener('close',()=>{state.consent=false;if(sheetReturn?.isConnected)sheetReturn.focus();});
function updateCloudStatus() {
  const status=app.querySelector('#cloud-status');
  if(status)status.textContent=cloudStatus();
  const retry=app.querySelector('[data-action="cloud-retry"]');
  if(retry)retry.hidden=!['error','quota'].includes(state.cloudState);
}
function cloudStatus() {
  if(!state.enabled)return '';
  if(state.offline)return '等待联网后自动备份';
  return {working:'正在自动备份…',done:'上次备份：今天 14:32',paused:'已暂停，解锁后自动继续',error:'暂未备份成功，请重试',quota:'云端空间不足，可先下载到本地'}[state.cloudState]||'准备自动备份…';
}
function startCloudBackup() {
  clearTimeout(state.cloudTimer);
  if(!state.enabled)return;
  if(state.offline||state.locked){state.cloudState='paused';updateCloudStatus();return;}
  state.cloudState='working';updateCloudStatus();
  state.cloudTimer=setTimeout(()=>{
    if(!state.enabled||state.locked||state.offline)return;
    if(state.scenario==='quota')state.cloudState='quota';
    else if(state.scenario==='failure'&&!state.cloudFailed){state.cloudFailed=true;state.cloudState='error';}
    else {state.cloudState='done';state.synced=true;}
    updateCloudStatus();
  },2800);
}
function chooseLocalFile() {
  if(state.task?.kind==='restore'){state.notice='已有一项恢复任务，请先查看进度或取消后再开始新的恢复。';render();return;}
  filePicker.value='';filePicker.click();
}
filePicker.addEventListener('change',()=>{
  const selected=filePicker.files?.[0];if(!selected)return;
  state.source='local';state.supplemented=false;state.fileName=selected.name;
  filePicker.value='';page('auth');
});
function shell(title, body, back='settings') {
  app.dataset.page=state.page;
  app.innerHTML=`<header class="app-header">${btn(back,'‹','glass-control')}<div><strong>${title}</strong><small>山间小屋</small></div><span></span></header><div class="content">${body}</div>`;
  app.querySelector('.app-header button').setAttribute('aria-label','返回');
  app.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click',()=>action(el.dataset.action)));
  app.querySelector('#cloud-switch')?.addEventListener('change',event=>{
    if(state.enabled){clearTimeout(state.cloudTimer);state.enabled=false;state.cloudState='off';state.notice='已关闭，已有备份仍可恢复。';render();}
    else {event.target.checked=false;openPrivacy();}
  });
  app.querySelector('#code-form')?.addEventListener('submit',event=>{
    event.preventDefault();const value=app.querySelector('textarea').value.trim();
    if(value!=='DEMO-ONLY'){app.querySelector('.form-error').textContent='原型仅接受 DEMO-ONLY，请勿输入真实恢复码。';return;}
    if(state.page==='legacy'){state.supplemented=true;page('preview');return;}
    inspect();
  });
}
function render() {
  if(state.locked){shell('已锁定',`<div class="state-icon">○</div><h2>内容已隐藏</h2><p class="lede">解锁后可以继续刚才的操作。</p>${state.task?'<p class="subtle">当前任务已暂停，已完成的部分会保留。</p>':''}<div class="actions">${btn('unlock','模拟验证并解锁')}${btn('stay-locked','取消验证','text full')}</div>`,'stay-locked');return;}
  if(state.page==='settings'){shell('设置',`<p class="step-label">当前私密空间</p>${btn('backup','备份数据　›','choice')}${btn('restore','恢复数据　›','choice')}<p class="footnote">备份与恢复针对当前私密空间中的本人数据。</p>`,'backup');return;}
  if(state.page==='backup') {
    shell('备份数据',`<p class="lede compact-lede">给聊天留份备份，换设备也能找回。</p>
      <section class="section"><h3>下载到本地</h3><p>保存一份备份文件，由你自己保管。</p>${btn('export','下载备份文件','secondary')}</section>
      <section class="section"><div class="row"><div><h3>自动加密备份到云端</h3></div><label class="switch"><input id="cloud-switch" type="checkbox" role="switch" aria-label="自动加密备份到云端" ${state.enabled?'checked':''}><i></i></label></div>
      <p>自动保存新记录，平台无法直接读取聊天内容。</p>
      ${state.enabled?`<p id="cloud-status" class="cloud-status" role="status">${cloudStatus()}</p><button data-action="cloud-retry" class="text" ${['error','quota'].includes(state.cloudState)?'':'hidden'}>重试备份</button>`:''}
      ${btn('privacy-info','了解隐私说明','text')}
      ${!state.enabled&&state.notice.startsWith('已关闭')?`<p class="small" role="status">${state.notice}</p>`:''}</section>
      <p class="footnote compact-footnote">两种方式可同时使用，只备份这个空间中你的记录。<br>关闭云备份不会删除已有备份。</p>`);return;
  }
  if(state.page==='restore') {
    shell('恢复数据',`<h2>找回之前的记录</h2><p class="lede">找回这个空间里自己的记录，换了设备也可以。请准备好恢复码。</p>
      ${state.task?.kind==='restore'?btn('resume-view',`${state.task.paused?'恢复已暂停':'正在恢复'} · 点击查看进度`,'resume'):''}
      <button class="choice" data-action="local"><span class="symbol" aria-hidden="true">↥</span><span><strong>从本地文件恢复</strong><small>选择之前保存的备份文件</small></span><span class="chevron">›</span></button>
      <button class="choice" data-action="cloud"><span class="symbol" aria-hidden="true">↓</span><span><strong>从云端加密备份恢复</strong><small>找回云端保存的记录，不限原设备</small></span><span class="chevron">›</span></button>
      <p class="footnote">恢复不会让其他设备退出。本地文件只在这台设备上处理，不会上传。</p>${state.notice.startsWith('恢复已取消')||state.notice.startsWith('已有一项恢复')?`<div class="status" role="status">${state.notice}</div>`:''}`);return;
  }
  if(state.page==='export') {
    shell('下载备份文件',`<span class="pill">加密文件 · .qrlocal</span><h2>这次会备份哪些内容？</h2><p class="lede">保存这台设备已有的聊天记录和文件。</p><div class="list">${row('聊天记录','1,120 条')}${row('原始附件','86 个 · 128 MB')}${row('未包含的附件','4 个')}${row('时间范围','9 月 1 日至 9 月 28 日')}</div><p class="subtle">4 个文件不在这台设备上，本次无法备份。其他设备独有的记录也不会包含在内。</p><p class="subtle">请把恢复码也保管好，恢复时需要用到。</p><div class="actions">${btn('export-auth','验证并生成备份')}${btn('backup','返回','text full')}</div>`,'backup');return;
  }
  if(state.page==='auth-export') {
    shell('验证身份',`<p class="step-label">系统验证 · 模拟</p><h2>验证一下，确认是你</h2><p class="lede">按系统提示完成面容、指纹或设备密码验证。此处仅演示。</p><div class="actions">${btn('export-start','模拟验证成功')}${btn('export','取消','text full')}</div>`,'export');return;
  }
  if(state.page==='export-ready') {
    shell('文件已生成',`<div class="state-icon">↓</div><h2>选择保存位置</h2><p class="lede">备份文件已准备好，尚未保存到你的文件夹。</p><div class="list">${row('文件名','山间小屋-20260928.qrlocal')}${row('预计大小','128 MB')}</div><div class="actions">${btn('save','打开系统保存')}${btn('backup','暂不保存','text full')}</div><p class="footnote">本次演示不会生成或下载真实文件。</p>`,'backup');return;
  }
  if(state.page==='save') {
    shell('保存备份',`<p class="step-label">系统保存 / 分享 · 模拟</p><h2>将文件交给系统保存</h2><p class="lede">正式产品由系统提供位置选择。取消后可重新保存，无需重新生成。</p><div class="actions">${btn('handoff','模拟已交给系统')}${btn('export-ready','模拟取消保存','text full')}</div>`,'export-ready');return;
  }
  if(state.page==='handoff') {
    shell('请确认文件已保存',`<div class="state-icon">✓</div><h2>已交给系统</h2><p class="lede">请到刚才选择的位置确认备份文件存在。应用无法确认系统最终是否保存成功。</p><div class="actions">${btn('backup','完成')}${btn('save','重新保存','text full')}</div>`,'backup');return;
  }
  if(state.page==='auth'||state.page==='legacy') {
    const legacy=state.page==='legacy';
    shell(legacy?'补充旧恢复码':'验证恢复码',`<p class="step-label">${state.source==='local'?'本地文件':'云端加密备份'}</p><h2>${legacy?'找回更早的记录':'输入你的恢复码'}</h2>${!legacy&&state.source==='local'?`<p class="selected-file">已选择：${esc(state.fileName)}</p>`:''}<p class="lede">${legacy?'这份旧备份需要当时的恢复码。你也可以先恢复已找回的部分。':'输入备份对应的恢复码，找回自己的聊天记录。'}</p><form id="code-form"><label for="demo-code">恢复码（仅演示）</label><textarea id="demo-code" autocomplete="off" spellcheck="false" placeholder="请填写 DEMO-ONLY"></textarea><p class="form-error" role="alert"></p><button type="submit" class="primary">${legacy?'验证旧恢复码':'验证恢复码'}</button></form><p class="footnote">请勿输入真实恢复码。演示仅接受 DEMO-ONLY。</p><div class="actions">${btn(legacy?'preview':'restore',legacy?'暂不补充':'取消','text full')}</div>`,legacy?'preview':'restore');return;
  }
  if(state.page==='empty') {
    shell('云端加密备份',`<div class="state-icon">○</div><h2>还没有可恢复的历史备份</h2><p class="lede">这份恢复码没有找到聊天备份。可以换一个恢复码，或选择本地文件。</p><div class="actions">${btn('local','改用本地备份文件')}${btn('auth','更换恢复码','secondary')}${btn('restore','返回','text full')}</div>`,'restore');return;
  }
  if(state.page==='preview') {
    const legacy=state.scenario==='legacy'&&!state.supplemented;
    shell('确认恢复范围',`<span class="pill">${state.source==='cloud'?'云端 · 已找到你的备份':'本地备份文件'}</span><h2>这些记录可以找回</h2><p class="lede">这是你在「山间小屋」的记录。已有内容会保留，重复记录不会再添加。</p><div class="list">${row('备份聊天记录',state.supplemented?'1,360 条':'1,280 条')}${row('这台设备已有','960 条')}${row('本次找回',state.supplemented?'400 条':'320 条')}${state.role==='creator'?row('保险箱记录','另找回 12 条'):''}${row('记录日期','9 月 1 日至 9 月 28 日')}</div>
      ${legacy?`<div class="status"><strong>还有一份旧备份需要恢复码</strong><p>这份旧备份还没算在内。输入当时的恢复码，就能一起找回。</p>${btn('legacy','补充旧恢复码','text')}</div>`:''}
      <details><summary>查看备份来源与范围</summary><p>${state.source==='cloud'?'已找到你在 iPhone 和 Mac 上保存的记录。重复记录只计算一次，换设备不影响恢复。':'这是你之前保存的文件，换设备后也能用恢复码找回。'}${state.supplemented?' 已另加入 80 条旧备份记录。':''}</p><p>新设备不会自动显示旧记录，需要你主动恢复。已删除或隐藏的内容不会重新显示；草稿、收藏和置顶不恢复。</p></details>
      <p class="subtle">${state.source==='cloud'?'照片和文件在打开时下载；云端已不存在的原文件无法找回。':'只能找回备份文件里已有的照片和文件。'}</p><div class="actions">${btn('restore-start',legacy?'先恢复已找到的记录':'确认恢复')}${btn('restore','取消','text full')}</div>`,'restore');return;
  }
  if(state.page==='progress') { renderProgress(); return; }
  if(state.page==='error') {
    const reasons={wrong:['无法恢复这份备份','这份备份不是你在这个空间的记录，没有添加任何内容。'],corrupt:['这份备份无法使用','文件可能已损坏。没有添加任何内容，请换一份备份试试。'],conflict:['发现内容冲突','备份与本机相同记录的内容不一致。已停止恢复，没有覆盖本机记录。'],quota:['云端空间不足','本次新增内容尚未备份。已有备份保留，可改为下载本地文件。']};
    const [title,copy]=reasons[state.scenario]||['当前无法继续','请联网后重试。尚未开始导入任何记录。'];
    shell('操作未完成',`<div class="error-box" role="alert"><h2>${title}</h2><p>${copy}</p></div><div class="actions">${btn(state.scenario==='quota'?'export':'restore',state.scenario==='quota'?'下载本地备份':'重新选择恢复方式')}${btn(state.scenario==='quota'?'backup':'auth',state.scenario==='quota'?'返回':'更换恢复码','text full')}</div>`,state.scenario==='quota'?'backup':'restore');return;
  }
  if(state.page==='result') {
    const amount=state.supplemented?400:320;
    shell('恢复完成',`<div class="state-icon">✓</div><h2>记录已找回</h2><p class="lede">回到聊天，往前翻就能看到原来的记录。</p><div class="list">${row('备份聊天总数',`${960+amount} 条`)}${row('这台设备已有','960 条')}${row('本次新增',`${amount} 条`)}${row('其中可见',`${amount-8} 条`)}${row('保持隐藏','8 条')}${row('现在可见的记录',`${960+amount-8} 条`)}${state.role==='creator'?row('保险箱新增','12 条（10 条可见）'):''}</div><p class="subtle">新增可见记录日期：9 月 1 日至 9 月 27 日。${state.source==='cloud'?'照片和文件将在打开时下载。':'只恢复了备份中已有的照片和文件。'}</p><div class="actions">${btn('restore','完成')}${btn('repeat','再次检查相同备份','text full')}</div>`,'restore');return;
  }
  if(state.page==='repeat') {shell('检查完成',`<div class="state-icon">✓</div><h2>这些记录已经在这里</h2><p class="lede">没有新增记录，无需重复导入。</p>${btn('restore','完成')}`,'restore');return;}
  if(state.page==='cancel-task') {shell('取消恢复',`<h2>结束这次恢复？</h2><p class="lede">已经找回的记录会保留。下次恢复需要重新输入恢复码。</p><div class="actions">${btn('cancel-confirm','取消恢复','secondary')}${btn('progress','继续查看进度','text full')}</div>`,'progress');}
}
function renderProgress() {
  const task=state.task;if(!task){page('restore');return;}
  const isRestore=task.kind==='restore', isExport=task.kind==='export';
  const paused=task.paused;
  const title=paused?'任务已暂停':task.ticks<2?(isRestore?'检查备份内容':isExport?'正在生成加密文件':'正在加密并备份'):task.ticks<5?(isRestore?'正在补入记录':isExport?'正在写入加密文件':'正在上传密文'):'正在检查结果';
  const percent=Math.min(95,Math.round(task.ticks/6*100));
  shell(isRestore?'恢复进度':isExport?'生成备份':'备份进度',`<p class="step-label">${isRestore?(state.source==='cloud'?'云端恢复':'本地文件恢复'):isExport?'仅在本机生成':'云端加密备份'}</p><h2>${title}</h2>
    ${task.ticks<2?'<p class="lede">正在检查备份，请稍候。</p>':`<div class="count">${percent}<small> %</small></div><div class="progress" role="progressbar" aria-label="任务进度" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${percent}%"></span></div>`}
    <ol class="steps"><li class="${task.ticks<2?'current':''}">1　检查备份</li><li class="${task.ticks>=2&&task.ticks<5?'current':''}">2　${isRestore?'找回记录':isExport?'生成备份文件':'上传加密内容'}</li><li class="${task.ticks>=5?'current':''}">3　${isRestore?'检查恢复结果':'检查备份文件'}</li></ol>
    ${paused?`<div class="status" role="status"><strong>${task.reason||'离开或锁定后暂停'}</strong><p>${task.ticks>=2&&isRestore?'已经找回的记录会保留，重试后接着恢复。':'尚未完成，不会显示成功。'}</p></div>${btn('retry','重试继续')}`:'<p class="subtle">请保持页面打开，完成后会告诉你。</p>'}
    <div class="actions">${isRestore?btn('collapse','收起进度','secondary'):btn('pause-back','暂停并返回','secondary')}${isRestore?btn('cancel-task','取消恢复','text full'):''}</div>`,isRestore?'pause-restore':'pause-back');
}
function start(kind) {
  stop();announce('');state.task={kind,ticks:0,paused:false};state.page='progress';render();tick();
}
function tick() {
  stop();if(!state.task||state.task.paused||state.locked)return;
  state.timer=setTimeout(()=>{
    const task=state.task;if(!task)return;
    if(state.offline&&(task.kind==='backup'||state.source==='cloud'&&task.kind==='restore')){pause('网络已断开，联网后可重试');return;}
    task.ticks++;
    if(state.scenario==='failure'&&!state.failed&&task.ticks===3){state.failed=true;pause(task.kind==='export'?'本机临时空间不可用，请重试':'连接中断，请重试');return;}
    if(task.ticks>=6){const kind=task.kind;state.task=null;
      if(kind==='backup'){state.synced=true;state.notice='本次备份已确认完成。其他离线设备的新内容仍待上传。';page('backup');announce('云端备份已完成');}
      else {page(kind==='export'?'export-ready':'result');announce(kind==='export'?'文件已生成，尚未保存':'恢复已完成并通过回读核验');}
      return;
    }
    if(state.page==='progress')render();tick();
  },850);
}
function pause(reason) {stop();if(state.task){state.task.paused=true;state.task.reason=reason;}render();}
function inspect() {
  if(state.offline&&state.source==='cloud'){page('error');return;}
  if(['wrong','corrupt','conflict'].includes(state.scenario)){page('error');return;}
  if(state.source==='cloud'&&state.scenario==='empty'){page('empty');return;}
  page('preview');
}
function action(name) {
  switch(name) {
    case 'enable':closePrivacy();state.enabled=true;state.notice='';render();startCloudBackup();break;
    case 'close-privacy':closePrivacy();break;
    case 'privacy-info':openPrivacy(true);break;
    case 'cloud-retry':startCloudBackup();break;
    case 'export-auth':page('auth-export');break;
    case 'export-start':start('export');break;
    case 'cloud':if(state.task?.kind==='restore'){state.notice='已有一项恢复任务，请先查看进度或取消后再开始新的恢复。';render();break;}state.source='cloud';state.supplemented=false;page('auth');break;
    case 'local':chooseLocalFile();break;
    case 'restore-start':start('restore');break;
    case 'retry':if(state.offline&&state.source==='cloud'){pause('仍未联网，请恢复网络后重试');break;}state.task.paused=false;state.task.reason='';page('progress');tick();break;
    case 'collapse':page('restore');break;
    case 'pause-restore':pause('离开恢复页后暂停');page('restore');break;
    case 'pause-back':pause('操作已暂停');if(state.task?.kind==='backup'){state.task=null;page('backup');}else{state.task=null;page('export');}break;
    case 'resume-view':page('progress');break;
    case 'cancel-task':pause('等待取消确认');page('cancel-task');break;
    case 'cancel-confirm':stop();state.task=null;state.notice='恢复已取消，已导入的记录保留。';page('restore');break;
    case 'unlock':state.locked=false;render();if(state.enabled&&state.cloudState==='paused')startCloudBackup();break;
    case 'stay-locked':announce('验证已取消，仍保持锁定');break;
    default:page(name);
  }
}
document.querySelectorAll('[data-review]').forEach(el=>el.addEventListener('click',()=>{if(state.task)pause('离开操作页后暂停');state.locked=false;page(el.dataset.review);}));
document.querySelector('#theme').addEventListener('change',e=>document.documentElement.dataset.theme=e.target.value);
document.querySelector('#scenario').addEventListener('change',e=>{state.scenario=e.target.value;reset();});
document.querySelector('#role').addEventListener('change',e=>{state.role=e.target.value;render();});
document.querySelector('#offline').addEventListener('change',e=>{state.offline=e.target.checked;if(state.offline&&state.task?.kind==='restore'&&state.source==='cloud')pause('网络已断开，联网后可重试');else render();if(state.enabled){if(state.offline){clearTimeout(state.cloudTimer);state.cloudState='paused';updateCloudStatus();}else startCloudBackup();}});
document.querySelector('#lock').addEventListener('click',()=>{closePrivacy();clearTimeout(state.cloudTimer);if(state.enabled)state.cloudState='paused';if(state.task)pause('锁定后暂停，请解锁后重试');state.locked=true;render();});
document.querySelector('#reset').addEventListener('click',reset);
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(state.cloudTimer);if(state.enabled)state.cloudState='paused';if(state.task){pause('页面进入后台，任务已暂停');state.locked=true;render();}}else if(state.enabled&&!state.locked&&state.cloudState==='paused')startCloudBackup();});
if(matchMedia('(max-width:650px)').matches)document.querySelector('.review-tools').open=false;
render();
