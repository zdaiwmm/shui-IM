import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('supervised cache maintenance boundaries', () => {
  it('blocks plan and apply before contacting Docker when an incident disables maintenance', () => {
    const result = spawnSync('python3', ['-c', `
import runpy, sys, tempfile
from pathlib import Path
m=runpy.run_path('deploy/server/quiet-room-cache-maintenance')
g=m['apply'].__globals__
with tempfile.TemporaryDirectory() as d:
 p=Path(d); g['STATE']=p; g['LOCK']=p/'lock'
 calls=[]
 def forbidden(*args,**kwargs):
  calls.append(args); raise AssertionError('disabled maintenance touched Docker or recovery')
 g.update(run=forbidden,inventory=forbidden,restore_containers=forbidden)
 marker=p/'cache-maintenance-disabled.json'
 for kind in ['record','directory','dangling-link']:
  if kind=='record': marker.write_text('{}')
  elif kind=='directory': marker.mkdir()
  else: marker.symlink_to(p/'missing')
  sys.argv=['quiet-room-cache-maintenance','plan']
  for operation in [m['main'],lambda:m['apply'](b'{}','0'*64)]:
   try: operation(); raise AssertionError('disabled maintenance accepted')
   except ValueError as error: assert 'disabled' in str(error)
  assert not calls and not (p/'lock').exists() and not (p/'maintenance').exists()
  if kind=='directory': marker.rmdir()
  else: marker.unlink()
`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });
  it('preserves digest-only registry images while rejecting anonymous or malformed image identities', () => {
    const result = spawnSync('python3', ['-c', `
import runpy
m=runpy.run_path('deploy/server/quiet-room-cache-maintenance')
g=m['image_references'].__globals__
rows=['quiet-room-app production <none> sha256:'+'b'*64,
      'example/coturn <none> sha256:'+'d'*64+' sha256:'+'c'*64]
calls=[]
def run(args,timeout=30):
 calls.append(args)
 return '\\n'.join(rows)
g['run']=run
assert m['image_references']()==['example/coturn@sha256:'+'d'*64+' sha256:'+'c'*64,'quiet-room-app:production sha256:'+'b'*64]
assert '--digests' in calls[0] and '--no-trunc' in calls[0]
for invalid in ['<none> <none> <none> sha256:'+'c'*64,
                'example/coturn <none> <none> sha256:'+'c'*64,
                'example/coturn <none> invalid sha256:'+'c'*64]:
 rows[:]=[invalid]
 try: m['image_references'](); raise AssertionError('unclassified image accepted')
 except ValueError: pass
`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });
  it('binds the plan, preserves unrelated state and keeps the gate closed after an uncertain daemon timeout', () => {
    const result = spawnSync('python3', ['-c', `
import hashlib, json, runpy, subprocess, tempfile, time
from pathlib import Path
m=runpy.run_path('deploy/server/quiet-room-cache-maintenance')
g=m['apply'].__globals__
with tempfile.TemporaryDirectory() as d:
 p=Path(d); (p/'state').mkdir()
 plan=dict(version=1,currentSha='a'*40,images=['app sha256:'+'b'*64],containers=[dict(name='app',imageId='sha256:'+'b'*64)],filter='until=168h',keepStorage='2GB')
 g.update(ROOT=p,STATE=p/'state',LOCK=p/'lock',inventory=lambda:plan,image_references=lambda:plan['images'],memory_available=lambda:2*1024**3,free_bytes=lambda:2*1024**3)
 raw=(json.dumps(dict(plan,checkedAt=int(time.time())))+'\\n').encode()
 digest=hashlib.sha256(raw).hexdigest()
 calls=[]; restored=[]
 g['restore_containers']=lambda plan:restored.append(plan)
 def run(args,timeout=30):
  calls.append(args)
  if args[:3]==['docker','image','ls']: return 'app sha256:'+'b'*64
  return ''
 g['run']=run
 try: m['apply'](raw,'0'*64); raise AssertionError('bad digest accepted')
 except ValueError: pass
 assert not calls and not (p/'state/maintenance').exists()
 old=json.dumps(dict(plan,checkedAt=int(time.time())-901)).encode()
 try: m['apply'](old,hashlib.sha256(old).hexdigest()); raise AssertionError('expired plan accepted')
 except ValueError: pass
 assert not calls
 m['apply'](raw,digest)
 assert restored==[plan] and not (p/'state/maintenance').exists()
 assert any(a[:3]==['docker','builder','prune'] for a in calls)
 assert not any('volume' in a or 'system' in a for a in calls)
 calls.clear(); restored.clear()
 def timeout_run(args,timeout=30):
  calls.append(args)
  if args[:3]==['docker','builder','prune']: raise subprocess.TimeoutExpired(args,timeout)
  return ''
 g['run']=timeout_run
 try: m['apply'](raw,digest); raise AssertionError('timeout accepted')
 except ValueError: pass
 assert (p/'state/maintenance').exists() and not restored
 (p/'state/maintenance').unlink()
 g['run']=run
 def unavailable_images(): raise subprocess.CalledProcessError(1,['docker','image','ls'])
 g['image_references']=unavailable_images
 try: m['apply'](raw,digest); raise AssertionError('unverified image inventory accepted')
 except subprocess.CalledProcessError: pass
 assert (p/'state/maintenance').exists() and not restored
`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });
  it('does not let a dirty old release prevent removal of a separate clean release', () => {
    const result = spawnSync('python3', ['-c', `
import runpy, tempfile
from pathlib import Path
m=runpy.run_path('deploy/server/quiet-room-capacity'); g=m['cleanup'].__globals__
with tempfile.TemporaryDirectory() as d:
 p=Path(d); (p/'backups/predeploy').mkdir(parents=True); (p/'git-releases').mkdir(); (p/'state').mkdir(); (p/'deploy-state').mkdir()
 (p/'deploy-state/current-sha').write_text('a'*40)
 dirty=p/'git-releases/20260901T000000Z-dddddddddddd'; clean=p/'git-releases/20260902T000000Z-eeeeeeeeeeee'
 dirty.mkdir(); clean.mkdir()
 successes=[('5','a'*40),('4','b'*40),('3','c'*40),('2','d'*40),('1','e'*40)]
 g.update(ROOT=p,STATE=p/'state',LOCK=p/'lock',metrics=lambda:dict(memoryAvailableBytes=1024**3),read_successes=lambda:successes)
 calls=[]
 def run(args,timeout=30):
  calls.append(args)
  if args[:3]==['docker','image','inspect']: return 'sha256:'+'f'*64
  if args[:3]==['docker','ps','-aq']: return ''
  if args[:3]==['docker','image','ls']: return ''
  if 'list' in args: return 'worktree '+str(dirty)+'\\nworktree '+str(clean)
  if 'status' in args: return ' M deploy/turnserver.conf' if str(dirty) in args else ''
  if 'ls-files' in args: return ''
  if 'remove' in args: return ''
  raise AssertionError(args)
 g['run']=run
 assert m['cleanup']()==1
 assert [a[-1] for a in calls if 'remove' in a]==[str(clean)]
 assert not any('--force' in a or 'reset' in a for a in calls)
`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('CLEANUP_PARTIAL');
    expect(result.stdout).toContain('modified-or-untracked');
  });
});
