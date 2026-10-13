import {afterEach, describe, expect, it, vi} from 'vitest';
import {platformVaultSetupState, probePlatformVaultCapabilities} from '../src/lib/platform-vault';
afterEach(()=>vi.unstubAllGlobals());
function setup(hostname='localhost', capability?: boolean) {
  class Credential { static getClientCapabilities=async()=>capability===undefined?{}:{'extension:prf':capability}; }
  vi.stubGlobal('window',{isSecureContext:true,location:{hostname},PublicKeyCredential:Credential});
  vi.stubGlobal('navigator',{credentials:{create(){},get(){}}});
}
describe('daily protection preflight',()=>{
  it('recognizes IP origins before presenting passkey setup',()=>{for(const host of ['127.0.0.1','192.168.1.2','[::1]']){setup(host);expect(platformVaultSetupState()).toBe('unsupported');}});
  it('keeps unknown capabilities on the passkey path',async()=>{setup();await probePlatformVaultCapabilities();expect(platformVaultSetupState()).toBe('unknown');});
  it('only uses an explicit unsupported PRF signal',async()=>{setup('localhost',false);await probePlatformVaultCapabilities();expect(platformVaultSetupState()).toBe('unsupported');setup('localhost',true);await probePlatformVaultCapabilities();expect(platformVaultSetupState()).toBe('available');});
  it('does not downgrade an insecure connection to password',()=>{setup();window.isSecureContext=false;expect(platformVaultSetupState()).toBe('insecure');});
});
