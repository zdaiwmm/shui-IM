import {describe,it,expect} from 'vitest';
import {cardRaster,readCardRaster} from '../src/lib/archive-card-image';
describe('encrypted recovery image raster',()=>{
  it('preserves UTF-8 without a raw recovery-key side channel',()=>{
    const content=JSON.stringify({ciphertext:'a'.repeat(2000),label:'加密'});
    expect(readCardRaster(cardRaster(content))).toBe(content);
  });
  it('rejects a damaged bit and an oversized untrusted length',()=>{
    const damaged=cardRaster('encrypted');damaged[40]^=1;expect(()=>readCardRaster(damaged)).toThrow('损坏');
    const forged=cardRaster('encrypted');new DataView(forged.buffer).setUint32(4,0xffffffff);expect(()=>readCardRaster(forged)).toThrow('格式');
  });
});
