import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const source = readFileSync(new URL('../deploy/server/quiet-room-capacity', import.meta.url), 'utf8');
const helper = readFileSync(new URL('../deploy/server/quiet-room-deploy', import.meta.url), 'utf8');

describe('capacity governance protection', () => {
  it('preserves newest archives, failure pairs and unrelated files across repeated releases', () => {
    const result = spawnSync('python3', ['-c', `
import runpy, tempfile
from pathlib import Path
import ast
ast.parse(Path('deploy/server/quiet-room-capacity').read_text(), feature_version=6)
m=runpy.run_path('deploy/server/quiet-room-capacity')
with tempfile.TemporaryDirectory() as d:
 p=Path(d)
 for day in range(1,11):
  (p/f'data-202609{day:02}T000000Z-aaaaaaaaaaaa.tar.gz').touch()
 (p/'failed-cutover-20260902T000000Z-aaaaaaaaaaaa.tar.gz').touch()
 (p/'catalog-old.tar.gz').touch()
 (p/'data-20260911T000000Z-bbbbbbbbbbbb.tar.gz').symlink_to(p/'catalog-old.tar.gz')
 removed=m['archive_plan'](p.iterdir())
 assert len(removed)==6, removed
 assert all('20260902' not in q.name for q in removed)
 assert all('20260908' not in q.name for q in removed)
 for q in removed: q.unlink()
 assert m['archive_plan'](p.iterdir())==[]
 assert (p/'catalog-old.tar.gz').exists()
 assert (p/'failed-cutover-20260902T000000Z-aaaaaaaaaaaa.tar.gz').exists()
`], { encoding: 'utf8' });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  });
  it('blocks low disk, inode or memory headroom and preserves three distinct successful releases', () => {
    const result = spawnSync('python3', ['-c', `
import runpy
m=runpy.run_path('deploy/server/quiet-room-capacity'); G=1024**3
healthy=dict(availableBytes=12*G, usedPercent=50, inodeUsedPercent=10, memoryAvailableBytes=G)
assert m['problems'](healthy,True)==[]
for field,value in [('availableBytes',3*G),('usedPercent',90),('inodeUsedPercent',80),('memoryAvailableBytes',300*1024**2)]:
 assert m['problems'](dict(healthy,**{field:value}),True)
assert m['problems'](dict(healthy,availableBytes=7*G),True)==[]
assert m['problems'](dict(healthy,usedPercent=80),True)==[]
assert m['problems'](dict(healthy,usedPercent=89),True)==[]
assert m['problems'](dict(healthy,usedPercent=75),True)==[]
assert m['problems'](dict(healthy,usedPercent=75),False)
assert m['problems'].__defaults__[1]==4*G
keep,_=m['protected_releases']('a'*40,[('4','a'*40),('3','a'*40),('2','b'*40),('1','c'*40),('0','d'*40)],{'e'*12})
assert keep=={'a'*40,'b'*40,'c'*40}
`], { encoding: 'utf8' });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  });
  it('never removes current, rollback, failed or container-referenced images during cleanup', () => {
    const result = spawnSync('python3', ['-c', `
import runpy, tempfile
from pathlib import Path
m=runpy.run_path('deploy/server/quiet-room-capacity')
g=m['cleanup'].__globals__
with tempfile.TemporaryDirectory() as d:
 p=Path(d); (p/'backups/predeploy').mkdir(parents=True); (p/'git-releases').mkdir()
 (p/'state').mkdir(); (p/'deploy-state').mkdir()
 (p/'deploy-state/current-sha').write_text('a'*40)
 (p/'backups/predeploy/failed-cutover-20260901T000000Z-dddddddddddd.tar.gz').touch()
 g.update(ROOT=p,STATE=p/'state',LOCK=p/'lock',metrics=lambda:{'memoryAvailableBytes':1024**3},read_successes=lambda:[('3','a'*40),('2','b'*40),('1','c'*40)])
 calls=[]
 def fake(args,timeout=30):
  calls.append(args)
  if args[:3]==['docker','ps','-aq']: return 'stopped-container'
  if args[:2]==['docker','inspect']: return 'sha256:'+ 'f'*64
  if args[:3]==['docker','image','ls']:
   return chr(10).join(c*40+' sha256:'+c*64 for c in 'abcdef')
  if args[:3]==['docker','image','inspect']:
   return 'sha256:'+args[3].split(':')[1][0]*64
  if args[:3]==['docker','image','rm']: return ''
  if args[0]=='runuser': return ''
  raise AssertionError(args)
 g['run']=fake
 assert m['cleanup']()==0
 assert [a[3] for a in calls if a[:3]==['docker','image','rm']]==['quiet-room-app:'+'e'*40]
 assert not any('prune' in a for a in calls)
`], { encoding: 'utf8' });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  });
  it('checks capacity before building and before downtime; avoids online cache pruning', () => {
    const guard = '/usr/local/sbin/quiet-room-capacity preflight';
    expect(helper.indexOf(guard)).toBeLessThan(helper.indexOf('deploy_phase_start fetch-source'));
    expect(helper.lastIndexOf(guard)).toBeLessThan(helper.indexOf('cutover_started=1'));
    expect(source).not.toContain("'builder', 'prune'");
    expect(source).not.toContain("'volume', 'prune'");
    expect(source).toContain('fcntl.LOCK_EX | fcntl.LOCK_NB');
  });
});
