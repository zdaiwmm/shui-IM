import {describe,it,expect,vi} from 'vitest';
import {syncCloudBackup} from '../src/lib/cloud-backup';
import type {VaultSession} from '../src/lib/vault';

describe('pending original-device migration backup boundary',()=>{
  it.each([false,true])('preserves the old recovery package while cutover is pending (force=%s)',async force=>{
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
