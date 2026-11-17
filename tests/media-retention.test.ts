import { describe, expect, it } from 'vitest';
import { attachmentBlobIds, staleMediaActivity, TRANSFER_RETENTION_MS } from '../src/lib/media-retention';

describe('local transfer retention',()=>{
  it('expires at exactly 24 hours of inactivity, preserving fresh and invalid clocks',()=>{
    const now=3*TRANSFER_RETENTION_MS;
    expect(TRANSFER_RETENTION_MS).toBe(86_400_000);
    expect(staleMediaActivity(now-TRANSFER_RETENTION_MS,now)).toBe(true);
    expect(staleMediaActivity(now-TRANSFER_RETENTION_MS+1,now)).toBe(false);
    for(const time of [now+1,NaN,Infinity,-1,0.5])expect(staleMediaActivity(time,now)).toBe(false);
  });
  it('keeps every attachment category, including Safe-only files and audio',()=>{
    for(const kind of ['image','gallery-image','image-album','file','gallery-file','audio']){
      const manifest={blobId:'retained'};
      expect(attachmentBlobIds({kind,image:manifest,images:[manifest],file:manifest,audio:manifest} as any)).toEqual(['retained']);
    }
    expect(attachmentBlobIds({v:1,kind:'text',text:'not an attachment',sentAt:''})).toEqual([]);
  });
});
