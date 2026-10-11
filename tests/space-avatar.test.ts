import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { avatarEmoji, defaultSpaceAvatar, validSpaceAvatar, MAX_AVATAR_IMAGE_BYTES } from '../src/lib/space-avatar';
import { boundAvatarCrop, neutralCrop, zoomAvatarCrop } from '../src/lib/avatar-crop';
import { catalogSpaceAllowed, mergeCatalogSpaces } from '../src/lib/browser-access';
import { newSpaceRecoveryCode, openSpaceDirectory, recoveryDirectoryEntries, sealSpaceDirectory } from '../src/lib/spaces';

describe('private space avatars', () => {
  it('bundles verified looping animations and first-frame alternatives without external display URLs', () => {
    expect(avatarEmoji.length).toBeGreaterThanOrEqual(64);
    expect(new Set(avatarEmoji.map(item => item.id)).size).toBe(avatarEmoji.length);
    for (const item of avatarEmoji) for (const still of [false, true]) {
      const bytes = readFileSync(new URL(`../public/space-avatars/${item.id}${still ? '-still' : ''}.webp`, import.meta.url));
      expect(bytes.length).toBe(still ? item.stillSize : item.size);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(still ? item.stillDigest : item.digest);
      expect(bytes.includes(Buffer.from('ANIM'))).toBe(!still);
      expect(item.license).toBe('CC-BY-4.0');
    }
    expect(validSpaceAvatar(defaultSpaceAvatar())).toBe(true);
  });
  it('rejects remote URLs, executable markup, unsupported emoji, fields and oversized images', () => {
    for (const avatar of [
      {...defaultSpaceAvatar(), emoji:'unknown'}, {...defaultSpaceAvatar(), background:-1}, {...defaultSpaceAvatar(), url:'https://example.com'},
      {v:1,kind:'image',data:'https://example.com/image.jpg'}, {v:1,kind:'image',data:'data:image/svg+xml,<svg onload="alert(1)"/>'},
      {v:1,kind:'image',data:'data:image/jpeg;base64,/9j/'+ 'A'.repeat(MAX_AVATAR_IMAGE_BYTES * 2)},
    ]) expect(validSpaceAvatar(avatar)).toBe(false);
  });
  it('keeps participant identity encrypted, merges it between own devices, and excludes message capabilities', async () => {
    const roomId=crypto.randomUUID(), avatar=defaultSpaceAvatar();
    const entries = recoveryDirectoryEntries([{roomId,name:'私有名称',avatar,preview:'消息',localId:'local',unread:8}]);
    expect(entries).toEqual([{roomId,name:'私有名称',avatar}]);
    const code=newSpaceRecoveryCode(), sealed=await sealSpaceDirectory(code,entries);
    expect(JSON.stringify(sealed)).not.toContain('私有名称');
    expect(JSON.stringify(sealed)).not.toContain('emoji');
    expect(await openSpaceDirectory(code,sealed)).toEqual(entries);
    expect(mergeCatalogSpaces([{roomId,name:'旧名称',avatar}], [{roomId,name:'改名'}])[0]?.avatar).toEqual(avatar);
    expect(catalogSpaceAllowed({roomId,name:'有效',avatar})).toBe(true);
    expect(catalogSpaceAllowed({roomId,name:'无效',avatar:{...avatar,background:100} as typeof avatar})).toBe(false);
  });
});
describe('avatar crop geometry', () => {
  it('covers the circle at every scale and clamps landscape/portrait movement', () => {
    expect(boundAvatarCrop({zoom:0,x:10,y:10},2)).toEqual({zoom:1,x:.5,y:0});
    expect(boundAvatarCrop({zoom:4,x:-10,y:10},.5)).toEqual({zoom:3,x:-1,y:2.5});
    expect(boundAvatarCrop(neutralCrop(),1)).toEqual(neutralCrop());
  });
  it('keeps the pinched image point under the moving fingers and rebases smoothly', () => {
    const from={x:.1,y:.1}, to={x:.2,y:.05};
    const crop=zoomAvatarCrop(neutralCrop(),2,1,from,to);
    expect(crop.x).toBeCloseTo(0); expect(crop.y).toBeCloseTo(-.15);
    expect((to.x-crop.x)/crop.zoom).toBeCloseTo(from.x);
    expect((to.y-crop.y)/crop.zoom).toBeCloseTo(from.y);
    expect(zoomAvatarCrop(crop,1,1)).toEqual(neutralCrop());
  });
});
