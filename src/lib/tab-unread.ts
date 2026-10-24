/** Only the existing count-only observer reaches browser chrome. No room name or content. */
let generation=0, lastCount=-1;
let base:Promise<HTMLImageElement>|undefined;
const originals=new Map<HTMLLinkElement,{href:string;type:string;sizes:string}>();
export function updateTabUnread(value:number):void {
  const count=Number.isSafeInteger(value)&&value>0?value:0;
  if(count===lastCount)return;
  lastCount=count;const version=++generation;
  const links=[...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
  for(const link of links)if(!originals.has(link))originals.set(link,{href:link.getAttribute('href')??'',type:link.type,sizes:link.sizes.value});
  if(!count){for(const [link,original]of originals){link.href=original.href;link.type=original.type;link.sizes.value=original.sizes;delete link.dataset.unread;}return;}
  base??=new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>{base=undefined;reject(new Error('图标暂时不可用'));};image.src='/favicon.svg';});
  void base.then(image=>{
    if(version!==generation)return;
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
    const ctx=canvas.getContext('2d');if(!ctx)return;
    ctx.drawImage(image,0,0,64,64);
    const label=count>99?'99+':String(count),width=label.length===1?27:label.length===2?35:43;
    ctx.fillStyle='#d92d44';ctx.beginPath();ctx.roundRect(64-width,36,width,28,14);ctx.fill();
    ctx.fillStyle='#fff8f8';ctx.font=`700 ${label.length===3?17:20}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,64-width/2,50);
    const href=canvas.toDataURL('image/png');
    for(const link of links){link.type='image/png';link.sizes.value='64x64';link.href=href;link.dataset.unread=String(count);}
  }).catch(()=>{if(version===generation)lastCount=-1;});
}
