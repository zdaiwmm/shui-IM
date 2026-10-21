import { describe, it, expect } from 'vitest';
import { newArchiveKey, sealArchiveObject, openArchiveObject, verifyArchiveObject, protectArchiveCard, unlockArchiveCard, archiveReadToken, archiveAccessToken } from '../src/lib/room-archive-crypto';

describe('independent participant archive', () => {
  it('restores with its own material without any room or opposite participant credential', async () => {
    const key = newArchiveKey(), other = newArchiveKey();
    const payload = { kind: 'message', sourceArchive: 'old-room', text: 'private imported history' };
    const object = await sealArchiveObject(key, payload);
    expect(await openArchiveObject(key, object)).toEqual(payload);
    expect(verifyArchiveObject(other.descriptor, object)).toBe(false);
    await expect(openArchiveObject(other, object)).rejects.toThrow();
    expect(JSON.stringify(object)).not.toContain(payload.text);
    expect(JSON.stringify(key.descriptor)).not.toContain(key.seed);
    expect(archiveReadToken(key.seed)).not.toEqual(key.seed);
  });
  it('protects a random rotated read capability without changing history identity',async()=>{
    const original=newArchiveKey(),key={...original,readToken:newArchiveKey().seed};
    const object=await sealArchiveObject(original,{text:'before rotation'}),card=await protectArchiveCard(key,'a changed long password');
    const unlocked=await unlockArchiveCard(card,'a changed long password');
    expect(unlocked).toEqual(key);expect(await openArchiveObject(unlocked,object)).toEqual({text:'before rotation'});
    expect(archiveAccessToken(unlocked)).not.toBe(archiveReadToken(original.seed));
    await expect(unlockArchiveCard(card,'the previous password')).rejects.toThrow();
    await expect(protectArchiveCard({...key,readToken:'invalid'},'a changed long password')).rejects.toThrow();
  });
  it('rejects changed ownership, identifiers, ciphertext and signatures', async () => {
    const key = newArchiveKey(), object = await sealArchiveObject(key, { text: 'hello' });
    for (const changed of [{ ...object, id: crypto.randomUUID() }, { ...object, enc: newArchiveKey().seed },
      { ...object, ciphertext: object.ciphertext.slice(0, -2) + 'AA' }, { ...object, archiveId: newArchiveKey().descriptor.id }]) {
      await expect(openArchiveObject(key, changed)).rejects.toThrow();
    }
  });
  it('requires the independent long password and authenticates KDF parameters', async () => {
    const key = newArchiveKey();
    await expect(protectArchiveCard(key, '123456')).rejects.toThrow();
    const card = await protectArchiveCard(key, 'a long recovery password');
    expect(card).not.toContain(key.seed);
    expect(await unlockArchiveCard(card, 'a long recovery password')).toEqual(key);
    await expect(unlockArchiveCard(card, 'another long password')).rejects.toThrow();
    const malformed = JSON.parse(card); malformed.kdf.memorySize *= 2;
    await expect(unlockArchiveCard(JSON.stringify(malformed), 'a long recovery password')).rejects.toThrow();
  });
});
