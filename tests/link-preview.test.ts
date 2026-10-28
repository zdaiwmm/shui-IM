import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { publicAddress, previewTarget, parsePreviewHtml, createLinkPreviewService, fetchPreviewResource, rasterSize } from '../server/link-preview.mjs';
import { findWebLinks, firstPreviewUrl, webUrl } from '../src/lib/web-links';
import { isLinkPreview, previewLayout } from '../src/lib/link-preview-data';
import { isMessagePayload } from '../src/lib/message-payload';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';
import { generateIdentity } from '../src/lib/crypto';

const url='https://example.com/post';
const preview={url,siteName:'Example',title:'Example title',description:'A description',layout:'text'};
const payload={v:3,kind:'text',text:url,sentAt:new Date().toISOString(),preview};
const answer=[{address:'93.184.216.34',family:4}];
const html=Buffer.from('<meta property="og:title" content="A &amp; B"><meta name="description" content="Plain &lt;script&gt; text">');

describe('web links and encrypted preview contract',()=>{
  it('identifies mixed Chinese text, www, queries, fragments and balanced parentheses without consuming punctuation',()=>{
    const links=findWebLinks('看看 https://example.com/a_(b)。还有 www.example.org/x?q=1，https://example.net/#hello！');
    expect(links.map(l=>l.text)).toEqual(['https://example.com/a_(b)','www.example.org/x?q=1','https://example.net/#hello']);
    expect(links[1]!.url).toBe('https://www.example.org/x?q=1');
    expect(findWebLinks('user@www.example.com javascript:alert(1) https://u:p@example.com/')).toEqual([]);
    expect(webUrl('https://example.com\\@127.0.0.1')).toBeNull();
  });
  it('does not submit known capabilities, secrets, fragments, local URLs or application invitations',()=>{
    for(const value of ['https://example.com/?token=secret','https://example.com/#invite','https://example.com/invite/a','https://ai.shui.click/?c=abc','https://mijiu.cloud/a','http://127.0.0.1/a','http://foo.local/a','https://example.com/?api_key=a'])expect(firstPreviewUrl(value)).toBeNull();
    expect(firstPreviewUrl('https://example.com/?q=hello')).toBe('https://example.com/?q=hello');
  });
  it('validates exact URL binding, strict keys, bounded text and version-gated payloads',()=>{
    expect(isMessagePayload(payload)).toBe(true);
    expect(isMessagePayload({...payload,v:1})).toBe(false);
    expect(isMessagePayload({...payload,v:2})).toBe(false);
    expect(isMessagePayload({...payload,text:'https://another.example/x'})).toBe(false);
    expect(isMessagePayload({...payload,preview:{...preview,html:'<iframe>'}})).toBe(false);
    expect(isMessagePayload({...payload,preview:{...preview,title:'a'.repeat(301)}})).toBe(false);
    expect(isMessagePayload({...payload,preview:{...preview,description:'\0'}})).toBe(false);
    expect(isMessagePayload({...payload,preview:{...preview,layout:['text']}})).toBe(false);
    expect(isMessagePayload({...payload,replyTo:{}})).toBe(false);
    expect(isMessagePayload({...payload,kind:'image'})).toBe(false);
  });
  it('rejects remote image URLs, unbounded data and shape mismatches',()=>{
    const image={mimeType:'image/jpeg',data:Buffer.from([255,216,255,217]).toString('base64url'),width:640,height:320};
    expect(isLinkPreview({...preview,layout:'large',image})).toBe(true);
    expect(isLinkPreview({...preview,image})).toBe(false);
    expect(isLinkPreview({...preview,layout:'large',image:{...image,data:'a'.repeat(24000)}})).toBe(false);
    expect(isLinkPreview({...preview,layout:'large',image:{...image,mimeType:'image/svg+xml'}})).toBe(false);
    expect(isLinkPreview({...preview,layout:'large',image:{...image,src:'https://tracker.example/a'}})).toBe(false);
    expect(isLinkPreview({...preview,layout:'large',image:{...image,width:99999}})).toBe(false);
    expect(previewLayout('content',640,320)).toBe('large');
    expect(previewLayout('icon',640,320)).toBe('compact');
    expect(previewLayout('content',96,96)).toBe('compact');
  });
});

