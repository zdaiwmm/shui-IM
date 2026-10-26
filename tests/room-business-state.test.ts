import {describe,it,expect} from 'vitest';
import {roomBusinessState} from '../src/lib/room-business-state';
import type {Vault} from '../src/lib/types';
describe('room business facts do not grant capabilities',()=>{
 it('separates discovered, applying and authorized with expiry',()=>{expect(roomBusinessState({catalogOnly:true}).stage).toBe('discovered');const request={status:'requested' as const,expiresAt:'2026-10-27T00:10:00Z'};expect(roomBusinessState({catalogOnly:true,request,now:Date.parse('2026-10-27T00:00:00Z')}).stage).toBe('applying');expect(roomBusinessState({catalogOnly:true,request,now:Date.parse('2026-10-27T00:11:00Z')}).stage).toBe('discovered');expect(roomBusinessState({catalogOnly:true,request:{...request,status:'approved'},now:Date.parse('2026-10-27T00:00:00Z')}).stage).toBe('authorized');});
 it('keeps historical restoration independent of membership and connection',()=>{const vault={identity:{publicBundle:{deviceId:'own'}},members:[],pairingState:'ready',mls:{phase:'active'}} as unknown as Vault;expect(roomBusinessState({vault})).toMatchObject({stage:'ready',history:'separate'});vault.localAccessDeniedDeviceId='own';expect(roomBusinessState({vault}).stage).toBe('denied');});
});
