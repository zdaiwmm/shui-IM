const el = id => document.getElementById(id);
const viewer = document.querySelector('.viewer');
const surface = document.querySelector('.surface');
const total = 80;
let saved, received, traffic, interrupted, download, playback, position, rate, visible;
const mode = () => el('scenario').value;
const blocked = () => ['room','legacy'].includes(mode());
function refresh() {
  el('traffic').textContent = traffic + ' MiB';
  el('storage').textContent = saved ? '完整原件' : received ? received + ' MiB 分块' : '无原件';
  el('tile').disabled = blocked() || Boolean(download);
  el('tileText').textContent = blocked() ? '未发送' : download ? '下载中 · ' + Math.round(received / total * 100) + '%' :
    saved ? '从本机打开　▶' : interrupted ? '重试下载　↻' : received ? '继续下载　↓' : '下载视频　↓';
}
function controls(show) {
  visible = show;
  viewer.classList.toggle('off', !show);
}
function setPosition(t) {
  position = Math.min(90, Math.max(0, t));
  el('seek').value = position;
  el('time').textContent = Math.floor(position / 60) + ':' + String(Math.floor(position % 60)).padStart(2,'0');
  if (position === 90 && playback) stop();
}
function stop() {
  clearInterval(playback);
  playback = null;
  viewer.classList.remove('moving');
  el('play').textContent = '▶';
  el('play').setAttribute('aria-label','播放视频');
  controls(true);
}
function closeViewer() {
  stop();
  viewer.hidden = true;
  el('tile').focus({preventScroll:true});
}
function openViewer() {
  el('status').textContent = mode() === 'low' ? '本机空间不足，无法保留供下次播放。' : '本机已缓存，重新进入可直接打开。';
  viewer.hidden = false;
  controls(true);
  setPosition(0);
  rate = 1;
  el('speed').textContent = '1×';
  el('mute').textContent = '声音';
  el('mute').setAttribute('aria-pressed','false');
  surface.focus({preventScroll:true});
}
function enter(reset) {
  clearInterval(download);
  download = null;
  closeViewer();
  if (reset) {
    saved = mode() === 'send';
    received = mode() === 'partial' ? 40 : saved ? total : 0;
    interrupted = false;
  } else if (mode() === 'low') received = 0;
  traffic = 0;
  el('sender').textContent = mode() === 'send' || blocked() ? '我' : '对方';
  const messages = {room:'密室附件剩余额度不足，本次上传尚未开始。',legacy:'对方有设备需升级，暂不能发送超过旧版上限的视频。',send:'视频已发送，原件已在本机缓存。',low:'浏览器可用缓存空间低于视频大小。'};
  el('status').textContent = saved ? '本机已缓存' : messages[mode()] || (received ? '保留已下载分块，下次只补缺失部分。' : '打开时按需获取视频。');
  refresh();
}
el('scenario').onchange = () => enter(true);
el('again').onclick = () => enter(false);
el('tile').onclick = () => {
  if (saved) return openViewer();
  download = setInterval(() => {
    const delta = Math.min(10, total - received);
    received += delta;
    traffic += delta;
    if (mode() === 'bad' && !interrupted && received === 40) {
      interrupted = true;
      clearInterval(download); download = null;
      el('status').textContent = '网络中断，已保留一半分块。点按重试。';
    } else if (received === total) {
      clearInterval(download); download = null;
      saved = mode() !== 'low';
      received = saved ? total : 0;
      openViewer();
    }
    refresh();
  }, 120);
  refresh();
};
el('play').onclick = event => {
  if (playback) return stop();
  if (position === 90) setPosition(0);
  playback = setInterval(() => setPosition(position + rate),1000);
  viewer.classList.add('moving');
  el('play').textContent = 'Ⅱ';
  el('play').setAttribute('aria-label','暂停视频');
  if (event.detail) {
    surface.focus({preventScroll:true});
    controls(false);
  }
};
surface.onclick = () => controls(playback ? !visible : true);
el('back').onclick = () => setPosition(position - 10);
el('forward').onclick = () => setPosition(position + 10);
el('seek').oninput = () => setPosition(Number(el('seek').value));
el('speed').onclick = () => {
  rate = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
  el('speed').textContent = rate + '×';
};
el('mute').onclick = () => {
  const muted = el('mute').getAttribute('aria-pressed') !== 'true';
  el('mute').setAttribute('aria-pressed',String(muted));
  el('mute').textContent = muted ? '静音' : '声音';
};
el('close').onclick = closeViewer;
viewer.onkeydown = e => {
  if (e.key === 'Escape') return closeViewer();
  controls(true);
  if (e.key === 'Tab') {
    const targets = [...viewer.querySelectorAll('button,input')];
    if (e.shiftKey && document.activeElement === targets[0]) { e.preventDefault(); targets.at(-1).focus(); }
    if (!e.shiftKey && document.activeElement === targets.at(-1)) { e.preventDefault(); targets[0].focus(); }
  }
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !viewer.hidden) closeViewer();
});
enter(true);
