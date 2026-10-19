import {describe,it,expect,vi} from 'vitest';
import {syncCloudBackup} from '../src/lib/cloud-backup';
import {isChamberVault} from '../src/lib/chamber-space';
import {syncChamberHistory} from '../src/lib/chamber-history';
import {syncPersonalDirectory} from '../src/lib/personal-directory-sync';
import type {VaultSession} from '../src/lib/vault';

describe('retired original-device state remains inert',()=>{
  it('does not run Chamber services for an old first-step binding',async()=>{
    const vault={personalBinding:{identity:{id:'old-root'}},personalPeers:[],personalMigration:{state:'staged'},pairingState:'ready'};
    const before=structuredClone(vault),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Retired bindings must remain inert'));
    try {
      expect(isChamberVault(vault as any)).toBe(false);
      await syncChamberHistory({vault} as VaultSession,new AbortController().signal,true);
      await syncPersonalDirectory({vault} as VaultSession,new AbortController().signal);
      expect(fetch).not.toHaveBeenCalled();expect(vault).toEqual(before);
      expect(isChamberVault({personalBinding:vault.personalBinding} as any)).toBe(true);
    } finally {fetch.mockRestore();}
  });
  it.each([false,true])('preserves existing recovery packages for a retired local candidate (force=%s)',async force=>{
    // This local-only candidate contains both a fresh logical identity and the
    // original private checkpoint. Even a forced retry must not serialize it,
    // replace the still-valid old package, or contact either backup API.
    const vault={personalBinding:{identity:{id:'candidate-root'}},personalMigration:{state:'staged'},
      identity:{publicBundle:{deviceId:'fresh-device'}},accessToken:'inactive-candidate',
      migrationSource:{identity:{signingPrivateKey:{d:'synthetic-source-only'}},personalMigration:{stage:{master:'synthetic-stage-only'}}}};
    const before=structuredClone(vault),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Pending candidate must remain local'));
    try{
      await syncCloudBackup({vault} as unknown as VaultSession,new AbortController().signal,{force});
      expect(fetch).not.toHaveBeenCalled();expect(vault).toEqual(before);
    }finally{fetch.mockRestore();}
  });
});
