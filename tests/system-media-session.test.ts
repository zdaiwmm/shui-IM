import { afterEach, expect, it, vi } from 'vitest';
import { releaseSystemMediaSession } from '../src/lib/system-media-session';
afterEach(()=>vi.unstubAllGlobals());
it('releases stale metadata, position and playback actions even with partial browser support', () => {
  const session={metadata:{title:'private'},playbackState:'paused',setPositionState:vi.fn(),setActionHandler:vi.fn((action:string)=>{if(action==='stop')throw Error('unsupported');})};
  vi.stubGlobal('navigator',{mediaSession:session}); releaseSystemMediaSession();
  expect(session.metadata).toBeNull(); expect(session.playbackState).toBe('none');
  expect(session.setPositionState).toHaveBeenCalledExactlyOnceWith();
  expect(session.setActionHandler).toHaveBeenCalledWith('nexttrack',null);
  vi.stubGlobal('navigator',{}); expect(()=>releaseSystemMediaSession()).not.toThrow();
});
