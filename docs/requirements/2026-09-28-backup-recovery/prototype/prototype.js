// Presentation-only simulation. No fetch, storage, real files, or cryptography.
const app = document.querySelector('#app');
const state = { page:'backup', enabled:false, consent:false, synced:false, scenario:'normal', role:'creator', offline:false, locked:false, source:'cloud', task:null, timer:null, ticks:0, failed:false, supplemented:false, notice:'' };
const btn = (id, text, kind='primary') => `<button data-action="${id}" class="${kind}">${text}</button>`;
const row = (label, value) => `<div class="item"><span>${label}</span><strong>${value}</strong></div>`;
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function announce(text) { document.querySelector('#announcement').textContent=text; }
function stop() { clearTimeout(state.timer); state.timer=null; }
function page(name) { announce(''); state.page=name; render(); }
function reset() {
  stop(); announce(''); Object.assign(state,{page:'backup',enabled:state.scenario==='existing',consent:false,synced:state.scenario==='existing',task:null,ticks:0,failed:false,supplemented:false,notice:'',locked:false}); render();
}
function privacy(full=false) {
  return `<p>聊天记录在你的设备上加密后上传。平台不持有解密密钥，无法直接读取备份中的聊天内容。</p>${full ? `<ul><li>平台仍可见备份时间、大小、空间与设备关联等必要信息。</li><li>恢复材料泄露可能让他人读取备份；丢失后平台无法代为解密。</li><li>仅在页面打开、解锁且联网时运行；关闭应用后不保证继续。</li><li>图片、语音和文件的恢复依赖原始加密附件仍然可用。</li></ul><p>开启后覆盖当前私密空间中的本人已授权设备，各设备备份自己持有的历史。不改变对方的选择。</p>` : ''}`;
}
function shell(title, body, back='settings') {
  app.innerHTML=`<header class="app-header">${btn(back,'‹','glass-control')}<div><strong>${title}</strong><small>山间小屋</small></div><span></span></header><div class="content">${body}</div>`;
  app.querySelector('.app-header button').setAttribute('aria-label','返回');
  app.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click',()=>action(el.dataset.action)));
  app.querySelector('#cloud-switch')?.addEventListener('change',()=>{
    if(state.enabled){stop();state.enabled=false;state.task=null;state.notice='已停止此设备后续上传。其他离线设备收到设置后停止；已有云端备份仍可恢复。';}
    else state.consent=true;
    render();
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
    const status=state.offline?'等待联网':state.task?.kind==='backup'?'正在加密并备份…':state.synced?'最近备份 · 今天 14:32':'尚未完成首次备份';
    shell('备份数据',`<p class="lede">留一份加密副本，换设备后也能找回。<br>两种方式可以同时使用。</p>
      <section class="section"><h3>下载到本地</h3><p>生成加密备份文件，保存在你选择的位置。文件不会自动更新。</p>${btn('export','下载备份文件','secondary')}</section>
      <section class="section"><div class="row"><div><h3>自动加密备份到云端</h3><small>${state.enabled?'已开启':'未开启'} · 仅当前私密空间中的我</small></div><label class="switch"><input id="cloud-switch" type="checkbox" role="switch" aria-label="自动加密备份到云端" ${state.enabled?'checked':''}><i></i></label></div>
      ${state.consent?`<div class="privacy"><h3>开启前，了解隐私边界</h3>${privacy(true)}${btn('enable','同意并开启')}${btn('cancel-enable','暂不开启','text full')}</div>`:`${privacy()}<details><summary>了解隐私边界</summary>${privacy(true)}</details>`}
      ${state.enabled?`<div class="status" role="status"><strong>${status}</strong><p>${state.synced?'已确认备份 1,280 条聊天记录。':'新记录只有收到云端成功确认后才计入备份。'}</p><p>${state.offline?'联网并解锁后继续。':state.task?.kind==='backup'?'请保持页面打开和解锁。':'另有一台本人设备离线，其最新内容尚未确认备份。'}</p></div>${btn('backup-now',state.task?.kind==='backup'?'查看备份进度':'立即备份','text full')}`:''}
      ${state.notice?`<div class="status" role="status">${state.notice}</div>`:''}</section>
      <p class="footnote">关闭只停止后续聊天历史备份，已有云端备份保留。空间恢复保护仍会保存必要的加密身份材料，不包含后续聊天记录。</p>`);return;
  }
  if(state.page==='restore') {
    shell('恢复数据',`<h2>找回之前的记录</h2><p class="lede">同一私密空间、同一人，不限备份来源设备。恢复需要相应的恢复材料。</p>
      ${state.task?.kind==='restore'?btn('resume-view',`${state.task.paused?'恢复已暂停':'正在恢复'} · 点击查看进度`,'resume'):''}
      <button class="choice" data-action="local"><span class="symbol" aria-hidden="true">↥</span><span><strong>从本地文件恢复</strong><small>选择加密备份，在本机解密，不上传文件</small></span><span class="chevron">›</span></button>
      <button class="choice" data-action="cloud"><span class="symbol" aria-hidden="true">↓</span><span><strong>从云端加密备份恢复</strong><small>合并本人已授权可读取的各设备备份</small></span><span class="chevron">›</span></button>
      <p class="footnote">这里只找回聊天记录，不会替换设备身份或让其他设备退出。若尚未恢复私密空间，请先完成空间恢复。</p>${state.notice.startsWith('恢复已取消')||state.notice.startsWith('已有一项恢复')?`<div class="status" role="status">${state.notice}</div>`:''}`);return;
  }
  if(state.page==='export') {
    shell('下载备份文件',`<span class="pill">加密文件 · .qrlocal</span><h2>先看这份备份包含什么</h2><p class="lede">导出当前设备已有的内容，包括此前从其他设备恢复的记录。</p><div class="list">${row('聊天记录','1,120 条')}${row('原始附件','86 个 · 128 MB')}${row('未包含的附件','4 个')}${row('时间范围','9 月 1 日至 9 月 28 日')}</div><p class="subtle">4 个附件未下载或缓存已清理，本次文件不含其原件。其他设备尚未恢复到此处的记录也不在文件中。</p><p class="subtle">请同时妥善保管对应恢复材料。文件本身不能替代恢复材料。</p><div class="actions">${btn('export-auth','验证并生成备份')}${btn('backup','返回','text full')}</div>`,'backup');return;
  }
  if(state.page==='auth-export') {
    shell('验证身份',`<p class="step-label">系统验证 · 模拟</p><h2>使用通行密钥继续</h2><p class="lede">正式产品将在此调用系统验证。原型不读取任何凭据。</p><div class="actions">${btn('export-start','模拟验证成功')}${btn('export','取消','text full')}</div>`,'export');return;
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
  if(state.page==='local') {
    shell('从本地文件恢复',`<h2>选择加密备份文件</h2><p class="lede">可以选择本人其他设备生成的备份。文件只在本机读取和解密，不会上传服务器。</p><div class="status"><strong>示例文件</strong><p>山间小屋-20260927.qrlocal</p><p>来自另一台本人设备 · 128 MB</p></div><div class="actions">${btn('local-select','选择示例备份文件')}${btn('restore','取消','text full')}</div><p class="footnote">原型用示例替代系统文件选择器，不读取真实文件。</p>`,'restore');return;
  }
  if(state.page==='auth'||state.page==='legacy') {
    const legacy=state.page==='legacy';
    shell(legacy?'补充旧备份授权':'验证恢复材料',`<p class="step-label">${state.source==='local'?'本地文件':'云端加密备份'}</p><h2>${legacy?'还有一份旧备份未解锁':'确认这是你的备份'}</h2><p class="lede">${legacy?'已找到的两份备份可以恢复。另一份旧备份需要其对应恢复码，未解锁前不会计入恢复范围。':'输入对应恢复材料，在本机验证和解密。仅认可浏览器或拥有通行密钥，不会自动获得旧历史。'}</p><form id="code-form"><label for="demo-code">恢复码（仅演示）</label><textarea id="demo-code" autocomplete="off" spellcheck="false" placeholder="请填写 DEMO-ONLY"></textarea><p class="form-error" role="alert"></p><button type="submit" class="primary">${legacy?'验证并加入恢复范围':'验证并查找备份'}</button></form><p class="footnote">请勿输入真实恢复码。演示仅接受 DEMO-ONLY。</p><div class="actions">${btn(legacy?'preview':'restore',legacy?'暂不补充':'取消','text full')}</div>`,legacy?'preview':'restore');return;
  }
  if(state.page==='empty') {
    shell('云端加密备份',`<div class="state-icon">○</div><h2>还没有可恢复的历史备份</h2><p class="lede">当前恢复材料未找到可用的聊天备份。空间恢复成功不代表聊天历史已经备份。</p><div class="actions">${btn('local','改用本地备份文件')}${btn('auth','更换恢复材料','secondary')}${btn('restore','返回','text full')}</div>`,'restore');return;
  }
  if(state.page==='preview') {
    const legacy=state.scenario==='legacy'&&!state.supplemented;
    shell('确认恢复范围',`<span class="pill">${state.source==='cloud'?'云端 · 本人备份已合并':'本地文件 · 来自另一台本人设备'}</span><h2>将记录补回这台设备</h2><p class="lede">已验证属于「山间小屋」中的本人。不会覆盖已有记录，重复内容只保留一份。</p><div class="list">${row('备份聊天记录',state.supplemented?'1,360 条':'1,280 条')}${row('本机已有','960 条')}${row('待补入',state.supplemented?'400 条':'320 条')}${state.role==='creator'?row('保险箱直传记录','12 条待补入'):''}${row('记录日期','9 月 1 日至 9 月 28 日')}</div>
      ${legacy?`<div class="status"><strong>还有一份旧备份需要授权</strong><p>下列范围不含这份旧备份。补充其恢复码后可一起恢复。</p>${btn('legacy','补充旧恢复码','text')}</div>`:''}
      <details><summary>查看备份来源与范围</summary><p>${state.source==='cloud'?'两份已授权备份合并去重后，共有 1,280 条聊天记录。来源包括本人 iPhone 与 Mac，当前设备无须与来源相同。':'该文件由本人 Mac 生成。当前 iPhone 可在验证相应恢复材料后导入。'}${state.supplemented?' 已另加入 80 条旧备份记录。':''}</p><p>普通新增设备不会自动获得旧历史，本次操作是显式授权恢复。已删除或隐藏内容保持相应状态，草稿、收藏和置顶不在本次范围内。</p></details>
      <p class="subtle">${state.source==='cloud'?'附件清单与密钥随历史恢复，查看原件时仍需云端加密附件可用。':'只恢复文件已包含的附件原件，无法补回文件中缺失的原件。'}</p><div class="actions">${btn('restore-start',legacy?'恢复已授权的内容':'确认恢复')}${btn('restore','取消','text full')}</div>`,'restore');return;
  }
  if(state.page==='progress') { renderProgress(); return; }
  if(state.page==='error') {
    const reasons={wrong:['无法恢复这份备份','备份不属于当前私密空间或当前参与者。不会导入任何内容。'],corrupt:['备份未通过完整性校验','文件可能损坏或内容被改动。没有导入本次内容，请换一份有效备份。'],conflict:['发现内容冲突','备份与本机相同记录的内容不一致。已停止恢复，没有覆盖本机记录。'],quota:['云端空间不足','本次新增内容尚未备份。已有备份保留，可改为下载本地文件。']};
    const [title,copy]=reasons[state.scenario]||['当前无法继续','请联网后重试。尚未开始导入任何记录。'];
    shell('操作未完成',`<div class="error-box" role="alert"><h2>${title}</h2><p>${copy}</p></div><div class="actions">${btn(state.scenario==='quota'?'export':'restore',state.scenario==='quota'?'下载本地备份':'重新选择恢复方式')}${btn(state.scenario==='quota'?'backup':'auth',state.scenario==='quota'?'返回':'更换恢复材料','text full')}</div>`,state.scenario==='quota'?'backup':'restore');return;
  }
  if(state.page==='result') {
    const amount=state.supplemented?400:320;
    shell('恢复完成',`<div class="state-icon">✓</div><h2>记录已补回，并完成核验</h2><p class="lede">恢复的记录保留原日期，可在聊天中向前查阅。</p><div class="list">${row('备份聊天总数',`${960+amount} 条`)}${row('本机原有','960 条')}${row('本次新增',`${amount} 条`)}${row('其中可见',`${amount-8} 条`)}${row('保持隐藏','8 条')}${row('备份中当前可见总数',`${960+amount-8} 条`)}${state.role==='creator'?row('保险箱新增','12 条（10 条可见）'):''}</div><p class="subtle">新增可见记录日期：9 月 1 日至 9 月 27 日。${state.source==='cloud'?'附件原件在查看时再获取，记录恢复成功不等于原件已下载。':'已包含的附件原件在本机恢复，文件缺失的原件不计为恢复成功。'}</p><div class="actions">${btn('restore','完成')}${btn('repeat','再次检查相同备份','text full')}</div>`,'restore');return;
  }
  if(state.page==='repeat') {shell('检查完成',`<div class="state-icon">✓</div><h2>这些记录已经在这里</h2><p class="lede">没有新增记录，无需重复导入。</p>${btn('restore','完成')}`,'restore');return;}
  if(state.page==='cancel-task') {shell('取消恢复',`<h2>结束这次恢复？</h2><p class="lede">已经导入的记录会保留。结束后清除本次任务保存的恢复材料，再次恢复时需重新验证。</p><div class="actions">${btn('cancel-confirm','取消恢复','secondary')}${btn('progress','继续查看进度','text full')}</div>`,'progress');}
}
function renderProgress() {
  const task=state.task;if(!task){page('restore');return;}
  const isRestore=task.kind==='restore', isExport=task.kind==='export';
  const paused=task.paused;
  const title=paused?'任务已暂停':task.ticks<2?(isRestore?'检查备份内容':isExport?'正在生成加密文件':'正在加密并备份'):task.ticks<5?(isRestore?'正在补入记录':isExport?'正在写入加密文件':'正在上传密文'):'正在核验结果';
  const percent=Math.min(95,Math.round(task.ticks/6*100));
  shell(isRestore?'恢复进度':isExport?'生成备份':'备份进度',`<p class="step-label">${isRestore?(state.source==='cloud'?'云端恢复':'本地文件恢复'):isExport?'仅在本机生成':'云端加密备份'}</p><h2>${title}</h2>
    ${task.ticks<2?'<p class="lede">正在核对归属、完整性和已有内容，最终总数仍待确认。</p>':`<div class="count">${percent}<small> %</small></div><div class="progress" role="progressbar" aria-label="任务进度" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${percent}%"></span></div>`}
    <ol class="steps"><li class="${task.ticks<2?'current':''}">1　验证并确定范围</li><li class="${task.ticks>=2&&task.ticks<5?'current':''}">2　${isRestore?'导入缺失内容':isExport?'本机压缩并加密':'上传加密内容'}</li><li class="${task.ticks>=5?'current':''}">3　${isRestore?'本机回读核验':'确认完整性与保存结果'}</li></ol>
    ${paused?`<div class="status" role="status"><strong>${task.reason||'离开或锁定后暂停'}</strong><p>${task.ticks>=2&&isRestore?'已导入的部分保留，重试只补齐剩余内容。':'尚未完成，不会显示成功。'}</p></div>${btn('retry','重试继续')}`:'<p class="subtle">请保持页面打开并解锁，核验通过后才显示完成。</p>'}
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
    case 'enable':state.enabled=true;state.consent=false;state.notice='设置已保存。其他离线设备联网后同步此设置。';if(state.scenario==='quota')page('error');else start('backup');break;
    case 'cancel-enable':state.consent=false;render();break;
    case 'backup-now':if(state.task?.kind==='backup'){page('progress');break;}if(state.scenario==='quota'){page('error');break;}start('backup');break;
    case 'export-auth':page('auth-export');break;
    case 'export-start':start('export');break;
    case 'cloud':case 'local':if(state.task?.kind==='restore'){state.notice='已有一项恢复任务，请先查看进度或取消后再开始新的恢复。';render();break;}state.source=name;state.supplemented=false;page(name==='cloud'?'auth':'local');break;
    case 'local-select':state.source='local';page('auth');break;
    case 'restore-start':start('restore');break;
    case 'retry':if(state.offline&&state.source==='cloud'){pause('仍未联网，请恢复网络后重试');break;}state.task.paused=false;state.task.reason='';page('progress');tick();break;
    case 'collapse':page('restore');break;
    case 'pause-restore':pause('离开恢复页后暂停');page('restore');break;
    case 'pause-back':pause('操作已暂停');if(state.task?.kind==='backup'){state.task=null;page('backup');}else{state.task=null;page('export');}break;
    case 'resume-view':page('progress');break;
    case 'cancel-task':pause('等待取消确认');page('cancel-task');break;
    case 'cancel-confirm':stop();state.task=null;state.notice='恢复已取消，已导入的记录保留。';page('restore');break;
    case 'unlock':state.locked=false;render();break;
    case 'stay-locked':announce('验证已取消，仍保持锁定');break;
    default:page(name);
  }
}
document.querySelectorAll('[data-review]').forEach(el=>el.addEventListener('click',()=>{if(state.task)pause('离开操作页后暂停');state.locked=false;page(el.dataset.review);}));
document.querySelector('#theme').addEventListener('change',e=>document.documentElement.dataset.theme=e.target.value);
document.querySelector('#scenario').addEventListener('change',e=>{state.scenario=e.target.value;reset();});
document.querySelector('#role').addEventListener('change',e=>{state.role=e.target.value;render();});
document.querySelector('#offline').addEventListener('change',e=>{state.offline=e.target.checked;if(state.offline&&state.task&&(state.task.kind==='backup'||state.task.kind==='restore'&&state.source==='cloud'))pause('网络已断开，联网后可重试');else render();});
document.querySelector('#lock').addEventListener('click',()=>{if(state.task)pause('锁定后暂停，请解锁后重试');state.locked=true;render();});
document.querySelector('#reset').addEventListener('click',reset);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.task){pause('页面进入后台，任务已暂停');state.locked=true;render();}});
if(matchMedia('(max-width:650px)').matches)document.querySelector('.review-tools').open=false;
render();
