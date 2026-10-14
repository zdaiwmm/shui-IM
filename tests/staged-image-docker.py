"""Real Docker online import + activation guard fixture. Isolated synthetic state only.

Uses the image already built by this CI job. Does not install privileged helpers,
contact production, restore data, or share the production Docker project/volume.
Activation stops at compose-preflight; the unchanged cutover/rollback path is
covered by deploy-gate/deploy-stop/deploy-script fixtures and the full suite.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import tempfile
import time

assert os.geteuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true'
repo = Path.cwd()
sha = os.environ['GITHUB_SHA']
image = 'quiet-room-app:'+sha
image_id = subprocess.check_output(['docker','image','inspect',image,'--format','{{.Id}}'],text=True).strip()
user = pwd.getpwuid(int(os.environ.get('SUDO_UID','1001')))
previous = subprocess.check_output(['runuser','-u',user.pw_name,'--','git','rev-parse',sha+'^1'],text=True).strip()
fixture_id = 'quiet-v2-'+str(os.getpid())
container = fixture_id+'-old'
volume = fixture_id+'-data'
root = Path(tempfile.mkdtemp(prefix='quiet-staging-docker-'))
root.chmod(0o755)

def command(*args, **kwargs):
    return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
def docker(*args): return command('docker',*args).stdout.decode().strip()
def snapshot():
    state = json.loads(docker('inspect',container))[0]
    mount = docker('volume','inspect',volume,'--format','{{.Mountpoint}}')
    st = os.stat(mount)
    return dict(id=state['Id'],image=state['Image'],started=state['State']['StartedAt'],volume=(st.st_dev,st.st_ino),data=docker('exec',container,'sha256sum','/app/data/sentinel'))
try:
    app = root/'app'
    app.mkdir(); os.chown(app,user.pw_uid,user.pw_gid)
    remote = app/'remote.git'
    mirror = app/'repository.git'
    git = ['runuser','-u',user.pw_name,'--','git']
    command(*git,'clone','--bare','--no-hardlinks',str(repo),str(remote))
    command(*git,'--git-dir='+str(remote),'update-ref','refs/heads/main',sha)
    command(*git,'clone','--bare',str(remote),str(mirror))
    (app/'shared').mkdir()
    (app/'shared'/'production.env').write_text('SYNTHETIC_FIXTURE=1\n')
    (app/'deploy-state').mkdir()
    (app/'deploy-state'/'current-sha').write_text(previous+'\n')
    lock = root/'lock'
    # Only fixed paths and deploy identity are substituted into this disposable copy.
    source = (repo/'deploy/server/quiet-room-deploy').read_text()
    source = source.replace('readonly APP_ROOT=/opt/quiet-room','readonly APP_ROOT='+str(app))
    source = source.replace('/run/lock/quiet-room-deploy.lock',str(lock))
    source = source.replace('/var/lib/quiet-room-deploy',str(root/'maintenance'))
    source = source.replace('/usr/local/sbin/quiet-room-capacity preflight',': # capacity already isolated in fixture')
    source = source.replace('/etc/quiet-room/deployment.json',str(root/'no-deployment.json'))
    source = source.replace('/etc/quiet-room/startup-health.compose.yaml',str(root/'no-overlay.yaml'))
    source = source.replace('runuser -u deploy','runuser -u '+user.pw_name)
    source = source.replace('-o deploy -g deploy','-o '+str(user.pw_uid)+' -g '+str(user.pw_gid))
    source = source.replace('quiet-room-quiet-room-1',container)
    source = source.replace('deploy_phase_start compose-preflight','printf ACTIVATION_VALIDATED\\n\nexit 0\ndeploy_phase_start compose-preflight',1)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    source = source.replace('readonly PUBLIC_HEALTH_URL="$PUBLIC_ORIGIN/api/health"','readonly PUBLIC_HEALTH_URL=http://127.0.0.1:'+str(port)+'/api/health')
    helper = root/'helper'
    helper.write_text(source); helper.chmod(0o755)
    # A separate old image identity prevents a target-tag import from aliasing the live tag.
    command('docker','build','--network','none','--tag',fixture_id+':old','-',input=('FROM '+image+'\nLABEL org.opencontainers.image.revision='+previous+'\n').encode())
    docker('volume','create',volume)
    js="const fs=require('fs');fs.writeFileSync('/app/data/sentinel','acknowledged-before-staging');require('http').createServer((q,r)=>{r.end(JSON.stringify({ok:true,database:true,storage:true}))}).listen(8080,'0.0.0.0')"
    docker('run','--detach','--name',container,'--volume',volume+':/app/data','--publish','127.0.0.1:'+str(port)+':8080',fixture_id+':old','node','-e',js)
    for _ in range(90):
        health=docker('inspect',container,'--format','{{.State.Health.Status}}')
        if health=='healthy' and os.getloadavg()[0]<=max(1,os.cpu_count() or 1): break
        time.sleep(1)
    else: raise RuntimeError('Fixture host/application not ready for guarded online staging')
    before = snapshot()
    archive = root/'image.tar.gz'
    save = subprocess.Popen(['docker','image','save',image],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    with gzip.open(archive,'wb',compresslevel=1) as output:
        shutil.copyfileobj(save.stdout,output,128*1024)
    if save.wait()!=0: raise RuntimeError('Fixture export failed')
    digest=hashlib.file_digest(open(archive,'rb'),'sha256').hexdigest()
    def invoke(mode, checksum=digest, check=True):
        with open(archive,'rb') as payload:
            result=subprocess.run(['bash',str(helper),mode,sha,image_id,checksum,previous],stdin=payload,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180)
        if check and result.returncode: raise RuntimeError('Fixture helper failed: '+result.stderr.decode()[-1800:])
        return result
    bad=invoke('--stage','0'*64,check=False)
    assert bad.returncode!=0 and snapshot()==before
    time.sleep(1.1)
    staged=invoke('--stage')
    assert ('STAGE_OK sha='+sha).encode() in staged.stdout
    assert snapshot()==before and not (root/'maintenance'/'maintenance').exists()
    receipt=app/'deploy-state'/'staged'/(sha+'.json')
    record=json.loads(receipt.read_text())
    assert record['previousSha']==previous and record['imageId']==image_id and os.stat(receipt).st_uid==0
    # Wrong image cannot consume the valid receipt or stop the old container.
    with open(archive,'rb') as payload:
        wrong=subprocess.run(['bash',str(helper),'--activate',sha,'sha256:'+'0'*64,digest,previous],stdin=payload,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    assert wrong.returncode!=0 and receipt.exists() and snapshot()==before
    activated=invoke('--activate')
    assert b'ACTIVATION_VALIDATED' in activated.stdout and not receipt.exists() and snapshot()==before
    repeated=invoke('--activate',check=False)
    assert repeated.returncode!=0 and snapshot()==before
    print('STAGED_DOCKER_OK import=verified live-container=unchanged volume=unchanged data=unchanged activation-guard=verified replay=rejected')
finally:
    subprocess.run(['docker','rm','--force',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['docker','volume','rm',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['docker','image','rm',fixture_id+':old'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    shutil.rmtree(root,ignore_errors=True)
