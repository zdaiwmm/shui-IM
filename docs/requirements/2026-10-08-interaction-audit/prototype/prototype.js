/* Prototype only. No API, WebAuthn, storage, application entry or service worker. */
(() => {
  'use strict';
  const surface = document.querySelector('#surface');
  const consolePanel = document.querySelector('.review-console');
  const flowPicker = document.querySelector('#flow');
  const conditions = document.querySelector('#conditions');
  const backIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>';
  const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  const menuIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14"/></svg>';
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let epoch = 0;
  let checkTimer = null;
  let requestSequence = 0;
  const timers = new Set();
  let state;
  const initial = flow => ({
    flow, page:flow === 'recovery' ? 'recovery-entry' : flow === 'device' ? 'device-entry' : 'chat',
    draft:'等你回来再聊。', messages:[], access:'connected', input:'', buffer:'', choices:[],
    modal:null, error:'', network:'success', material:'QR4', role:'helper', ownApproved:false,
    peerApproved:false, taskStarted:false, notice:'', resumePage:null, authError:false,
    approved:false, expired:false, denied:false, deviceOffline:false, busy:false,
    installFailure:false, devicePhase:'waiting', requestId:null, checks:0, joins:0,
    cooldown:0, returnFocus:'composer', returnScroll:0, returnSelection:[0,0], consumeCount:0, repairStarted:false,
  });
  function later(fn, delay) {
    const current = epoch;
    const id = setTimeout(() => { timers.delete(id); if (current === epoch) fn(); }, delay);
    timers.add(id);
    return id;
  }
  function invalidate() { epoch++; for (const id of timers) clearTimeout(id); timers.clear(); checkTimer=null; state.busy = false; }
  function clearMaterial() { state.input=''; state.buffer=''; state.choices=[]; state.error=''; state.cooldown=0; state.modal=null; }
  function announce(message) { document.querySelector('#announcement').textContent=message; }
  function focus(selector) { queueMicrotask(() => surface.querySelector(selector)?.focus({preventScroll:true})); }
  function changePage(page, focusTo='h1') { state.page=page; render(); focus(focusTo); }
  function button(action,text,kind='primary-button',disabled=false) { return `<button type="button" class="${kind}" data-action="${action}"${disabled?' disabled':''}>${text}</button>`; }
  function header(title, action='back', label='返回聊天') { return `<header class="prototype-nav"><button class="icon-button glass-control" type="button" data-action="${action}" aria-label="${label}">${backIcon}</button><strong>${title}</strong><span></span></header>`; }
  function page(title,heading,body,footer,action='back',label='返回聊天') {
    return `<section class="prototype-page">${header(title,action,label)}<div class="prototype-content"><h1 tabindex="-1">${heading}</h1>${body}</div><footer class="prototype-footer">${footer}</footer></section>`;
  }
  function options(id,title,values,selected) { return `<label>${title}<select id="${id}">${values.map(([value,text])=>`<option value="${value}"${value===selected?' selected':''}>${text}</option>`).join('')}</select></label>`; }
  function controls() {
    const demoButton = (action,text) => button(action,text,'secondary-button');
    if (state.flow==='nav') {
      conditions.innerHTML = demoButton('invite-recovery','模拟打开恢复邀请')+demoButton('invite-repair','模拟打开修复邀请')+demoButton('invite-invalid','模拟无效／不匹配邀请')+demoButton('peer-confirm','模拟对方明确确认')+demoButton('repair-approve','模拟发起方明确批准修复')+demoButton('lock','模拟锁定／隐私中断')+demoButton('auth-cancel','模拟验证取消');
      document.querySelector('#review-note').textContent='先编辑草稿，再打开邀请并返回。重复打开不需要刷新。已开始恢复时打开另一邀请，不应替换当前任务。';
    } else if (state.flow==='access') {
      conditions.innerHTML=options('access','模拟连接结果',[
        ['connected','正常连接'],['offline','临时断网'],['removed','设备已移除（已确认）'],['replaced','设备已替换（已确认）'],['auth','认证被拒绝（原因未知）'],['upgrade','需要升级客户端'],['gone','空间已不可用（已确认）']
      ],state.access)+demoButton('lock','模拟锁定');
      document.querySelector('#review-note').textContent='临时断网可输入并排队。接入失效后保留本机记录和草稿，停止新发送；不自动转移消息或重新激活设备。';
    } else if (state.flow==='recovery') {
      conditions.innerHTML=options('network','下一次读取结果',[
        ['success','成功'],['503','目录暂不可用（503）'],['offline','网络不可用'],['429','服务限流（演示等待3秒）'],['empty','没有可恢复空间'],['mismatch','恢复码不匹配目标']
      ],state.network)+options('role','已验证的本机状态（演示条件）',[
        ['helper','协助方，本机空间可用'],['recovered','找回方，本机无可用入口']
      ],state.role)+demoButton('peer-confirm','模拟对方明确确认')+demoButton('lock','模拟锁定／隐藏')+demoButton('finish-fail','模拟完成请求失败');
      conditions.querySelector('#role').disabled=state.taskStarted;
      document.querySelector('#review-note').textContent='输入 QR4-DEMO 或 QR3-DEMO，仅为非秘密演示文本。QR3 演示“产生新材料”的结果分支，正式文案须依据实际恢复结果，不能只看输入前缀。';
    } else {
      conditions.innerHTML=demoButton('device-approve','模拟原设备核对并批准')+demoButton('device-offline',state.deviceOffline?'模拟恢复联网':'模拟断网')+demoButton('device-expire','模拟服务确认过期')+demoButton('device-deny','模拟服务拒绝')+demoButton('install-fail','模拟安装失败一次')+demoButton('lock','模拟锁定／隐藏')+demoButton('auth-cancel','模拟验证取消');
      document.querySelector('#review-note').textContent=`申请 ${state.requestId||'尚未提交'}；状态检查 ${state.checks} 次；安装成功 ${state.joins} 次。这里只模拟批准结果，正常产品仍须原设备人工核对并签名。`;
    }
  }
  const terminal = () => !['connected','offline'].includes(state.access);
  function accessCopy() {
    return {
      offline:['连接已断开','消息会在本机排队，联网后自动重试。'],
      removed:['此设备已从当前空间移除','无法接收或发送之后的新消息。本机已保存的记录仍可查看。'],
      replaced:['此设备已被新设备替换','当前入口已停止接入。本机记录保留，新消息请在获授权的新设备查看。'],
      auth:['此设备当前无法接入此空间','消息不会自动发送。请在另一台已授权设备核对接入状态。'],
      upgrade:['需要更新后继续','当前版本暂不能继续连接。已保存记录和未发送内容保留。'],
      gone:['此空间当前不可用','此设备不能继续收发，本机已有记录仍可查看。']
    }[state.access];
  }
  function chat(newDevice=false) {
    const copy=accessCopy();
    const old = newDevice ? '<p class="prototype-empty">已接入此空间<br>只能接收加入后的新消息。此设备尚无聊天记录。</p>' : '<div class="message incoming"><div class="message-bubble">晚上见。<span class="message-meta">18:20</span></div></div><div class="message outgoing"><div class="message-bubble">好，等你。<span class="message-meta">18:21 · 已发送</span></div></div>';
    const status = copy ? `<aside class="prototype-status${terminal()?' error':''}" role="status"><strong>${copy[0]}</strong><p>${copy[1]}</p>${terminal()?button(state.access==='upgrade'?'update':state.access==='gone'?'spaces':'access-help',state.access==='upgrade'?'更新后重新打开':state.access==='gone'?'返回空间列表':'查看接入说明','text-button'):''}</aside>` : '';
    return `<section class="prototype-chat"><header class="prototype-nav"><button class="icon-button glass-control" data-action="spaces" aria-label="打开空间列表">${menuIcon}</button><strong class="chat-name">私密空间1</strong><span class="sr-only">${copy?copy[0]:'连接可用'}</span></header><div class="prototype-timeline">${status}${state.notice?`<aside class="prototype-status" role="status">${escape(state.notice)}</aside>`:''}${old}${state.messages.map(message=>`<div class="message outgoing"><div class="message-bubble">${escape(message.text)}<span class="message-meta">${escape(message.status)}</span></div></div>`).join('')}</div><form class="prototype-composer"><label for="composer">${terminal()?'未发送草稿（本机保留）':'消息'}</label><div><textarea id="composer" rows="1" placeholder="输入消息"${terminal()?' readonly':''}>${escape(state.draft)}</textarea><button class="primary-button" type="submit" aria-label="发送消息"${terminal()?' disabled':''}>↑</button></div>${terminal()?'<p class="field-hint">此设备无法发送，草稿不会自动转移到新设备。</p>':''}</form></section>`;
  }
  function recoveryEntry() {
    return page('参与恢复','找回私密空间',`<p>双方各自在自己的设备输入恢复码，无需交换。</p><ol class="recovery-steps"><li aria-current="step"><b>1</b>验证自己的码</li><li><b>2</b>双方确认</li><li><b>3</b>继续聊天</li></ol><div class="joint-request-code" aria-label="核对编号 482731">482731</div><aside class="prototype-status"><strong>这一步只验证你的恢复码</strong><p>可用的一方保留本机聊天；找回的一方旧记录另行恢复。链接不决定谁丢失空间。</p></aside>${state.notice?`<p role="status">${escape(state.notice)}</p>`:''}`,button('open-code','输入我的恢复码')+'<small>返回不会批准恢复，也不会撤销对方请求。</small>');
  }
  function progress() {
    const materialCopy=state.material==='QR4'?'完成后，你的空间恢复码保持不变，请继续妥善保管。':'此次结果包含新的恢复材料，完成后请保存页面显示的恢复码。';
    return page('恢复私密空间','确认找回结果',`<p>空间：私密空间1。请核对双方页面的编号与结果。</p><div class="joint-request-code" aria-label="核对编号 482731">482731</div><div class="recovery-flow-group"><div class="recovery-flow-row"><span><strong>我：${state.role==='helper'?'协助并保留本机聊天':'找回本机空间'}</strong><small>${state.role==='helper'?'本机已有聊天保留':'先进入空会话，旧记录需另行导入自己的备份'}</small></span><em class="recovery-status-badge${state.ownApproved?' ready':''}">${state.ownApproved?'已确认':'未确认'}</em></div><div class="recovery-flow-row"><span><strong>对方：${state.role==='helper'?'找回本机空间':'协助并保留本机聊天'}</strong><small>对方也须明确确认同一结果</small></span><em class="recovery-status-badge${state.peerApproved?' ready':''}">${state.peerApproved?'已确认':'未确认'}</em></div></div><aside class="prototype-status"><p>${materialCopy}</p><p>完成后其他旧设备需重新授权，已保存的内容无法远程销毁。</p></aside>${state.notice?`<aside class="prototype-status" role="status">${escape(state.notice)}${button('dismiss-notice','继续当前恢复','text-button')}</aside>`:''}${state.error?`<p class="form-error" role="alert">${escape(state.error)}</p>`:''}`,state.busy?button('none','正在完成共同恢复…','primary-button',true):state.error?button('complete-retry','重试完成恢复'):state.ownApproved?'<p class="prototype-countdown" role="status">你的确认已提交，等待对方明确确认。</p>':button('own-confirm','确认并找回空间'), 'lock','锁定，稍后继续');
  }
  function completion() {
    const helper=state.role==='helper';
    const copy=state.material==='QR4'?'空间恢复码保持不变，请继续妥善保管。':'此次显示的是新的恢复材料，请保存恢复码后继续。';
    return page(helper?'协助恢复完成':'私密空间恢复成功',helper?'已帮对方找回空间':'可以继续聊天了',`<p>${helper?'你的本机聊天保留，无需重新恢复记录。':'此设备尚无旧聊天，之后可导入自己的备份。'}</p><aside class="prototype-status"><strong>${copy}</strong><p>其他旧设备仍需重新授权；已保存副本不能远程销毁。</p></aside>`,button(helper?'view-code':'history-entry',helper?'查看恢复码':'恢复聊天记录')+button('finish-chat',helper?'继续聊天':'先聊一会儿','text-button'),'finish-chat','返回聊天');
  }
  function devicePage() {
    const states={
      waiting:['等待已有设备批准','请在原设备上核对相同的六位安全码，并允许这台设备加入。'],
      offline:['暂时无法检查批准状态','联网后会自动检查，申请仍保留，不需要重新生成链接。'],
      checking:['正在检查批准状态','正在读取原申请的结果，请稍候。'],
      installing:['已获批准，正在准备聊天','只有本机安全安装完成后，才可以开始收发。'],
      failed:['接入准备暂未完成','原设备的批准仍有效。重试会继续同一申请，不重复加入。'],
      expired:['这次设备申请已过期','请在原设备核对申请状态，必要时重新生成添加设备链接。'],
      denied:['这次设备申请未获允许','请在原设备核对原因。此设备尚不能进入聊天。']
    };
    const [title,copy]=states[state.devicePhase];
    const final=['expired','denied'].includes(state.devicePhase);
    const footer=state.devicePhase==='installing'?button('none','正在准备…','primary-button',true):final?button('device-restart','返回添加入口','secondary-button'):button('device-check',state.devicePhase==='failed'?'重试准备聊天':'立即检查','primary-button',state.busy);
    return page('添加设备',title,`<p>空间：私密空间1 · 这台设备：审阅新浏览器</p><p>${copy}</p>${!final?'<div class="device-safety-code" aria-label="设备安全码 315842">315842</div>':''}${!final?'<p class="prototype-countdown">原设备批准后将自动继续。申请有效期以服务确认结果为准。</p>':''}<aside class="prototype-status"><p>这台设备使用独立保护，只能读取加入后的新消息。</p></aside>`,footer+(final?'':button('lock','锁定，稍后继续','text-button')),'lock','锁定，稍后继续');
  }
  function render() {
    controls();
    const sidebar=document.querySelector('#space-sidebar');
    sidebar.hidden=['locked','home','device-entry','device-wait','repair-entry','repair-wait'].includes(state.page)||state.taskStarted;
    sidebar.innerHTML=sidebar.hidden?'':'<h2>私密空间</h2><a href="#" class="space-item" data-action="spaces" aria-current="page">私密空间1<small>当前空间</small></a><p class="review-limit">仅模拟当前空间，未加载其他空间历史。</p>';
    if (state.page==='chat') surface.innerHTML=chat();
    else if(state.page==='new-chat') surface.innerHTML=chat(true);
    else if(state.page==='recovery-entry') surface.innerHTML=recoveryEntry();
    else if(state.page==='progress') surface.innerHTML=progress();
    else if(state.page==='complete') surface.innerHTML=completion();
    else if(state.page==='repair-entry') surface.innerHTML=page('修复这台设备','建立新的设备入口','<p>空间：私密空间1。发起修复的已授权设备需要核对并批准。</p><aside class="prototype-status"><strong>批准后会替换指定的旧设备</strong><p>新端使用独立保护，只接收修复后的新消息，不自动恢复旧记录。</p></aside>'+(state.authError?'<p class="form-error" role="alert">验证已取消，尚未提交修复申请。</p>':''),button('repair-claim','设置本机保护')+button('back','取消并返回聊天','text-button'));
    else if(state.page==='repair-wait') surface.innerHTML=page('设备修复','等待发起方批准','<div class="device-safety-code" aria-label="设备安全码 315842">315842</div><p>请在发起修复的设备核对六位安全码。此页不自动批准或替换旧设备。</p>',button('lock','锁定，稍后继续','secondary-button'),'lock','锁定，稍后继续');
    else if(state.page==='invite-error') surface.innerHTML=page('邀请未打开','此邀请无法用于当前空间','<p>邀请无效或与当前空间不匹配。当前空间、草稿和设备关系保持原样。</p>',button('back','返回原聊天'));
    else if(state.page==='locked') surface.innerHTML=page('已锁定','解锁后继续',`<p>${state.taskStarted||state.requestId||state.repairStarted?'已提交的任务保持原状态，锁定不表示撤销授权。':'尚未建立任务。临时恢复输入已清除，解锁后需重新输入或重开邀请。'}</p>${state.authError?'<p class="form-error" role="alert">验证已取消，尚未解锁。你可以重试。</p>':''}`,button('unlock','解锁并继续')+button('locked-home','返回入口','text-button'),'locked-home','返回入口');
    else if(state.page==='home') surface.innerHTML=page('私密空间','在此浏览器继续','<p>当前页面已锁定，请使用原本的保护方式验证。</p>',button('unlock','验证并继续'),'locked-home','返回入口');
    else if(state.page==='spaces') surface.innerHTML=page('私密空间','选择空间','<div class="recovery-flow-group"><button class="recovery-flow-row" data-action="return-space"><span><strong>私密空间1</strong><small>仅返回当前设备的本机空间</small></span><b>›</b></button></div>',button('return-space','返回原空间','text-button'),'return-space','返回原空间');
    else if(state.page==='access-help') surface.innerHTML=page('接入说明','从已授权设备核对',`<p>空间：私密空间1 · 此浏览器</p><ol class="recovery-flow-list"><li>在另一台已授权设备打开并解锁此空间。</li><li>在“已连接设备”核对当前接入状态，使用适用的添加或修复流程。</li><li>按新链接设置独立保护，并由有权设备明确批准。</li></ol><aside class="prototype-status"><p>新端不会自动获取本机旧记录或未发送内容。若没有可用入口，需要双方共同恢复。</p></aside>`,button('back','返回本机记录','secondary-button')+button('spaces','返回空间列表','text-button'));
    else if(state.page==='device-entry') surface.innerHTML=page('添加设备','在此浏览器加入','<p>请先设置本机独立保护，随后由原设备核对并批准。</p><aside class="prototype-status"><p>每人在此空间最多三台设备。新设备不会取得加入前聊天。</p></aside>'+ (state.authError?'<p class="form-error" role="alert">验证已取消，尚未提交申请。</p>':''),button('device-claim','设置本机保护')+button('spaces','取消并返回入口','text-button'),'spaces','返回入口');
    else if(state.page==='device-wait') surface.innerHTML=devicePage();
    else if(state.page==='history') surface.innerHTML=page('恢复聊天记录','另行导入自己的备份','<p>这是现有历史恢复入口的占位，不模拟下载、导入或成功。普通新设备接入仍不取得旧历史。</p>',button('finish-chat','返回聊天'));
    else if(state.page==='view-code') surface.innerHTML=page('查看我的恢复码','先验证，再查看','<p>查看恢复码需要本次操作的独立验证。此原型不会调用系统或展示真实材料。</p>',button('show-demo-code','模拟验证通过')+button('complete-back','取消并返回','text-button'),'complete-back','返回完成页');
    if(state.modal) renderModal();
    const timeline=surface.querySelector('.prototype-timeline');
    if(timeline && state.returnScroll) timeline.scrollTop=state.returnScroll;
  }
  function renderModal() {
    const preparing=['fetching','preparing'].includes(state.modal);
    const editing=['input','invalid'].includes(state.modal);
    const selecting=state.modal==='selecting';
    const retrying=state.modal==='retry';
    const final=state.modal==='terminal';
    const content=editing?`<label class="recovery-flow-label" for="code">我的恢复码<textarea id="code" class="recovery-flow-input recovery-flow-textarea" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" required aria-describedby="code-error"${state.modal==='invalid'?' aria-invalid="true"':''} placeholder="粘贴保存的恢复码">${escape(state.input)}</textarea></label>`:selecting?`<label class="recovery-flow-label" for="target">选择要恢复的空间<select id="target" class="recovery-flow-input">${state.choices.map(name=>`<option>${escape(name)}</option>`).join('')}</select></label>`:preparing?`<p role="status">${state.modal==='fetching'?'正在读取恢复目录…':'正在准备共同恢复…'}</p>`:retrying?'<p class="field-hint">恢复码仅在此页临时保留。关闭、锁定或离开会清除。</p>':'';
    const actions=editing?'<button type="submit" class="primary-button">继续</button>':selecting?button('prepare','恢复此空间'):retrying?button('code-retry',state.cooldown?`${state.cooldown}秒后重试`:'重试','primary-button',Boolean(state.cooldown))+button('reenter','重新输入','text-button'):final?button('reenter','重新输入'):button('none','请稍候…','primary-button',true);
    surface.insertAdjacentHTML('beforeend',`<section class="prototype-sheet" role="dialog" aria-modal="true" aria-label="输入恢复码"><form class="confirm-dialog recovery-code-panel"><div class="recovery-code-heading"><span></span><h2>输入恢复码</h2><button type="button" class="icon-button" data-action="close-code" aria-label="关闭恢复输入">${closeIcon}</button></div>${content}<p id="code-error" class="form-error" role="alert">${escape(state.error)}</p>${actions}</form></section>`);
  }
  function returnToChat() {
    invalidate(); clearMaterial(); state.notice='';
    state.page='chat'; render(); focus('#composer');
    queueMicrotask(()=>surface.querySelector('#composer')?.setSelectionRange(...state.returnSelection));
  }
  function invitation(kind) {
    if(state.taskStarted || state.requestId || state.repairStarted) {
      state.notice='当前任务尚未完成。新邀请未打开，请完成当前任务后重新打开新邀请。'; render(); announce(state.notice); return;
    }
    const timeline=surface.querySelector('.prototype-timeline');
    if(timeline) state.returnScroll=timeline.scrollTop;
    const composer=surface.querySelector('#composer');
    if(composer) state.returnSelection=[composer.selectionStart,composer.selectionEnd];
    invalidate(); clearMaterial(); state.consumeCount++;
    state.notice='';
    if(state.page==='locked'||state.page==='home') { state.resumePage=kind==='invalid'?'invite-error':kind==='repair'?'repair-entry':'recovery-entry'; state.page='locked'; }
    else state.page=kind==='invalid'?'invite-error':kind==='repair'?'repair-entry':'recovery-entry';
    render(); focus('h1'); announce('邀请已识别，未批准任何操作。');
  }
  function lock() {
    const prior=state.page;
    invalidate(); clearMaterial(); state.authError=false; state.notice='';
    state.resumePage=state.taskStarted?'progress':state.requestId?'device-wait':state.repairStarted?'repair-wait':prior==='device-entry'?'device-entry':prior==='new-chat'?'new-chat':state.flow==='recovery'?'recovery-entry':'chat';
    changePage('locked');
  }
  function unlock() {
    invalidate(); state.authError=false;
    changePage(state.resumePage||'chat');
    if(state.page==='device-wait') { state.devicePhase=state.deviceOffline?'offline':'waiting'; render(); checkDevice(); }
    if(state.page==='progress') maybeComplete();
  }
  function submitCode() {
    if(state.busy) return;
    if(!['QR4-DEMO','QR3-DEMO'].includes(state.input.trim())) {
      state.modal='invalid'; state.error='请粘贴完整的空间恢复码（QR4）或旧版备份恢复码（QR3）。'; render(); focus('#code'); return;
    }
    state.buffer=state.input.trim(); state.material=state.buffer.startsWith('QR4')?'QR4':'new-material';
    state.input=''; requestDirectory();
  }
  function requestDirectory() {
    if(state.busy || !state.buffer) return;
    state.busy=true; state.modal='fetching'; state.error=''; render(); announce('正在读取恢复目录。');
    later(() => {
      state.busy=false;
      if(['503','offline','429'].includes(state.network)) {
        state.modal='retry'; state.error=state.network==='429'?'请求较多，请等待服务规定的时间后重试。':'暂时无法读取恢复目录，请检查网络后重试。';
        state.cooldown=state.network==='429'?3:0; render(); focus('[data-action="reenter"]');
        if(state.cooldown) countdown();
      } else if(['empty','mismatch'].includes(state.network)) {
        state.modal='terminal'; state.buffer=''; state.choices=[];
        state.error=state.network==='empty'?'此码未找到可恢复的空间，请检查保存的材料。':'恢复码与本次邀请的空间不匹配，请输入自己的对应恢复码。'; render(); focus('[data-action="reenter"]');
      } else {
        state.modal='selecting'; state.choices=['私密空间1']; render(); focus('#target');
      }
    },700);
  }
  function countdown() {
    later(() => { if(state.modal!=='retry') return; state.cooldown=Math.max(0,state.cooldown-1); render(); if(state.cooldown) countdown(); else focus('[data-action="code-retry"]'); },1000);
  }
  function prepare() {
    if(state.busy || state.modal!=='selecting') return;
    state.busy=true; state.modal='preparing'; render();
    later(() => { state.busy=false; state.taskStarted=true; clearMaterial(); changePage('progress'); },700);
  }
  function maybeComplete() {
    if(!state.taskStarted || !state.ownApproved || !state.peerApproved || state.page!=='progress' || state.busy) return;
    state.busy=true; state.error=''; render();
    later(() => {
      state.busy=false;
      if(state.finishFailure) { state.finishFailure=false; state.error='暂时未能确认恢复完成。保留原任务，请重试；尚未宣称保护已更新。'; render(); }
      else { state.taskStarted=false; changePage('complete'); announce('共同恢复完成。'); }
    },900);
  }
  function scheduleCheck() {
    if(checkTimer!==null) { clearTimeout(checkTimer); timers.delete(checkTimer); }
    checkTimer=later(()=>{ checkTimer=null; checkDevice(); },3000);
  }
  function checkDevice() {
    if(state.page!=='device-wait' || state.busy || ['expired','denied'].includes(state.devicePhase)) return;
    if(checkTimer!==null) { clearTimeout(checkTimer); timers.delete(checkTimer); checkTimer=null; }
    state.checks++;
    if(state.deviceOffline) { state.devicePhase='offline'; render(); scheduleCheck(); return; }
    state.busy=true; state.devicePhase='checking'; render();
    later(() => {
      state.busy=false;
      if(state.denied) { state.devicePhase='denied'; render(); return; }
      if(state.approved) {
        state.busy=true; state.devicePhase='installing'; render();
        later(() => {
          state.busy=false;
          if(state.installFailure) { state.installFailure=false; state.devicePhase='failed'; render(); return; }
          state.joins++; state.requestId=null; state.draft=''; changePage('new-chat','#composer'); announce('此设备已接入，只能读取加入后的新消息。');
        },700); return;
      }
      if(state.expired) { state.devicePhase='expired'; render(); return; }
      state.devicePhase='waiting'; render(); scheduleCheck();
    },500);
  }
  function claimDevice() {
    invalidate(); state.authError=false; state.requestId=`演示请求${String(++requestSequence).padStart(2,'0')}`; state.approved=false; state.expired=false; state.denied=false; state.devicePhase='waiting';
    changePage('device-wait'); scheduleCheck();
  }
  function handle(action) {
    switch(action) {
      case 'invite-recovery': invitation('recovery'); break;
      case 'invite-repair': invitation('repair'); break;
      case 'invite-invalid': invitation('invalid'); break;
      case 'back': returnToChat(); break;
      case 'spaces': if(state.taskStarted||state.requestId||state.repairStarted) { lock(); break; } invalidate(); clearMaterial(); changePage('spaces'); break;
      case 'return-space': changePage(state.taskStarted?'progress':state.requestId?'device-wait':state.repairStarted?'repair-wait':state.flow==='device'&&state.joins?'new-chat':'chat','#composer'); break;
      case 'open-code': state.modal='input'; state.error=''; render(); focus('#code'); break;
      case 'close-code': invalidate(); clearMaterial(); render(); focus('[data-action="open-code"]'); break;
      case 'reenter': invalidate(); clearMaterial(); state.modal='input'; render(); focus('#code'); break;
      case 'code-retry': if(!state.cooldown) requestDirectory(); break;
      case 'prepare': prepare(); break;
      case 'own-confirm': state.ownApproved=true; render(); maybeComplete(); break;
      case 'peer-confirm': state.peerApproved=true; render(); maybeComplete(); break;
      case 'complete-retry': maybeComplete(); break;
      case 'finish-fail': state.finishFailure=true; announce('下一次完成请求将模拟失败。'); break;
      case 'dismiss-notice': state.notice=''; render(); break;
      case 'lock': lock(); break;
      case 'unlock': unlock(); break;
      case 'locked-home': state.page='home'; render(); break;
      case 'auth-cancel': if(['device-entry','repair-entry','locked','home'].includes(state.page)) { state.authError=true; render(); announce('验证已取消。'); } break;
      case 'repair-claim': state.authError=false; state.repairStarted=true; changePage('repair-wait'); break;
      case 'repair-approve': if(state.repairStarted&&state.page==='repair-wait') { state.busy=true; later(()=>{ state.busy=false; state.repairStarted=false; state.draft=''; changePage('new-chat','#composer'); },900); } break;
      case 'access-help': changePage('access-help'); break;
      case 'update': state.notice='演示更新完成；将重新核对原设备接入状态。'; state.access='connected'; render(); break;
      case 'device-claim': claimDevice(); break;
      case 'device-approve': if(state.requestId&&!state.expired&&!state.denied) { state.approved=true; announce('模拟原设备已明确批准，等待新端读取并安装。'); } break;
      case 'device-check': checkDevice(); break;
      case 'device-offline': state.deviceOffline=!state.deviceOffline; invalidate(); if(state.page==='device-wait') checkDevice(); controls(); break;
      case 'device-expire': state.expired=true; invalidate(); if(state.page==='device-wait') checkDevice(); break;
      case 'device-deny': state.denied=true; invalidate(); if(state.page==='device-wait') checkDevice(); break;
      case 'install-fail': state.installFailure=true; announce('下一次安装将模拟失败一次。'); break;
      case 'device-restart': invalidate(); state.requestId=null; changePage('device-entry'); break;
      case 'finish-chat': state.draft=''; state.page=state.role==='helper'?'chat':'new-chat'; render(); focus('#composer'); break;
      case 'history-entry': changePage('history'); break;
      case 'view-code': changePage('view-code'); break;
      case 'complete-back': changePage('complete'); break;
      case 'show-demo-code': state.notice='演示材料：DEMO ONLY（不是有效恢复码）'; changePage('complete'); surface.querySelector('.prototype-content').insertAdjacentHTML('beforeend','<p role="status">DEMO ONLY · 非有效恢复码</p>'); break;
    }
  }
  function reset(flow) {
    if(state) invalidate(); state=initial(flow); epoch++;
    if(innerWidth<=760) consolePanel.open=false;
    render();
  }
  flowPicker.addEventListener('change',()=>reset(flowPicker.value));
  document.querySelector('#reset').addEventListener('click',()=>reset(flowPicker.value));
  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-action]');
    if(trigger && !trigger.disabled) { event.preventDefault(); handle(trigger.dataset.action); }
    if(event.target.classList.contains('prototype-sheet')) handle('close-code');
  });
  conditions.addEventListener('change',event=>{
    const id=event.target.id;
    if(id==='access') {
      if(terminal()&&['connected','offline'].includes(event.target.value)) { state.notice='当前设备的接入已失效，恢复网络不能重新开放发送。可重置演示查看普通断网分支。'; render(); return; }
      state.access=event.target.value;
      for(const message of state.messages) if(message.status==='等待发送'||message.status==='此设备无法发送') {
        if(terminal()) message.status='此设备无法发送';
        else if(state.access==='connected') message.status='服务器已保存';
      }
      render();
    }
    else if(id==='network') state.network=event.target.value;
    else if(id==='role'&&!state.taskStarted) { state.role=event.target.value; render(); }
  });
  surface.addEventListener('input',event=>{ if(event.target.id==='composer') state.draft=event.target.value; if(event.target.id==='code') state.input=event.target.value; });
  surface.addEventListener('submit',event=>{
    event.preventDefault();
    if(event.target.matches('.prototype-composer')) {
      if(terminal() || !state.draft.trim()) return;
      state.messages.push({text:state.draft,status:state.access==='offline'?'等待发送':'服务器已保存'});
      state.draft=''; render(); focus('#composer');
    } else if(event.target.matches('.recovery-code-panel')) submitCode();
  });
  document.addEventListener('keydown',event=>{
    const modal=surface.querySelector('[role="dialog"]');
    if(!modal) return;
    if(event.key==='Escape') { event.preventDefault(); handle('close-code'); }
    if(event.key==='Tab') {
      const items=[...modal.querySelectorAll('button:not(:disabled),textarea,select')].filter(el=>el.offsetParent);
      const index=items.indexOf(document.activeElement);
      if(event.shiftKey&&index<=0) { event.preventDefault(); items.at(-1)?.focus(); }
      else if(!event.shiftKey&&(index===items.length-1||index<0)) { event.preventDefault(); items[0]?.focus(); }
    }
  });
  document.addEventListener('visibilitychange',()=>{ if(document.hidden && state.modal) lock(); else if(!document.hidden&&state.page==='device-wait') { invalidate(); checkDevice(); } });
  window.addEventListener('pagehide',()=>{ invalidate(); clearMaterial(); });
  // Only non-secret flags/counters are exposed for prototype verification.
  window.prototypeStatus=()=>({flow:state.flow,page:state.page,hasRetryBuffer:Boolean(state.buffer),hasInput:Boolean(state.input),choices:state.choices.length,requestId:state.requestId,checks:state.checks,joins:state.joins,consumeCount:state.consumeCount});
  reset('nav');
})();