describe('bounded public webpage fetcher',()=>{
  it.each(['0.0.0.0','10.0.0.1','127.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','100.64.0.1','198.18.0.1','192.0.2.1','198.51.100.1','203.0.113.2','224.0.0.1','255.255.255.255','::1','::','::ffff:127.0.0.1','64:ff9b::a9fe:a9fe','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::','2001::1'])( 'rejects non-public address %s',address=>expect(publicAddress(address)).toBe(false));
  it.each(['8.8.8.8','93.184.216.34','2606:4700:4700::1111','2001:4860:4860::8888'])('allows public address %s',address=>expect(publicAddress(address)).toBe(true));
  it.each(['http://2130706433/','http://0x7f000001/','http://127.1/','file:///etc/passwd','http://[::1]/','https://user:password@example.com','https://example.com:8080/','https://example.com/?recovery=abc'])('rejects unsafe target %s',value=>expect(()=>previewTarget(value)).toThrow());
  it('rejects mixed DNS answers before opening a socket',async()=>{
    let called=false;
    await expect(fetchPreviewResource(url,{resolve:async()=>[...answer,{address:'127.0.0.1',family:4}],requester:()=>{called=true;}})).rejects.toThrow('PREVIEW_TARGET');
    expect(called).toBe(false);
  });
  it('pins the validated DNS answer and sends neither auth nor cookies',async()=>{
    let observed:any;
    const requester=(_url:URL,options:any,cb:Function)=>{
      observed=options;const req=new EventEmitter() as any;req.setTimeout=()=>req;req.end=()=>{
        const stream=Readable.from([html]) as any;stream.statusCode=200;stream.headers={'content-type':'text/html'};cb(stream);
      };return req;
    };
    const result=await fetchPreviewResource(url,{resolve:async()=>answer,requester,maxBytes:4096});
    expect(result.bytes.equals(html)).toBe(true);expect(observed.agent).toBe(false);
    expect(observed.headers.Authorization).toBeUndefined();expect(observed.headers.Cookie).toBeUndefined();
    observed.lookup('example.com',{all:true},(error:any,value:any)=>{expect(error).toBeNull();expect(value).toEqual(answer);});
  });
  it('rejects redirect-to-private, oversized streams and redirect loops',async()=>{
    const requester=(location:string|null,bytes=html)=>(_url:URL,_options:any,cb:Function)=>{
      const req=new EventEmitter() as any;req.setTimeout=()=>req;req.end=()=>{
        const stream=Readable.from([bytes]) as any;stream.statusCode=location?302:200;stream.headers=location?{location}:{'content-type':'text/html'};cb(stream);
      };return req;
    };
    await expect(fetchPreviewResource(url,{resolve:async()=>answer,requester:requester('http://127.0.0.1/')})).rejects.toThrow('PREVIEW_TARGET');
    await expect(fetchPreviewResource(url,{resolve:async()=>answer,requester:requester(null),maxBytes:2})).rejects.toThrow('PREVIEW_SIZE');
    await expect(fetchPreviewResource(url,{resolve:async()=>answer,requester:requester(url)})).rejects.toThrow('PREVIEW_REDIRECT');
  });
  it('cancels a stalled DNS lookup within the abort deadline',async()=>{
    await expect(fetchPreviewResource(url,{signal:AbortSignal.timeout(20),resolve:()=>new Promise(()=>{})})).rejects.toThrow();
  });
  it('parses metadata as bounded plain text without executing markup or inventing an image URL',()=>{
    expect(parsePreviewHtml(html.toString(),url)).toEqual({siteName:'example.com',title:'A & B',description:'Plain text'});
    expect(parsePreviewHtml('<title>Fallback</title><link rel="icon" href="/icon.png">',url)).toMatchObject({title:'Fallback',imageUrl:'https://example.com/icon.png',imageSource:'icon'});
    expect(parsePreviewHtml('<title>Account</title><meta property="og:type" content="profile"><meta property="og:image" content="/avatar.png">',url)).toMatchObject({imageSource:'icon'});
    expect(()=>parsePreviewHtml('<script>document.write("title")</script>',url)).toThrow('PREVIEW_EMPTY');
  });
  it('retains metadata when image retrieval fails and never follows script/svg resources',async()=>{
    let calls=0;
    const service=createLinkPreviewService({resource:async()=>{if(++calls>1)throw new Error('image');return {bytes:Buffer.from('<title>Valid title</title><meta property="og:image" content="https://img.example/a">'),type:'text/html',url};}});
    expect(await service(url)).toEqual({url,siteName:'example.com',title:'Valid title',description:''});
    expect(calls).toBe(2);
  });
  it('bounds raster dimensions before the browser decodes external bytes',()=>{
    const png=Buffer.alloc(24);png.writeUInt32BE(800,16);png.writeUInt32BE(400,20);
    expect(rasterSize(png,'image/png')).toEqual({width:800,height:400});
    png.writeUInt32BE(100000,16);expect(rasterSize(png,'image/png')).toBeNull();
    expect(rasterSize(Buffer.alloc(4),'image/jpeg')).toBeNull();
  });
  it('has a global concurrency budget and releases it after failures',async()=>{
    const releases:Function[]=[];
    const service=createLinkPreviewService({resource:()=>new Promise(resolve=>releases.push(()=>resolve({bytes:html,type:'text/html',url})))});
    const running=Array.from({length:4},()=>service(url));
    await expect(service(url)).rejects.toThrow('PREVIEW_BUSY');releases.splice(0).forEach(release=>release());
    await Promise.all(running);
    const next=service(url);releases.splice(0).forEach(release=>release());await expect(next).resolves.toHaveProperty('title','A & B');
  });
});

it('authenticates, checks origin, rejects local targets and limits requests before any fetch',async()=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'link-preview-api-'));
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,quiet:true});
  try{
    const identity=await generateIdentity(),token='p'.repeat(43);
    const {roomId}=server.store.createRoom(identity.publicBundle,token,'i'.repeat(43),'preview-test',[]);
    const origin=`http://127.0.0.1:${server.port}`,endpoint=`${origin}/api/rooms/${roomId}/link-preview`;
    const call=(extra:Record<string,string>={})=>fetch(endpoint,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:`Bearer ${token}`,...extra},body:JSON.stringify({url:'http://127.0.0.1/internal'})});
    expect((await call({Authorization:'Bearer wrong'})).status).toBe(401);
    expect((await call({Origin:'https://foreign.example'})).status).toBe(403);
    for(let index=0;index<20;index++)expect((await call()).status).toBe(400);
    expect((await call()).status).toBe(429);
  }finally{await server.close();await rm(dataDir,{recursive:true,force:true});}
});
