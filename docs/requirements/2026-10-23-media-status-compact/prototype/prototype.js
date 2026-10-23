/* V1 design simulation. Public/local sample assets only; no application boot,
 * service worker, business API, storage, encryption or real receipt generation. */
(() => {
  'use strict';
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function icon(name) {
    const nodes = (window.PROTOTYPE_ICONS[name] || window.PROTOTYPE_ICONS.CircleHelp)[2];
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${nodes.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([key]) => key !== 'key').map(([key, value]) => `${key}="${escape(value)}"`).join(' ')}></${tag}>`).join('')}</svg>`;
  }
  $$('[data-icon]').forEach(node => node.innerHTML = icon(node.dataset.icon));

  const systemReduced = matchMedia('(prefers-reduced-motion: reduce)');
  const settings = { mode:'send', size:'compact', reduced:systemReduced.matches, slow:1, autoHide:false, view:'compare' };
  const sending = ['preparing','offline','uploading','submitting','stored','delivered','read','upload-failed','send-failed','paused','removed'];
  const receiving = ['queued','downloading','decrypting','decoding','ready','revealed','download-failed','process-failed','poster-missing','unavailable'];
  const mainSend = ['preparing','uploading','submitting','stored','delivered','read'];
  const mainReceive = ['queued','downloading','decrypting','decoding','ready','revealed'];
  const stages = {
    preparing:{label:'准备中',text:'读取附件信息，并在本机准备安全预览。没有可计算比例，不显示假百分比。'},
    offline:{label:'等待连接',text:'已选择附件，但尚未完成发送。这里用静态状态说明等待连接，不画发送勾；演示中的附件仅在本页内存。'},
    uploading:{label:'上传中',text:'四类附件都保留原位宿主，24px胶囊显示当前处理比例。上传100%之后还需要消息提交与服务确认。'},
    submitting:{label:'发送中',text:'附件已上传，消息仍在等待服务确认。此阶段没有发送勾，重试只重试消息提交。'},
    stored:{label:'服务已保存',text:'20px时间行＋单勾，只说明服务保存了加密消息，不代表对方设备已经收到。'},
    delivered:{label:'对方设备已收到',text:'仍使用单勾，详细事实与服务保存分开。双勾继续留给有效的已读回执。'},
    read:{label:'对方已读',text:'20px时间行＋双勾。媒体已读依赖显现与加载回执；视频已读不等于已播放，文件已读不等于正文已阅读。'},
    'upload-failed':{label:'上传失败',text:'保留附件尺寸、选择与当前比例。点击附件上的重试继续上传；44px操作热区与24px可见底板分开。'},
    'send-failed':{label:'消息提交失败',text:'附件已经上传，重试回到消息提交，避免让用户误以为需要重新上传附件。'},
    paused:{label:'发送暂停',text:'已知接入失效时停止发送，不用旋转环暗示仍在工作，也不承诺会自动恢复。此处仅模拟视觉。'},
    removed:{label:'移除未发送附件',text:'取消移除本机占位，不伪造一条已取消发送的聊天消息。点击重新选择可恢复演示。'},
    queued:{label:'等待加载',text:'附件尚未开始准备，用静态环与24px等待文案；时间事实独立保留在20px时间行。'},
    downloading:{label:'下载中',text:'左侧24px处理进度，右侧20px消息时间。处理状态与消息事实分开放，不互相覆盖。'},
    decrypting:{label:'解密与校验',text:'演示采用稳定的解密与校验文案。实际产品仍必须完成全部分块认证、原长度及摘要校验后才能展示内容。'},
    decoding:{label:'生成安全预览',text:'图片与视频在本机生成安全预览；文件准备受限阅读；表情按自动遮蔽设置准备显示。无真实比例时不画百分比。'},
    ready:{label:'就绪，等待操作',text:'图片与视频仍保持遮蔽，20px提示轻点显示。文件提供打开入口；关闭自动遮蔽的表情直接显示，不套图片遮蔽规则。'},
    revealed:{label:'已显现 / 可打开',text:'图片首次点击显现，再次点击放大；视频之后进入播放器。文件打开模拟阅读页。显现不改变附件几何。'},
    'download-failed':{label:'下载失败',text:'点击原位24px失败胶囊重试下载；失败后重建完整加载反馈，避免现有实现的等待加载卡死问题。'},
    'process-failed':{label:'处理失败',text:'没有通过校验或无法生成显示内容时，不展示未验证的原图。这里演示可恢复的处理失败，永久错误另用内容不可用。'},
    'poster-missing':{label:'视频封面不可用',text:'只影响视频。已验证视频保留明确的预览不可用说明，首次点击改变提示，后续点击播放；其余类型显示通常就绪状态。'},
    unavailable:{label:'内容不可用',text:'仅在已确认的永久不可用事实下呈现此状态，无旋转环或重试。网络中断不能被归为永久不可用。'}
  };

  const assetPaths = {
    photo:'./assets/demo-photo.jpg', video:'./assets/demo-video.mp4',
    expression:'../../../../public/space-avatars/fluent-koala.webp',
    expressionStill:'../../../../public/space-avatars/fluent-koala-still.webp'
  };
  const assets = { photo:assetPaths.photo, photoConcealed:null, videoPoster:null, videoConcealed:null, expressionConcealed:null };
  const samples = [];
  let globalPlaying = false;
  let groupRun = false;
  let lastFocused = null;
  const timers = new Set();
  const duration = value => settings.reduced || systemReduced.matches ? 0 : value * settings.slow;
  const animationEffects = new Set();
  const objectUrls = new Set();
  function makeUrl(blob) { const url = URL.createObjectURL(blob); objectUrls.add(url); return url; }
  function announce(text) { $('#announcer').textContent = text; }

  /* One persistent shell, one outgoing snapshot. Layout commits once; only
   * transforms and opacity interpolate, with inverse scale on the content. */
  class Capsule {
    constructor(parent, className = '') {
      this.host = document.createElement('div'); this.host.className = `capsule-host ${className}`;
      this.surface = document.createElement('div'); this.surface.className = 'capsule-surface';
      this.content = document.createElement('div'); this.content.className = 'capsule-content';
      this.surface.append(this.content);
      this.action = document.createElement('button'); this.action.className = 'capsule-action'; this.action.type = 'button'; this.action.hidden = true;
      this.action.addEventListener('click', event => { event.stopPropagation(); this.onAction?.(); });
      this.action.addEventListener('pointerdown', () => { if (duration(100)) this.surface.animate([{opacity:.7},{opacity:1}],{duration:duration(100)}); });
      this.host.append(this.surface, this.action); parent.append(this.host);
      this.effects = []; this.key = ''; this.ratio = 64; this.options = null;
    }
    stop() { this.effects.forEach(effect => { effect.cancel(); animationEffects.delete(effect); }); this.effects = []; this.surface.querySelectorAll(':scope > .capsule-retiring').forEach(node => node.remove()); }
    paint(options, force = false) {
      this.options = options;
      const { key, html, complete = false, tone = '', neutral = false, action, label = '' } = options;
      if (this.key === key && !force && !this.host.hidden) { this.progress(options.ratio); return; }
      const before = this.surface.getBoundingClientRect();
      const visible = !this.host.hidden && this.host.isConnected;
      const old = visible && this.content.childNodes.length ? this.content.cloneNode(true) : null;
      if (old) { old.style.opacity = '1'; old.style.transform = 'none'; old.style.scale = 'none'; old.querySelectorAll('[id]').forEach(node => node.removeAttribute('id')); }
      const background = getComputedStyle(this.surface).backgroundColor;
      this.stop(); this.key = key; this.host.hidden = false;
      this.surface.dataset.complete = String(complete); this.surface.dataset.tone = tone; this.surface.dataset.neutral = String(neutral);
      this.content.innerHTML = html;
      this.surface.setAttribute('aria-label', label);
      this.action.hidden = !action; this.onAction = action;
      if (action) this.action.setAttribute('aria-label', label);
      this.progress(options.ratio);
      const after = this.surface.getBoundingClientRect();
      if (!visible || !old || !before.width || !after.width || !duration(240) || document.hidden) return;
      const sx = before.width / after.width, sy = before.height / after.height;
      const frames = [], inverse = [];
      for (let i = 0; i <= 60; i++) {
        const t = i / 60;
        const ease = 1 - Math.pow(1-t, 4);
        const x = sx + (1-sx)*ease, y = sy+(1-sy)*ease;
        frames.push({transform:`scale(${x},${y})`}); inverse.push({transform:`scale(${1/x},${1/y})`});
      }
      const opts = {duration:duration(240),easing:'linear',fill:'backwards'};
      const retiring = document.createElement('div'); retiring.className = 'capsule-retiring'; retiring.inert = true; retiring.setAttribute('aria-hidden','true'); retiring.append(old); this.surface.append(retiring);
      const effects = [this.surface.animate(frames,opts), this.content.animate(inverse,opts), retiring.animate(inverse,opts),
        this.content.animate([{opacity:0},{opacity:1}],{duration:duration(180),fill:'backwards'}),
        retiring.animate([{opacity:1},{opacity:0}],{duration:duration(180),fill:'forwards'})];
      const nextBackground = getComputedStyle(this.surface).backgroundColor;
      if (background !== nextBackground) effects.push(this.surface.animate([{backgroundColor:background},{backgroundColor:nextBackground}],{duration:duration(180),fill:'backwards'}));
      this.effects = effects; effects.forEach(effect => animationEffects.add(effect));
      Promise.allSettled(effects.map(effect => effect.finished)).then(() => {
        retiring.remove(); effects.forEach(effect => animationEffects.delete(effect));
        if (this.effects === effects) this.effects = [];
      });
    }
    progress(value) {
      if (value === undefined) return;
      this.ratio = value;
      const ring = $('.ring',this.content), percent = $('.percent',this.content);
      if (ring) { ring.style.setProperty('--progress',`${value}%`); ring.setAttribute('aria-valuenow',String(Math.round(value))); }
      if (percent) percent.textContent = `${Math.round(value)}%`;
    }
    hide() { this.stop(); this.host.hidden = true; }
  }
  function ring(kind = 'unknown', ratio = 64) {
    return `<span class="ring" data-indeterminate="${kind==='unknown'}" data-static="${kind==='static'}" role="progressbar" aria-label="附件处理进度" aria-valuemin="0" aria-valuemax="100" ${kind==='known'?`aria-valuenow="${ratio}"`:''} style="--progress:${ratio}%"></span>`;
  }
  function receiptIcon(read = false) {
    return `<svg viewBox="0 0 22 16" aria-hidden="true"><path d="m2 8 4 4L16 2"/>${read?'<path d="m10 12 10-10"/>':''}</svg>`;
  }
  function isComplete(state) { return ['stored','delivered','read','ready','revealed','poster-missing','unavailable'].includes(state); }
  function hasLoaded(state) { return ['stored','delivered','read','ready','revealed','poster-missing'].includes(state); }
  function directionFor(state) { return receiving.includes(state) ? 'receive' : 'send'; }
  function expressionSource(sample) {
    return settings.reduced || systemReduced.matches ? assetPaths.expressionStill : assetPaths.expression;
  }
  function stageOptions(mode = settings.mode) {
    return (mode === 'send' ? sending : receiving).map(key => `<option value="${key}">${stages[key].label}</option>`).join('');
  }

  const types = [
    {type:'photo',title:'图片',icon:'Image',kind:'JPG · 原比例',name:'山间的一天.jpg',description:'图片保持遮蔽，首次轻点显示，第二次放大。'},
    {type:'video',title:'视频',icon:'Video',kind:'MP4 · 本机封面',name:'花园片段.mp4',description:'视频不自动播放；显现预览后再次点击进入播放器。'},
    {type:'file',title:'文件',icon:'FileText',kind:'PDF · 受限阅读',name:'出行清单.pdf',description:'名称与大小从准备阶段起保留，过程状态就地变化。'},
    {type:'expression',title:'表情',icon:'Smile',kind:'透明 · 动态 WebP',name:'考拉.webp',description:'完成后回到20px透明时间行；遮蔽可单独开关。'}
  ];
  for (const type of types) {
    const root = document.createElement('article'); root.className = 'sample'; root.dataset.type = type.type;
    root.innerHTML = `<header class="sample-heading"><span class="type-icon">${icon(type.icon)}</span><h2>${type.title}</h2><span class="asset-kind">${type.kind}</span></header>
      <div class="sample-canvas"><div class="canvas-caption"><span></span><label>我发送的附件</label></div><div class="message" data-message-id="demo-${type.type}">
      ${type.type==='file'?`<div class="file-body"><div class="file-content"><span class="file-icon">${icon('FileText')}<small>PDF</small></span><span class="file-copy"><strong class="file-name">${type.name}</strong><span class="file-size">2.4 MiB · 原始文件</span></span><button class="file-open" aria-label="打开文件演示" disabled>${icon('Download')}</button></div></div>`:
      `<div class="media-body" data-loaded="true"><button class="preview-button" aria-label="${type.title}预览" disabled><img alt="${type.title}演示素材" draggable="false"></button><div class="media-placeholder">${icon(type.icon)}</div>${type.type==='video'?`<div class="video-badge">${icon('Video')}<span>视频</span></div><span class="video-play">${icon('Play')}</span>`:''}</div>`}
      </div></div><div class="sample-controls"><select class="sample-select" aria-label="${type.title}独立状态">${stageOptions()}</select><button class="replay-one" aria-label="播放${type.title}完整过程" title="独立播放">${icon('Play')}</button></div><p class="sample-caption">${type.description}</p>`;
    $('#samples').append(root);
    const sample = {...type,root,message:$('.message',root),state:'uploading',direction:'send',ratio:64,revealed:false,run:0,playing:false,removed:false};
    sample.status = new Capsule(sample.message, 'processing'); sample.receipt = new Capsule(sample.message, 'receipt'); sample.hint = new Capsule(sample.message, 'privacy-hint');
    samples.push(sample);
    $('.sample-select',root).addEventListener('change',event => { cancelRun(sample); applyState(sample,event.target.value); updateExplanation(sample.state,`${sample.title} · 独立操作`); });
    $('.replay-one',root).addEventListener('click',()=>sample.playing?cancelRun(sample):play(sample));
    $('.preview-button',root)?.addEventListener('click',()=>openMedia(sample));
    $('.file-open',root)?.addEventListener('click',()=>openViewer(sample));
  }

  function applyState(sample,state,{ratio = sample.ratio,force = false} = {}) {
    if (state === 'poster-missing' && sample.type !== 'video') state = 'ready';
    sample.state = state; sample.direction = directionFor(state); sample.ratio = ratio;
    if (!['stored','delivered','read','ready','revealed','poster-missing'].includes(state)) sample.revealed = false;
    if (state === 'revealed') sample.revealed = true;
    sample.root.dataset.direction = sample.direction; sample.root.dataset.state = state;
    if (groupRun && sample.type === 'photo') { $('#global-stage').value = state; updateExplanation(state); }
    $('.canvas-caption label',sample.root).textContent = sample.direction === 'send' ? '我发送的附件' : '对方发来的附件';
    const select = $('.sample-select',sample.root);
    if (![...select.options].some(option => option.value === state)) select.innerHTML = stageOptions(sample.direction);
    select.value = state;
    sample.message.hidden = state === 'removed';
    const canvas = $('.sample-canvas',sample.root);
    let empty = $('.empty-placeholder',canvas);
    if (state === 'removed') {
      sample.status.hide(); sample.receipt.hide(); sample.hint.hide();
      if (!empty) { empty=document.createElement('div');empty.className='empty-placeholder';empty.innerHTML='<span>未发送附件已移除</span><button type="button">重新选择</button>';canvas.append(empty);$('button',empty).onclick=()=>applyState(sample,'preparing'); }
      refreshSummary(); return;
    }
    empty?.remove();
    paintAsset(sample);
    const own = sample.direction === 'send';
    const prefix = sample.type === 'file' ? '文件' : sample.title;
    let text = '',html = '',error=false,action;
    let complete = state==='unavailable', neutral = state==='unavailable';
    const retry = () => {cancelRun(sample); void retrySample(sample);};
    if (state === 'preparing') html = ring()+'<span>准备中</span>';
    if (state === 'offline') {html = icon('WifiOff')+'<span>等待连接</span>';action=()=>{cancelRun(sample);void retrySample(sample);};}
    if (state === 'uploading') html = ring('known',ratio)+'<span>上传中</span><span class="divider">·</span><span class="percent">'+Math.round(ratio)+'%</span>';
    if (state === 'submitting') html = ring()+'<span>发送中</span>';
    if (state === 'paused') html = icon('Clock')+'<span>发送暂停</span>';
    if (state === 'queued') html = ring('static')+'<span>等待加载</span>';
    if (state === 'downloading') html = ring('known',ratio)+'<span>下载中</span><span class="divider">·</span><span class="percent">'+Math.round(ratio)+'%</span>';
    if (state === 'decrypting') html = ring()+'<span>解密与校验</span>';
    if (state === 'decoding') html = ring()+`<span>${sample.type==='video'?'生成视频预览':sample.type==='file'?'准备阅读':sample.type==='expression'&&!settings.autoHide?'准备显示':'生成模糊预览'}</span>`;
    if (state === 'upload-failed') {text='上传失败';error=true;}
    if (state === 'send-failed') {text='发送失败';error=true;}
    if (state === 'download-failed') {text='下载失败';error=true;}
    if (state === 'process-failed') {text='处理失败';error=true;}
    if (error) {html=`<span>${text}</span><span class="divider">·</span><span>重试</span>`;action=retry;}
    if (state === 'unavailable') html='<span>内容不可用</span>';
    if (own && ['stored','delivered','read'].includes(state)) {
      html=`<time datetime="2026-10-23T16:20:00+08:00">16:20</time>${receiptIcon(state==='read')}`;
      complete=true;
    }
    const wantsConceal = sample.type!=='file' && hasLoaded(state) && !sample.revealed && (sample.type!=='expression'||settings.autoHide);
    if (!own && wantsConceal) {
      const hint=state==='poster-missing'?'预览不可用 · 继续':'轻点显示';
      html=`<span>${hint}</span>`; complete=true;neutral=true;action=()=>openMedia(sample);
    } else if (!own && state==='poster-missing' && sample.revealed) {
      html='<span>轻点播放</span>';complete=true;neutral=true;action=()=>openViewer(sample);
    }
    if (html) {
      sample.status.host.classList.toggle('processing',!own);
      const actionLabel=state==='poster-missing'?(sample.revealed?'视频预览不可用，点击播放':'视频预览不可用，点击继续'):`${prefix}${stages[state].label}${action?(wantsConceal?'，点击显示':'，点击'+(state==='offline'?'恢复连接演示':'重试')):''}`;
      sample.status.paint({key:state+'-'+sample.revealed,html,tone:error?'error':'',complete,neutral,ratio:sample.ratio,action,label:actionLabel},force);
    } else sample.status.hide();

    if (!own) {
      sample.receipt.paint({key:'receipt-'+(own?state:'received'),html:`<time datetime="2026-10-23T16:20:00+08:00">16:20</time>${own?receiptIcon(state==='read'):''}`,complete:true,label:own?stages[state].text:'对方发送消息的时间16:20'},force);
    } else sample.receipt.hide();
    const imageLike = sample.type !== 'file';
    const shouldConceal = own && imageLike && hasLoaded(state) && !sample.revealed && (sample.type !== 'expression' || settings.autoHide);
    if (shouldConceal) {
      const missing = state==='poster-missing';
      const hint = missing?(sample.revealed?'轻点播放':'预览不可用 · 轻点继续'):'轻点显示';
      sample.hint.paint({key:missing?'poster-hint':'reveal-hint',html:`<span>${hint}</span>`,complete:true,neutral:true,action:()=>openMedia(sample),label:`${prefix}，${hint}`},force);
    } else if (own && state==='poster-missing' && sample.revealed) {
      sample.hint.paint({key:'poster-play',html:'<span>轻点播放</span>',complete:true,neutral:true,action:()=>openViewer(sample),label:'视频预览不可用，点击播放'},force);
    } else sample.hint.hide();
    if (sample.type==='expression') {
      // Expressions use the same process size and a transparent completion row.
      sample.hint.host.style.bottom = shouldConceal?'25px':'';
    }
    const notes = {
      'upload-failed':'<strong>点击胶囊重试</strong>，继续本条附件，保留上传比例。',
      'send-failed':'<strong>只重试消息提交</strong>，附件不重新上传。',
      'download-failed':'<strong>点击胶囊重试</strong>，完整重建加载反馈并进入就绪。',
      'process-failed':'处理失败时保持遮蔽，重试成功后才允许显现。',
      unavailable:'已确认永久不可用，不显示无效重试。',
      offline:'等待连接使用静态标识；点击胶囊演示恢复连接。',
      paused:'接入失效时明确暂停，不用旋转环暗示工作中。',
      stored:'单勾：服务已保存；<strong>不等于对方设备收到</strong>。',
      delivered:'继续使用单勾；已送达与已读事实分开。',
      read:sample.type==='file'?'双勾表示消息已显示，<strong>不代表文件正文已阅读</strong>。':sample.type==='video'?'双勾表示收到有效显现回执，<strong>不等于已播放</strong>。':'双勾仅表示有效的已读回执。'
    };
    $('.sample-caption',sample.root).innerHTML = notes[state] || sample.description;
    refreshSummary();
  }

  function paintAsset(sample) {
    if (sample.type === 'file') {
      $('.file-open',sample.root).disabled = !hasLoaded(sample.state);
      $('.file-size',sample.root).textContent = hasLoaded(sample.state)?'2.4 MiB · 打开文件':'2.4 MiB · 原始文件';
      return;
    }
    const preview = $('.preview-button',sample.root), image = $('img',preview), body = $('.media-body',sample.root), placeholder=$('.media-placeholder',sample.root);
    const hasPreview = !['queued','downloading','decrypting','decoding','download-failed','process-failed','unavailable','poster-missing'].includes(sample.state);
    const showOriginal = sample.revealed || sample.type==='expression'&&!settings.autoHide;
    let source;
    if (sample.type==='photo') source=showOriginal?assets.photo:assets.photoConcealed;
    if (sample.type==='video') source=showOriginal?assets.videoPoster:assets.videoConcealed;
    if (sample.type==='expression') source=showOriginal?expressionSource(sample):assets.expressionConcealed;
    if (source && image.getAttribute('src')!==source) image.src=source;
    body.dataset.loaded=String(hasPreview && Boolean(source));
    placeholder.hidden = hasPreview && Boolean(source);
    preview.disabled = !hasLoaded(sample.state);
    preview.setAttribute('aria-label',sample.state==='poster-missing'?(sample.revealed?'播放视频':'视频预览不可用，点击继续'):sample.revealed?`${sample.type==='video'?'播放':'放大查看'}${sample.title}`:`${sample.type==='expression'&&!settings.autoHide?'查看':'显示'}${sample.title}`);
    const play=$('.video-play',sample.root);if(play)play.hidden=!hasLoaded(sample.state);
    if (sample.state==='poster-missing') {body.dataset.loaded='false';$('.video-play',sample.root).hidden=false;}
  }
  function openMedia(sample) {
    if (!hasLoaded(sample.state)) return;
    if (sample.state==='poster-missing'&&!sample.revealed) {sample.revealed=true;applyState(sample,'poster-missing');announce('视频预览不可用，再次点击播放');return;}
    if (!sample.revealed && (sample.type!=='expression'||settings.autoHide)) {
      sample.revealed=true;
      if(sample.direction==='receive'&&sample.state!=='poster-missing')applyState(sample,'revealed');else applyState(sample,sample.state);
      announce(`${sample.title}已显示，再次点击${sample.type==='video'?'播放':'放大查看'}`);return;
    }
    openViewer(sample);
  }
  function openViewer(sample) {
    const viewer=$('#viewer'),body=$('#viewer-body');lastFocused=document.activeElement;$('#viewer-title').textContent=sample.name;
    if(sample.type==='video') {const video=document.createElement('video');video.src=assetPaths.video;video.controls=true;video.playsInline=true;video.setAttribute('aria-label','公开花园视频演示');body.replaceChildren(video);}
    else if(sample.type==='file') body.innerHTML='<article class="document-demo"><p class="eyebrow">PDF · 模拟阅读</p><h2>周末出行清单</h2><p>仅供界面演示，未解析或下载真实文档。</p><ul><li>检查天气，带上薄外套</li><li>相机、电池与充电器</li><li>在山脚下的车站碰面</li></ul></article>';
    else {const image=new Image();image.src=sample.type==='expression'?expressionSource(sample):assets.photo;image.alt=sample.name;body.replaceChildren(image);}
    viewer.showModal();$('#close-viewer').focus();
  }
  function closeViewer() {const viewer=$('#viewer');const video=$('video',viewer);if(video){video.pause();video.removeAttribute('src');video.load();}viewer.close();$('#viewer-body').replaceChildren();lastFocused?.focus?.({preventScroll:true});}
  $('#close-viewer').addEventListener('click',closeViewer);$('#viewer').addEventListener('cancel',event=>{event.preventDefault();closeViewer();});$('#viewer').addEventListener('click',event=>{if(event.target===$('#viewer'))closeViewer();});

  function updateExplanation(stage,subtitle) {$('#phase-title').textContent=subtitle||stages[stage].label;$('#phase-description').textContent=stages[stage].text;$$('.stage-step').forEach(button=>button.classList.toggle('active',button.dataset.stage===stage));}
  function refreshSummary() {
    if(groupRun || samples.length!==4)return;
    const common=samples.every(sample=>sample.state===samples[0].state),stage=samples[0].state,select=$('#global-stage');
    if(common && [...select.options].some(option=>option.value===stage)){select.value=stage;updateExplanation(stage);}
    else{select.value='';$('#phase-title').textContent='独立状态对照';$('#phase-description').textContent='四类附件处于不同阶段，可分别切换、重试和查看；选择统一状态可再次同步。';$$('.stage-step').forEach(button=>button.classList.remove('active'));}
  }
  function syncAll(stage) {samples.forEach(sample=>{cancelRun(sample);sample.revealed=false;applyState(sample,stage,{ratio:64});});$('#global-stage').value=stage;updateExplanation(stage);}
  function setMode(mode,stage) {
    stopAll();settings.mode=mode;
    $$('[data-mode]').forEach(button=>{const selected=button.dataset.mode===mode;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
    $('#global-stage').innerHTML='<option value="" disabled>各自状态</option>'+stageOptions();
    const steps=mode==='send'?mainSend:mainReceive;
    $('#stage-strip').innerHTML=steps.map((key,index)=>`${index?`<span class="stage-arrow">${icon('ArrowRight')}</span>`:''}<button class="stage-step" data-stage="${key}">${stages[key].label}</button>`).join('');
    $$('.sample-select').forEach(select=>select.innerHTML=stageOptions());
    syncAll(stage||(mode==='send'?'uploading':'downloading'));
  }
  function view(name) {settings.view=name;$$('[data-view]').forEach(button=>{button.classList.toggle('selected',button.dataset.view===name);button.setAttribute('aria-pressed',String(button.dataset.view===name));});for(const key of ['compare','matrix','flow'])$(`#${key}-view`).hidden=key!==name;}
  function updatePlaying() {const playing=samples.some(sample=>sample.playing);globalPlaying=playing;$('#play-label').textContent=playing?'暂停演示':'播放完整过程';$('#play-all [data-icon]').innerHTML=icon(playing?'Pause':'Play');samples.forEach(sample=>{const button=$('.replay-one',sample.root);button.innerHTML=icon(sample.playing?'Pause':'Play');button.setAttribute('aria-label',`${sample.playing?'暂停':'播放'}${sample.title}完整过程`);});}
  function cancelRun(sample) {sample.run++;sample.playing=false;updatePlaying();}
  function stopAll() {groupRun=false;samples.forEach(sample=>{sample.run++;sample.playing=false;});timers.forEach(timer=>clearTimeout(timer));timers.clear();updatePlaying();}
  function wait(ms,sample,run) {return new Promise(resolve=>{const timer=setTimeout(()=>{timers.delete(timer);resolve(sample.run===run&&!document.hidden);},ms*settings.slow);timers.add(timer);});}
  async function progress(sample,stage,run,from=8) {
    applyState(sample,stage,{ratio:from});
    for(let value=from;value<=100;value+=4) {if(sample.run!==run||document.hidden)return false;sample.ratio=Math.min(100,value);sample.status.progress(sample.ratio);if(!await wait(65,sample,run))return false;}
    sample.ratio=100;sample.status.progress(100);return sample.run===run;
  }
  async function step(sample,stage,run,delay=750) {if(sample.run!==run)return false;applyState(sample,stage);return wait(delay,sample,run);}
  async function completeSend(sample,run) {if(!await step(sample,'submitting',run,850))return;if(!await step(sample,'stored',run,900))return;if(!await step(sample,'delivered',run,850))return;await step(sample,'read',run,100);}
  async function completeReceive(sample,run) {if(!await step(sample,'decrypting',run,650))return;if(!await step(sample,'decoding',run,850))return;await step(sample,'ready',run,100);}
  async function play(sample) {
    cancelRun(sample);const run=sample.run;sample.playing=true;sample.revealed=false;updatePlaying();const mode=settings.mode;
    if(mode==='send') {if(await step(sample,'preparing',run,700)&&await progress(sample,'uploading',run))await completeSend(sample,run);}
    else {if(await step(sample,'queued',run,650)&&await progress(sample,'downloading',run))await completeReceive(sample,run);}
    if(sample.run===run){sample.playing=false;if(!samples.some(item=>item.playing))groupRun=false;updatePlaying();refreshSummary();announce(`${sample.title}演示已完成`);}
  }
  async function retrySample(sample) {
    const state=sample.state,run=sample.run;sample.playing=true;updatePlaying();
    if(state==='send-failed') await completeSend(sample,run);
    else if(state==='process-failed') await completeReceive(sample,run);
    else if(state==='download-failed') {if(await progress(sample,'downloading',run,Math.min(64,sample.ratio)))await completeReceive(sample,run);}
    else if(await progress(sample,'uploading',run,Math.min(64,sample.ratio)))await completeSend(sample,run);
    if(sample.run===run){sample.playing=false;updatePlaying();refreshSummary();announce(`${sample.title}重试已完成`);}
  }

  $$('[data-mode]').forEach(button=>button.onclick=()=>setMode(button.dataset.mode));
  $$('[data-view]').forEach(button=>button.onclick=()=>view(button.dataset.view));
  $('#global-stage').onchange=event=>syncAll(event.target.value);
  $('#stage-strip').onclick=event=>{const button=event.target.closest('[data-stage]');if(button)syncAll(button.dataset.stage);};
  $('#play-all').onclick=()=>{if(globalPlaying)stopAll();else {groupRun=true;samples.forEach(sample=>void play(sample));}};
  $('#speed').onchange=event=>{stopAll();settings.slow=Number(event.target.value);samples.forEach(sample=>{sample.status.stop();sample.receipt.stop();sample.hint.stop();});};
  $('#show-hitboxes').onchange=event=>document.body.dataset.hitboxes=String(event.target.checked);
  $('#hide-expression').onchange=event=>{settings.autoHide=event.target.checked;const sample=samples.find(item=>item.type==='expression');sample.revealed=false;applyState(sample,sample.state,{force:true});};
  function setReduced(reduced) {settings.reduced=reduced;$('#reduced-motion').checked=reduced;document.body.dataset.reduced=String(reduced);animationEffects.forEach(effect=>{try{effect.finish();}catch{effect.cancel();}});samples.forEach(sample=>applyState(sample,sample.state,{force:true}));}
  $('#reduced-motion').onchange=event=>setReduced(event.target.checked);
  systemReduced.addEventListener('change',event=>setReduced(event.matches));
  $$('[data-size]').forEach(button=>button.onclick=()=>{
    settings.size=button.dataset.size;document.body.dataset.size=settings.size;
    $$('[data-size]').forEach(other=>{const selected=other===button;other.classList.toggle('selected',selected);other.setAttribute('aria-pressed',String(selected));});
    $('#legend-process').textContent=settings.size==='compact'?'24':'32';$('#legend-complete').textContent=settings.size==='compact'?'20':'32';
    samples.forEach(sample=>applyState(sample,sample.state,{force:true}));
  });
  function theme(dark) {document.documentElement.dataset.colorScheme=dark?'dark':'light';$('#theme-toggle').innerHTML=icon(dark?'Sun':'Moon');$('#theme-toggle').setAttribute('aria-label',dark?'切换到浅色':'切换到深色');}
  $('#theme-toggle').onclick=()=>theme(document.documentElement.dataset.colorScheme!=='dark');
  $('#reset-all').onclick=()=>{stopAll();settings.slow=1;$('#speed').value='1';settings.autoHide=false;$('#hide-expression').checked=false;$('#show-hitboxes').checked=false;document.body.dataset.hitboxes='false';setMode('send','uploading');view('compare');announce('已重置为上传中64%');};
  $$('.scenario-bar button').forEach(button=>button.onclick=()=>{
    const stage=button.dataset.scenario;setMode(receiving.includes(stage)?'receive':'send',stage);
  });

  const matrixRows = [
    ['send','preparing','安全占位＋准备中','文件名／大小保留','透明外框＋准备中','24px'],
    ['send','offline','静态等待连接','卡片内等待连接','保留当前预览','24px'],
    ['send','uploading','上传中＋真实处理比例','同一文件卡片内进度','与图片同尺寸过程胶囊','24px'],
    ['send','submitting','发送中，无勾','只等待消息提交','同一胶囊原位过渡','24px'],
    ['send','stored','时间＋单勾','时间＋单勾','透明时间行＋单勾','20px'],
    ['send','delivered','同单勾，事实独立','同单勾','同单勾','20px'],
    ['send','read','时间＋双勾','消息已读不等于正文已读','透明时间行＋双勾','20px'],
    ['send','upload-failed','上传失败 · 重试','原位文件卡片可重试','失败后不增加永久底板','24px / 热区44px'],
    ['send','send-failed','发送失败 · 重试','只重试消息提交','同一消息标识','24px / 热区44px'],
    ['receive','queued','静态环＋等待加载','文件名／大小保留','透明占位，不提前显现','24px＋时间20px'],
    ['receive','downloading','下载中＋比例','卡片内读取进度','保留同一宿主','24px＋时间20px'],
    ['receive','decrypting','解密与校验','校验原始附件','同校验边界','24px＋时间20px'],
    ['receive','decoding','本机生成安全预览','准备受限阅读','按自动遮蔽准备','24px＋时间20px'],
    ['receive','ready','模糊预览＋轻点显示','打开文件入口','自动遮蔽关闭则直接显示','20px'],
    ['receive','revealed','再次点击放大／播放','模拟阅读页','再次点击查看','20px'],
    ['receive','download-failed','下载失败 · 重试','同一卡片可重试','只恢复加载','24px / 热区44px'],
    ['receive','process-failed','保持遮蔽，处理失败','不打开未校验文档','不提前显示内容','24px / 热区44px'],
    ['receive','poster-missing','仅视频：预览不可用','不适用，显示通常就绪','不适用，显示通常就绪','20px'],
    ['receive','unavailable','明确不可用，无重试','同边界','同边界','20px'],
    ['send','paused','发送暂停，无旋转环','同边界','同边界','24px'],
    ['send','removed','移除占位，不造取消消息','同边界','同边界','无胶囊']
  ];
  $('#state-matrix tbody').innerHTML=matrixRows.map(([mode,stage,a,b,c,height])=>`<tr><td><button data-jump-mode="${mode}" data-jump-stage="${stage}">${stages[stage].label}</button></td><td>${a}</td><td>${b}</td><td>${c}</td><td>${height}</td></tr>`).join('');
  const flowLanes=[
    {name:'我发送',mode:'send',steps:[['preparing','本机准备','无勾'],['offline','等待连接','静态等待'],['uploading','加密上传','upload-failed'],['submitting','提交消息','send-failed'],['stored','服务已保存','单勾'],['delivered','对方设备接收','单勾'],['read','有效已读回执','双勾']]},
    {name:'对方发来 / 本机读取',mode:'receive',steps:[['queued','等待加载','静态等待'],['downloading','下载附件','download-failed'],['decrypting','解密与完整性校验','process-failed'],['decoding','生成安全预览 / 准备阅读','本机处理'],['ready','就绪并保持既有遮蔽','20px'],['revealed','首次显现 / 文件打开','按类型操作']]}
  ];
  $('#flow-columns').innerHTML=flowLanes.map(lane=>`<section class="flow-lane"><h3>${lane.name}</h3>${lane.steps.map(([stage,title,detail],index)=>`<div class="flow-step-wrap"><button class="flow-node" data-jump-mode="${lane.mode}" data-jump-stage="${stage}"><span>${String(index+1).padStart(2,'0')}</span><strong>${title}</strong><small>${stages[detail]?'失败分支':detail}</small></button>${stages[detail]?`<div class="flow-branch"><button data-jump-mode="${lane.mode}" data-jump-stage="${detail}">${stages[detail].label}</button><span>→ 原位重试</span></div>`:''}</div>`).join('')}</section>`).join('');
  document.addEventListener('click',event=>{const button=event.target.closest('[data-jump-stage]');if(button){setMode(button.dataset.jumpMode,button.dataset.jumpStage);view('compare');window.scrollTo({top:0,behavior:'instant'});}});

  async function loadImage(source) {const image=new Image();image.src=source;await image.decode();return image;}
  async function concealed(image) {
    // Detached source: no full-resolution original is painted before reveal.
    const small=document.createElement('canvas');small.width=64;small.height=Math.max(1,Math.round(64*image.height/image.width));
    const ctx=small.getContext('2d');ctx.filter='blur(6px)';ctx.drawImage(image,-10,-10,small.width+20,small.height+20);
    const blob=await new Promise(resolve=>small.toBlob(resolve,'image/png'));return makeUrl(blob);
  }
  async function videoPoster() {
    const video=document.createElement('video');video.muted=true;video.preload='auto';video.src=assetPaths.video;
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('视频素材加载超时')),10000);video.onerror=()=>{clearTimeout(timer);reject(Error('视频素材缺失'));};video.onloadeddata=()=>{clearTimeout(timer);resolve();};});
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=Math.round(640*video.videoHeight/video.videoWidth);canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.85));video.removeAttribute('src');video.load();return {url:makeUrl(blob),canvas};
  }
  async function prepareAssets() {
    const results=await Promise.allSettled([
      loadImage(assetPaths.photo).then(async image=>{assets.photoConcealed=await concealed(image);}),
      videoPoster().then(async poster=>{assets.videoPoster=poster.url;const image=await loadImage(poster.url);assets.videoConcealed=await concealed(image);}),
      loadImage(assetPaths.expressionStill).then(async image=>{assets.expressionConcealed=await concealed(image);})
    ]);
    const failed=results.filter(result=>result.status==='rejected');
    $('#asset-status').textContent=failed.length?'演示素材缺失，请运行 prepare-assets.mjs':'本地素材已就绪 · 模拟数据';
    document.body.dataset.assetsReady=failed.length?'partial':'true';
    samples.forEach(sample=>applyState(sample,sample.state,{force:true}));
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stopAll();animationEffects.forEach(effect=>effect.cancel());if($('#viewer').open)closeViewer();}});
  window.addEventListener('pagehide',()=>{stopAll();objectUrls.forEach(url=>URL.revokeObjectURL(url));});
  theme(false);setMode('send','uploading');setReduced(settings.reduced);void prepareAssets();
})();
