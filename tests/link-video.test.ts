import { describe, expect, it, vi, afterEach } from 'vitest';
import { compactMp4, verifyMp4, resolveClips, directBlob, postId } from '../src/lib/link-video';

const signal = new AbortController().signal;
afterEach(()=>vi.unstubAllGlobals());
function atom(tag:string, value:number) {
  return new Uint8Array([0,0,0,9,...[...tag].map(c=>c.charCodeAt(0)),value]);
}
describe('local link video',()=>{
  it('takes only a public status ID and drops share parameters',()=>{
    expect(postId('https://x.com/demo/status/123?a=private&s=46')).toBe('123');
    for(const s of ['https://x.com.example/demo/status/1','https://a@x.com/demo/status/1','http://x.com/demo/status/1','https://x.com:8443/demo/status/1','https://x.com/demo'])expect(postId(s)).toBeUndefined();
  });
  it('accepts X media only, including quoted media, and never follows redirects',async()=>{
    const mock=vi.fn(async()=>Response.json({code:200,tweet:{id:'123',media:{videos:[{url:'https://evil.example/a.mp4'}]},quote:{media:{videos:[{url:'https://video.twimg.com/a.mp4',thumbnail_url:'https://other.example/cover.jpg'}]}}}}));
    vi.stubGlobal('fetch',mock);const clips=await resolveClips('https://x.com/demo/status/123?s=46',signal);
    expect(mock).toHaveBeenCalledWith('https://api.fxtwitter.com/status/123',expect.objectContaining({credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'}));
    expect(clips).toHaveLength(1);expect(clips[0].cover).toBeUndefined();
  });
  it('rejects oversize and short bodies before storage',async()=>{
    vi.stubGlobal('fetch',()=>new Response('abc',{headers:{'content-length':'5'}}));
    await expect(directBlob('https://video.twimg.com/x',signal,3)).rejects.toThrow();
    await expect(directBlob('https://video.twimg.com/x',signal,8)).rejects.toThrow();
  });
  it('preserves offsets and samples and reuses already compact files',async()=>{
    const original=new File([atom('ftyp',1),atom('free',0),atom('moov',2),atom('mdat',3)],'a.mp4',{type:'video/mp4'});
    expect(await compactMp4(original,signal)).toBe(original);
    const result=await compactMp4(new File([original,atom('skip',0),atom('free',0)],original.name,{type:original.type}),signal);
    expect(await result.arrayBuffer()).toEqual(await original.arrayBuffer());
    await expect(verifyMp4(original.slice(0,-1),signal)).rejects.toThrow();
    await expect(verifyMp4(original.slice(0,9),signal)).rejects.toThrow();
  });
});
