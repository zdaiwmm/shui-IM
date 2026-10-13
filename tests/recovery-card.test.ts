import { describe, expect, it } from 'vitest';
import { readRecoveryCard, writeRecoveryCard, MAX_RECOVERY_CARD_BYTES } from '../src/lib/recovery-card';
import { newSpaceRecoveryCode } from '../src/lib/spaces';
import { newRecoveryCode } from '../src/lib/backup-crypto';
import legacy from '../src/lib/space-avatar-catalog.json';
import { validSpaceAvatar } from '../src/lib/space-avatar';
describe('portable recovery cards', () => {
  it('round-trips the existing capability without introducing a credential', () => {
    for (const code of [newSpaceRecoveryCode(), newRecoveryCode().code]) {
      expect(readRecoveryCard(writeRecoveryCard(code))).toBe(code);
      expect(readRecoveryCard(`  ${code}\n`)).toBe(code);
      expect(Object.keys(JSON.parse(writeRecoveryCard(code)))).toEqual(['format','version','recoveryCode']);
    }
  });
  it('rejects foreign, truncated, unsupported-version and oversized content', () => {
    for (const text of ['{', '{}', 'password', 'QR4-broken', ' '.repeat(MAX_RECOVERY_CARD_BYTES+1), JSON.stringify({format:'quiet-room-recovery-card',version:2,recoveryCode:newSpaceRecoveryCode()})]) expect(()=>readRecoveryCard(text)).toThrow();
  });
  it('keeps previously saved emoji identifiers valid after the picker changes', () => {
    for (const item of legacy) expect(validSpaceAvatar({v:1,kind:'emoji',emoji:item.id,background:0})).toBe(true);
  });
});
