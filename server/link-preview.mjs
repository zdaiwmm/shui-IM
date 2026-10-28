import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2)
      || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6) return false;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1,-1);
  const [first,second] = canonical.split(':').map(part => parseInt(part || '0',16));
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
    && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
}

export function previewTarget(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new Error('PREVIEW_TARGET');
  let u;try{u=new URL(value);}catch{throw new Error('PREVIEW_TARGET');}
  if (!['https:','http:'].includes(u.protocol) || u.username || u.password || u.hash
    || u.port && !['80','443'].includes(u.port) || !u.hostname.includes('.')
    || /(?:localhost|\.local|\.internal|\.localhost|\.test|\.invalid)$/i.test(u.hostname)
    || /(?:invite|recovery|device-link|repair-link|browser-access|short-invite)/i.test(u.pathname)
    || [...u.searchParams.keys()].some(key => /token|secret|password|recovery|invite|mnemonic|(?:^|_)key|credential|proof/i.test(key))
    || /(?:^|\.)(?:ai\.shui\.click|mijiu\.cloud)$/i.test(u.hostname) && (u.search || u.pathname !== '/')) throw new Error('PREVIEW_TARGET');
  if (isIP(u.hostname) && !publicAddress(u.hostname)) throw new Error('PREVIEW_TARGET');
  return u;
}

/** Every hop and image repeats validation; the socket uses the exact checked answer. No cookies, auth, proxy, JS, decompression or connection reuse. */
export async function fetchPreviewResource(value, {signal, maxBytes, resolve = lookup, redirects = 3, requester} = {}) {
  maxBytes ??= 512*1024;
  let url = previewTarget(value);
  for (let hop = 0; hop <= redirects; hop++) {
    signal?.throwIfAborted();
    const addresses = await new Promise((fulfill,reject) => {
      const abort=()=>reject(signal.reason);signal?.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>resolve(url.hostname,{all:true,verbatim:true})).then(fulfill,reject)
        .finally(()=>signal?.removeEventListener('abort',abort));
    });
    signal?.throwIfAborted();
    if (!addresses.length || addresses.some(answer => !publicAddress(answer.address))) throw new Error('PREVIEW_TARGET');
    const answer = addresses.find(item => item.family === 4) ?? addresses[0];
    const result = await new Promise((resolveResult,reject) => {
      const transport = requester ?? (url.protocol === 'https:' ? httpsRequest : httpRequest);
      const request = transport(url,{method:'GET',agent:false,signal,maxHeaderSize:16*1024,
        lookup: (_host,options,callback) => options.all ? callback(null,[answer]) : callback(null,answer.address,answer.family),
        headers:{'User-Agent':'QuietRoom-LinkPreview/1.0','Accept':'text/html,image/jpeg,image/png,image/webp','Accept-Encoding':'identity'}}, response => {
        if ([301,302,303,307,308].includes(response.statusCode)) {
          const location = response.headers.location; response.destroy(); resolveResult({location,status:response.statusCode}); return;
        }
        if (response.statusCode !== 200 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy(); reject(new Error('PREVIEW_RESPONSE')); return;
        }
        if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); reject(new Error('PREVIEW_SIZE')); return; }
        const chunks=[]; let bytes=0;
        response.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){response.destroy(new Error('PREVIEW_SIZE'));return;}chunks.push(chunk);});
        response.on('error',reject);
        response.on('end',()=>resolveResult({bytes:Buffer.concat(chunks),type:String(response.headers['content-type']??'').split(';')[0].trim().toLowerCase(),url:url.href}));
      });
      request.setTimeout(4000,()=>request.destroy(new Error('PREVIEW_TIMEOUT')));
      request.on('error',reject); request.end();
    });
    if (!result.location) { if (!result.bytes) throw new Error('PREVIEW_REDIRECT'); return result; }
    const next = previewTarget(new URL(result.location,url).href);
    if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('PREVIEW_TARGET');
    url=next;
  }
  throw new Error('PREVIEW_REDIRECT');
}

function decode(value) {
  return value.replace(/&(?:#(x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi,(entity,numeric)=>{
    if(numeric){const n=numeric[0].toLowerCase()==='x'?parseInt(numeric.slice(1),16):Number(numeric);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}
    return ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '})[entity.toLowerCase()]??entity;
  });
}
const text = (value,limit) => decode(value??'').replace(/<[^>]*>/g,'').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\s]+/g,' ').trim().slice(0,limit);

