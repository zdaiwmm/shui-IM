const frame=document.querySelector('#preview');
const ids=['source','kind','state','scheme','size','font'];
let reentryTimer,revision=0;
function caption(){const state=document.querySelector('#state').value,kind=document.querySelector('#kind').value;document.querySelector('#caption').textContent=state==='decode'||state==='network'?'错误独立占位，隐藏播放控件，保留关闭与可用的翻页。':kind==='photo'?'删除、翻页与顶部操作使用统一深色表面，文件信息有独立底色。':'中央播放／前后跳转不占用底部进度条；倍速直接显示当前数值。'}
function update(){
  clearTimeout(reentryTimer);
  const settings=Object.fromEntries(ids.map(id=>[id,document.getElementById(id).value]));
  document.querySelector('#state option[value="tap"]').disabled=settings.kind==='photo';
  if(settings.kind==='photo'&&settings.state==='tap'){settings.state='normal';document.querySelector('#state').value='normal'}
  const [width,height]=settings.size.split(',');frame.style.width=`${width}px`;frame.style.height=`${height}px`;
  document.documentElement.dataset.colorScheme=settings.scheme;
  frame.contentWindow.postMessage({type:'media-review-v1',settings:{...settings,revision:++revision}},location.origin);
  caption();
}
ids.forEach(id=>document.getElementById(id).addEventListener('change',update));frame.addEventListener('load',update);
document.querySelector('#reenter').addEventListener('click',()=>{document.querySelector('#state').value='loading';update();reentryTimer=setTimeout(()=>{document.querySelector('#state').value='normal';update();},700)});
document.querySelector('#conceal').addEventListener('click',()=>{document.querySelector('#state').value='locked';update()});
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.revision!==revision)return;if(event.data?.type==='media-review-geometry')document.querySelector('#geometry').textContent=JSON.stringify(event.data.geometry);if(event.data?.type==='media-review-current'&&['normal','loading','tap','decode','network','empty','locked'].includes(event.data.state)){document.querySelector('#state').value=event.data.state;document.querySelector('#kind').value=event.data.kind;caption()}});
