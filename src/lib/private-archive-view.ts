import { uiLiteral, uiTemplate, t } from './language';
import {type PrivateArchiveItem,privateItemSession} from './room-archive';
import {type VaultSession,loadPrivateMediaChunk} from './vault';
import {reduceMessageDeletions} from './message-deletions';
import {decryptAudioFile,decryptImageFile,decryptFileAttachment} from './file-crypto';
import type {ImageManifest,RoomMember} from './types';

/** Separate view model: no shared message ID, receipt, reply, send, reaction or
 * conversation index is given access to a private imported record. */
export function visiblePrivateItems(items:PrivateArchiveItem[]):PrivateArchiveItem[] {
  const rooms=new Map<string,PrivateArchiveItem[]>();
  for(const item of items){const group=rooms.get(item.originRoomId)??[];group.push(item);rooms.set(item.originRoomId,group);}
  const visible:PrivateArchiveItem[]=[];
  for(const group of rooms.values()){
    const roles=new Map<string,RoomMember['role']>(group.map(x=>[x.message.senderId,x.self?'creator':'joiner']));
    const deletions=reduceMessageDeletions(group.map(x=>x.message),roles);
    visible.push(...group.filter(x=>['text','image','image-album','audio','file'].includes(x.message.payload.kind)&&!deletions.has(x.message.clientMsgId)));
  }
  return visible.sort((a,b)=>a.message.payload.sentAt.localeCompare(b.message.payload.sentAt)||a.originRoomId.localeCompare(b.originRoomId)||a.message.seq-b.message.seq);
}
export function privateArchiveRow(item:PrivateArchiveItem,session:VaultSession,signal:AbortSignal,notice:(message:string)=>void):HTMLElement {
  const article=document.createElement('article');article.className=`message ${item.self?'outgoing':'incoming'} private-archive-message`;
  article.dataset.privateArchive='true';article.setAttribute('aria-label',item.self?uiLiteral('历史中的我，仅本机可见'):uiLiteral('历史中的对方，仅本机可见'));
  const bubble=document.createElement('div');bubble.className='message-bubble';
  const label=document.createElement('small');label.className='message-meta';label.textContent=uiTemplate`${item.self?uiLiteral('历史中的我'):uiLiteral('历史中的对方')} · 仅本机可见`;bubble.append(label);
  const payload=item.message.payload;
  if('replyTo' in payload&&payload.replyTo){const quote=document.createElement('blockquote');quote.textContent=payload.replyTo.preview;quote.className='message-reply-quote';bubble.append(quote);}
  if(payload.kind==='text'){const text=document.createElement('p');text.className='message-text';text.textContent=payload.text;bubble.append(text);}
  const media:ImageManifest[]='images'in payload?payload.images:'image'in payload?[payload.image]:'file'in payload?[payload.file]:'audio'in payload?[payload.audio]:[];
  for(const manifest of media){
    const button=document.createElement('button');button.type='button';button.className='secondary-button';button.textContent=payload.kind==='audio'?uiLiteral('播放历史语音'):uiTemplate`打开 ${manifest.originalName||uiLiteral('历史图片')}`;bubble.append(button);
    let pending=false;
    button.addEventListener('click',()=>{if(pending||signal.aborted)return;pending=true;button.disabled=true;
      const source=privateItemSession(session,item);
      const read=async(id:string,index:number)=>{signal.throwIfAborted();const size=Math.min(manifest.chunkSize,manifest.originalSize-index*manifest.chunkSize)+16;const raw=await loadPrivateMediaChunk(source,id,index,size);if(!raw)throw new Error(uiLiteral('原文件不在本机，请重新恢复该归档'));return raw;};
      const decrypt=payload.kind==='audio'?decryptAudioFile:payload.kind==='file'?decryptFileAttachment:decryptImageFile;
      void decrypt(manifest,read,undefined,signal).then(blob=>{
        if(signal.aborted||!article.isConnected)return;
        const url=URL.createObjectURL(blob),release=()=>{for(const node of bubble.querySelectorAll('audio,video,img')){if(node instanceof HTMLMediaElement){node.pause();node.removeAttribute('src');node.load();}else node.removeAttribute('src');node.remove();}URL.revokeObjectURL(url);};signal.addEventListener('abort',release,{once:true});
        if(payload.kind==='audio'||manifest.mimeType.startsWith('video/')){const player=document.createElement(payload.kind==='audio'?'audio':'video');player.controls=true;player.preload='metadata';player.src=url;player.style.maxWidth='100%';bubble.insertBefore(player,button);button.hidden=true;}
        else if(manifest.mimeType.startsWith('image/')&&!manifest.mimeType.includes('svg')){const image=document.createElement('img');image.alt=uiLiteral('恢复的历史图片，仅本机可见');image.src=url;image.style.maxWidth='100%';image.style.height='auto';bubble.insertBefore(image,button);button.hidden=true;}
        else {const link=document.createElement('a');link.href=url;link.download=manifest.originalName||uiLiteral('历史文件');link.className='secondary-button';link.textContent=uiLiteral('保存原文件');button.replaceWith(link);}
      }).catch(cause=>{if(!signal.aborted)notice(cause instanceof Error?t(cause.message):uiLiteral('原文件打开失败'));}).finally(()=>{pending=false;button.disabled=false;});
    });
  }
  const time=document.createElement('time');time.className='message-meta';time.dateTime=payload.sentAt;time.textContent=new Date(payload.sentAt).toLocaleString();bubble.append(time);article.append(bubble);return article;
}