export function parsePreviewHtml(html, url) {
  html=html.slice(0,128*1024);
  const values=new Map(); let icon;
  // Only bounded tag/attribute tokens; none of the source HTML is rendered or executed.
  // Split once rather than retrying overlapping malformed tags against a large HTML buffer.
  for(const chunk of html.split('>')){
    const start=chunk.search(/<(?:meta|link)\b/i);
    if(start<0||chunk.length-start>8192)continue;
    const tag=chunk.slice(start);
    const attrs=new Map();
    for(const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs.set(match[1].toLowerCase(),decode(match[2]??match[3]??match[4]??''));
    const name=(attrs.get('property')??attrs.get('name')??'').toLowerCase();
    if(name&&!values.has(name)) values.set(name,attrs.get('content')??'');
    if(!icon && /(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(attrs.get('rel')??'')) icon=attrs.get('href');
  }
  const title=text(values.get('og:title')||values.get('twitter:title')||html.match(/<title\b[^>]*>([\s\S]{0,4096}?)<\/title\s*>/i)?.[1],300);
  if(!title) throw new Error('PREVIEW_EMPTY');
  const contentImage=values.get('og:image:secure_url')||values.get('og:image')||values.get('twitter:image');
  const iconLike=values.get('og:type')==='profile'||values.get('twitter:card')==='summary';
  let imageUrl;
  try{if(contentImage||icon)imageUrl=new URL(contentImage||icon,url).href;}catch{/* No usable image. */}
  return {siteName:text(values.get('og:site_name')||new URL(url).hostname,100)||new URL(url).hostname.slice(0,100),title,
    description:text(values.get('og:description')||values.get('twitter:description')||values.get('description'),600),
    ...(imageUrl?{imageUrl,imageSource:contentImage&&!iconLike?'content':'icon'}:{})};
}

export function createLinkPreviewService({resource=fetchPreviewResource}={}) {
  let inFlight=0;
  return async (url,signal) => {
    previewTarget(url);
    if(inFlight>=4) throw new Error('PREVIEW_BUSY');
    inFlight++;
    try{
      const bounded=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(8000)]);
      const page=await resource(url,{signal:bounded,maxBytes:512*1024});
      if(!['text/html','application/xhtml+xml'].includes(page.type))throw new Error('PREVIEW_RESPONSE');
      const metadata=parsePreviewHtml(page.bytes.toString('utf8'),page.url);
      const {imageUrl,imageSource,...description}=metadata;
      let image;
      if(imageUrl)try{
        const result=await resource(imageUrl,{signal:bounded,maxBytes:1024*1024});
        const bytes=result.bytes;
        const jpeg=result.type==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
        const png=result.type==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const webp=result.type==='image/webp'&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
        const dimensions=(jpeg||png||webp)?rasterSize(bytes,result.type):null;
        if(dimensions)image={mimeType:result.type,data:bytes.toString('base64url'),source:imageSource,...dimensions};
      }catch{/* A failed or rejected image never discards valid text metadata. */}
      signal?.throwIfAborted();
      return {url,...description,...(image?{image}:{})};
    }finally{inFlight--;}
  };
}

export function rasterSize(bytes,type) {
  let width=0,height=0;
  try{
    if(type==='image/png'&&bytes.length>=24){width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);}
    if(type==='image/webp'&&bytes.length>=30){
      const chunk=bytes.toString('ascii',12,16);
      if(chunk==='VP8X'){width=1+bytes.readUIntLE(24,3);height=1+bytes.readUIntLE(27,3);}
      else if(chunk==='VP8 '&&bytes.toString('hex',23,26)==='9d012a'){width=bytes.readUInt16LE(26)&0x3fff;height=bytes.readUInt16LE(28)&0x3fff;}
      else if(chunk==='VP8L'&&bytes[20]===0x2f){const bits=bytes.readUInt32LE(21);width=1+(bits&0x3fff);height=1+((bits>>>14)&0x3fff);}
    }
    if(type==='image/jpeg'){
      let offset=2;
      while(offset+4<=bytes.length){
        if(bytes[offset++]!==255)break;
        while(bytes[offset]===255)offset++;
        const marker=bytes[offset++];
        if(marker===0xda||marker===0xd9)break;
        const length=bytes.readUInt16BE(offset);
        if(length<2||offset+length>bytes.length)break;
        if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7){height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);break;}
        offset+=length;
      }
    }
  }catch{return null;}
  return width>0&&height>0&&width<=4096&&height<=4096&&width*height<=12_000_000?{width,height}:null;
}
