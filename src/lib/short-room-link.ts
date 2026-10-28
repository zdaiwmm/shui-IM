import { uiLiteral } from './language';
import {sha256} from '@noble/hashes/sha2.js';
import {randomBase64Url,fromBase64Url,toBase64Url} from './base64';
import {authorizedFetch} from './api';
import {parseInviteText} from './invite-link';
import type {VaultSession} from './vault';
const encoder=new TextEncoder();
const identifier=(secret:string)=>toBase64Url(sha256(fromBase64Url(secret)).slice(0,16));
const aad=(id:string)=>encoder.encode(`quiet-room-short-invite-v2:${id}`);
export async function createShortRoomLink(session:VaultSession,url:string,signal:AbortSignal):Promise<string>{
 const secret=randomBase64Url(32),id=identifier(secret),iv=crypto.getRandomValues(new Uint8Array(12));
 const key=await crypto.subtle.importKey('raw',fromBase64Url(secret),'AES-GCM',false,['encrypt']);
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id)},key,encoder.encode(url));
 await authorizedFetch(`/api/rooms/${session.vault.roomId}/short-invites/${id}`,session.vault.accessToken,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({v:2,iv:toBase64Url(iv),ciphertext:toBase64Url(ciphertext)}),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 return `${location.origin}/#j=${secret}`;
}
export async function expandShortRoomLink(active:()=>boolean=()=>true):Promise<boolean>{
 const current=location.hash;if(!current.startsWith('#j='))return false;
 const secret=current.slice(3);if(!/^[A-Za-z0-9_-]{43}$/.test(secret))throw new Error(uiLiteral('聊天链接不完整，请让对方重新发送'));
 const id=identifier(secret),response=await fetch(`/api/short-invites/${id}`,{cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error(uiLiteral('聊天链接已失效，请让对方生成新链接'));
 const envelope=await response.json();if(envelope?.v!==2||typeof envelope.iv!=='string'||!/^[A-Za-z0-9_-]{16}$/.test(envelope.iv)||typeof envelope.ciphertext!=='string'||envelope.ciphertext.length>7000)throw new Error(uiLiteral('聊天链接校验失败'));
 const key=await crypto.subtle.importKey('raw',fromBase64Url(secret),'AES-GCM',false,['decrypt']);
 let raw:ArrayBuffer;try{raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64Url(envelope.iv),additionalData:aad(id)},key,fromBase64Url(envelope.ciphertext));}catch{throw new Error(uiLiteral('聊天链接校验失败'));}
 const url=new TextDecoder('utf-8',{fatal:true}).decode(raw);if(parseInviteText(url,location.href).kind==='invalid')throw new Error(uiLiteral('聊天链接校验失败'));
 if(!active()||location.hash!==current)return false;history.replaceState(history.state,'',new URL(url).hash);return true;
}
