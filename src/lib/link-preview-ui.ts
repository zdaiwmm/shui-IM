import { fromBase64Url, toBase64Url } from './base64';
import { authorizedFetch } from './api';
import { uiLiteral } from './language';
import { firstPreviewUrl, newTabLink } from './web-links';
import { isLinkPreview, PREVIEW_IMAGE_BYTES, previewLayout, type LinkPreview } from './link-preview-data';

async function preparePreview(raw: unknown, url: string, signal: AbortSignal): Promise<LinkPreview> {
  const packet = raw as Record<string, unknown>;
  const result: LinkPreview = { url, siteName: packet.siteName as string, title: packet.title as string,
    description: packet.description as string, layout: 'text' };
  if (packet.url !== url || !isLinkPreview(result)) throw new Error('Invalid preview');
  const image = packet.image as {mimeType?: string; data?: string; source?: string; width?: number; height?: number} | undefined;
  if (!image || !['image/jpeg','image/png','image/webp'].includes(image.mimeType??'')
    || typeof image.data !== 'string' || image.data.length > Math.ceil(1024 * 1024 * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(image.data) || !['content','icon'].includes(image.source??'')
    || !Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width! < 1 || image.height! < 1 || image.width! > 4096 || image.height! > 4096
    || image.width! * image.height! > 12_000_000) return result;
  let bitmap: ImageBitmap | undefined;
  try {
    signal.throwIfAborted();
    bitmap = await createImageBitmap(new Blob([fromBase64Url(image.data)],{type:image.mimeType}));
    signal.throwIfAborted();
    if (bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width * bitmap.height > 12_000_000) return result;
    const canvas = document.createElement('canvas');
    let scale = Math.min(1,640 / Math.max(bitmap.width,bitmap.height));
    for (let attempt=0;attempt<5;attempt++,scale*=.75) {
      canvas.width=Math.max(1,Math.round(bitmap.width*scale)); canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const context=canvas.getContext('2d'); if (!context) return result;
      context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',.72));
      signal.throwIfAborted();
      if (blob && blob.size <= PREVIEW_IMAGE_BYTES) {
        result.image={mimeType:'image/jpeg',data:toBase64Url(await blob.arrayBuffer()),width:canvas.width,height:canvas.height};
        result.layout=previewLayout(image.source as 'content'|'icon',canvas.width,canvas.height);
        break;
      }
    }
    canvas.width=canvas.height=0;
  } catch { signal.throwIfAborted(); }
  finally { bitmap?.close(); }
  return result;
}

export class ComposerLinkPreview {
  private url: string | null = null;
  private dismissed = false;
  private preview: LinkPreview | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | undefined;
  private version = 0;
  private composing = false;
  private readonly row = document.createElement('div');
  constructor(private readonly options: {input: HTMLTextAreaElement; host: HTMLElement; roomId: string; token: string;
    signal: AbortSignal; active: () => boolean; changed: () => void}) {
    this.row.className='link-preview-draft'; this.row.hidden=true;
    options.host.before(this.row);
    options.input.addEventListener('input',()=>{if(!this.composing)this.update();},{signal:options.signal});
    options.input.addEventListener('compositionstart',()=>{this.composing=true;},{signal:options.signal});
    options.input.addEventListener('compositionend',()=>{this.composing=false;this.update();},{signal:options.signal});
    options.signal.addEventListener('abort',()=>this.destroy(),{once:true});
    // A restored draft needs a fresh input event before any network request.
  }
  snapshot(text: string): LinkPreview | undefined {
    return !this.dismissed && this.preview && firstPreviewUrl(text)===this.url ? structuredClone(this.preview) : undefined;
  }
  clear(): void {
    this.version++;clearTimeout(this.timer);this.request?.abort();this.request=undefined;
    this.url=null;this.preview=undefined;this.dismissed=false;this.row.replaceChildren();this.row.hidden=true;
    this.options.changed();
  }
  destroy(): void {this.clear();this.row.remove();}
  private update(): void {
    if(!this.options.active()){this.clear();return;}
    const url=firstPreviewUrl(this.options.input.value);
    if(url===this.url)return;
    this.clear();this.url=url;
    if(url)this.timer=setTimeout(()=>void this.load(),500);
  }
  private paint(state:'loading'|'ready'|'failed'): void {
    this.row.replaceChildren();this.row.hidden=false;this.row.dataset.state=state;
    const copy=document.createElement('div');copy.className='link-preview-draft-copy';
    const title=document.createElement('strong');
    title.textContent=state==='loading'?uiLiteral('正在获取链接预览…'):state==='failed'?uiLiteral('暂时无法获取预览'):this.preview!.siteName;
    const detail=document.createElement('span');detail.textContent=state==='ready'?this.preview!.title:state==='failed'?uiLiteral('可以直接发送链接'):new URL(this.url!).hostname;
    copy.setAttribute('role','status');copy.setAttribute('aria-live','polite');copy.append(title,detail);this.row.append(copy);
    if(state==='failed'){
      const retry=document.createElement('button');retry.type='button';retry.className='link-preview-retry';retry.textContent=uiLiteral('重试');
      retry.addEventListener('click',()=>void this.load());this.row.append(retry);
    }
    const close=document.createElement('button');close.type='button';close.className='link-preview-close';close.textContent='×';close.setAttribute('aria-label',uiLiteral('移除链接预览'));
    close.addEventListener('click',()=>{this.version++;clearTimeout(this.timer);this.request?.abort();this.dismissed=true;this.preview=undefined;this.row.hidden=true;this.row.replaceChildren();this.options.changed();});
    this.row.append(close);this.options.changed();
  }
  private async load():Promise<void> {
    if(!this.url||this.dismissed||!this.options.active()||this.options.signal.aborted)return;
    this.request?.abort();const controller=new AbortController();this.request=controller;
    const signal=AbortSignal.any([controller.signal,this.options.signal,AbortSignal.timeout(12_000)]);
    const revision=++this.version,url=this.url;
    const current=()=>revision===this.version&&!signal.aborted&&!this.dismissed&&this.options.active()&&this.options.input.isConnected;
    this.paint('loading');
    try {
      const response=await authorizedFetch(`/api/rooms/${this.options.roomId}/link-preview`,this.options.token,{method:'POST',signal,cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
      const preview=await preparePreview(await response.json(),url,signal);
      if(!current())return;this.preview=preview;this.paint('ready');
    }catch {
      if(revision===this.version&&!controller.signal.aborted&&!this.options.signal.aborted&&this.options.active())this.paint('failed');
    }
  }
}

const previewImageViews=new Set<{conceal:()=>void;reveal:()=>void}>();
export function concealLinkPreviews():void {for(const view of previewImageViews)view.conceal();}
export function revealLinkPreviews():void {for(const view of previewImageViews)view.reveal();}

/** Each URL belongs to its visible DOM row and the current unlocked runtime. */
export function renderPreviewCard(preview: LinkPreview, signal: AbortSignal): HTMLAnchorElement {
  const card=newTabLink(preview.url);card.className='message-link-preview';card.dataset.layout=preview.layout;
  card.setAttribute('aria-label',`${preview.title} · ${uiLiteral('在新标签页打开')}`);
  const content=document.createElement('div');content.className='message-link-preview-content';
  const source=document.createElement('span');source.className='message-link-preview-source';source.textContent=`${preview.siteName} · ${new URL(preview.url).hostname} ↗`;
  const title=document.createElement('strong');title.textContent=preview.title;content.append(source,title);
  if(preview.description){const description=document.createElement('p');description.textContent=preview.description;content.append(description);}
  card.append(content);
  if(preview.image && !signal.aborted){
    const snapshot=preview.image;
    const image=document.createElement('img');image.alt='';image.width=snapshot.width;image.height=snapshot.height;image.decoding='async';card.append(image);
    let objectUrl:string|undefined;let disposed=false;
    const conceal=()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=undefined;image.removeAttribute('src');};
    const reveal=()=>{
      if(disposed||signal.aborted||!card.isConnected||document.hidden||document.documentElement.classList.contains('privacy-obscured')||objectUrl)return;
      objectUrl=URL.createObjectURL(new Blob([fromBase64Url(snapshot.data)],{type:'image/jpeg'}));image.src=objectUrl;
    };
    const view={conceal,reveal};previewImageViews.add(view);
    const release=()=>{disposed=true;conceal();observer.disconnect();previewImageViews.delete(view);signal.removeEventListener('abort',release);};
    const observer=new MutationObserver(()=>{if(!card.isConnected)release();});
    queueMicrotask(()=>{if(disposed||signal.aborted||!card.isConnected){release();return;}observer.observe(card.getRootNode(),{childList:true,subtree:true});reveal();});
    signal.addEventListener('abort',release,{once:true});
    image.addEventListener('error',()=>{if(!objectUrl)return;release();image.remove();card.dataset.layout='text';});
  }
  return card;
}
