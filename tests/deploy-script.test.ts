import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = path.join(PROJECT_ROOT, 'Dockerfile');
const DEPLOY_SCRIPT = path.join(PROJECT_ROOT, 'deploy/server/quiet-room-deploy');
const LOCAL_DEPLOY_SCRIPT = path.join(PROJECT_ROOT, 'scripts/deploy-production.sh');
const NGINX_CONFIG = path.join(PROJECT_ROOT, 'deploy/nginx-ai.shui.click.conf');
const NGINX_BOOTSTRAP_CONFIG = path.join(PROJECT_ROOT, 'deploy/nginx-ai.shui.click-bootstrap.conf');

describe('production deployment rollback safety contract', () => {
  it('copies every build-time release manifest before building the client', async () => {
    const source = await readFile(DOCKERFILE, 'utf8');
    const buildStage = source.slice(0, source.indexOf('FROM node:24-alpine AS runtime'));

    expect(buildStage).toContain('COPY tsconfig.json vite.config.ts index.html admin.html release.json ./');
    expect(buildStage.indexOf('release.json')).toBeLessThan(buildStage.indexOf('RUN npm run build'));
  });

  it('has valid Bash syntax', () => {
    const result = spawnSync('bash', ['-n', DEPLOY_SCRIPT], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('has valid POSIX shell syntax in both archive containers', async () => {
    const source = await readFile(DEPLOY_SCRIPT, 'utf8');
    const embeddedScripts = [...source.matchAll(/sh -ceu '\n([\s\S]*?)\n    '/g)].map((match) => match[1]);

    expect(embeddedScripts).toHaveLength(2);
    for (const embedded of embeddedScripts) {
      const result = spawnSync('sh', ['-n'], { encoding: 'utf8', input: embedded });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
  });

  it('atomically publishes and verifies cold archives', async () => {
    const source = await readFile(DEPLOY_SCRIPT, 'utf8');
    const archiveFunction = source.slice(
      source.indexOf('create_data_archive()'),
      source.indexOf('restore_data_archive()'),
    );

    expect(archiveFunction).toContain('.${ARCHIVE_NAME}.partial');
    expect(archiveFunction.indexOf('tar -tzf "$partial"')).toBeLessThan(
      archiveFunction.indexOf('mv -- "$partial" "$final"'),
    );
    expect(archiveFunction.indexOf('mv -- "$partial" "$final"')).toBeLessThan(
      archiveFunction.indexOf('validate_data_archive "$archive_path"'),
    );
  });

  it('stops new containers, preserves failed-cutover writes, restores data, then starts the old image', async () => {
    const source = await readFile(DEPLOY_SCRIPT, 'utf8');
    const rollback = source.slice(source.indexOf('rollback()'), source.indexOf("trap 'exit_code=$?"));
    const stop = rollback.indexOf('stop_project_containers');
    const quiescent = rollback.indexOf('ensure_data_volume_quiescent');
    const preserve = rollback.indexOf('create_data_archive "$rollback_image" "$failed_cutover_backup_name"');
    const restore = rollback.indexOf('restore_data_archive "$rollback_image" "$backup_path"');
    const startOld = rollback.indexOf('QUIET_ROOM_IMAGE="$previous_image" docker compose');

    expect(stop).toBeGreaterThan(-1);
    expect(quiescent).toBeGreaterThan(stop);
    expect(preserve).toBeGreaterThan(quiescent);
    expect(restore).toBeGreaterThan(preserve);
    expect(startOld).toBeGreaterThan(restore);
    expect(rollback).toContain("rollback_fail_closed 'could-not-preserve-failed-cutover-data'");
    expect(rollback).toContain("rollback_fail_closed 'could-not-restore-predeploy-backup'");
  });

  it('marks the volume for restoration before the new image can start', async () => {
    const source = await readFile(DEPLOY_SCRIPT, 'utf8');
    const cutover = source.slice(source.indexOf('backup_name="data-'));
    const restoreRequired = cutover.indexOf('data_restore_required=1');
    const startNew = cutover.indexOf('QUIET_ROOM_IMAGE="$new_image" docker compose');

    expect(restoreRequired).toBeGreaterThan(-1);
    expect(startNew).toBeGreaterThan(restoreRequired);
    expect(source).toContain('Predeploy backup retained at: %s');
    expect(source).toContain('Failed-cutover data retained at: %s');
  });

  it('pins all deployment probes to the canonical ai.shui.click origin', async () => {
    const [source, localSource] = await Promise.all([
      readFile(DEPLOY_SCRIPT, 'utf8'),
      readFile(LOCAL_DEPLOY_SCRIPT, 'utf8'),
    ]);

    expect(source).toContain('readonly PUBLIC_HOST=ai.shui.click');
    expect(source).toContain('readonly PUBLIC_ORIGIN="https://$PUBLIC_HOST"');
    expect(source).toContain('readonly PUBLIC_WEBSOCKET_URL="wss://$PUBLIC_HOST/ws"');
    expect(source).not.toContain('chat.mijiu.cloud');
    expect(localSource).toContain('https://ai.shui.click');
    expect(localSource).not.toContain('chat.mijiu.cloud');
  });

  it('validates gated traffic before downtime and disables data rollback before reopening traffic', async () => {
    const source = await readFile(DEPLOY_SCRIPT, 'utf8');
    const preflight = source.indexOf('if ! wait_for_public_health 3');
    const cutover = source.indexOf('cutover_started=1\nstop_project_containers');
    const startNew = source.indexOf('data_restore_required=1\nQUIET_ROOM_IMAGE="$new_image"');
    const publicHealth = source.indexOf('wait_for_public_health 10', startNew);
    const publicWebSocket = source.indexOf('wait_for_public_websocket', publicHealth);
    const publishRelease = source.indexOf('ln -sfn "$release_dir" "$APP_ROOT/current"');
    const disableRollback = source.indexOf('data_restore_required=0\ncutover_started=0\ntrap - ERR', publicHealth);
    const openTraffic = source.indexOf('\nopen_business_traffic\n', publishRelease);

    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(cutover);
    expect(publicHealth).toBeGreaterThan(startNew);
    expect(publicWebSocket).toBeGreaterThan(publicHealth);
    expect(source.indexOf('if ! probe_public_maintenance || ! wait_for_public_health 3')).toBeLessThan(cutover);
    expect(disableRollback).toBeGreaterThan(publicHealth);
    expect(publishRelease).toBeGreaterThan(disableRollback);
    expect(openTraffic).toBeGreaterThan(publishRelease);
    expect(publicWebSocket).toBeGreaterThan(openTraffic);
    expect(source).toContain('POST_OPEN_CHECK_FAILED');
    expect(source).toContain('for attempt in $(seq 1 5)');
    expect(source).toContain('let opened=false');
    expect(source).toContain('process.exit(opened?0:3)');
  });

  it('serves the app only on the new origin and keeps ACME bootstrap fail-closed', async () => {
    const [nginx, bootstrap] = await Promise.all([
      readFile(NGINX_CONFIG, 'utf8'),
      readFile(NGINX_BOOTSTRAP_CONFIG, 'utf8'),
    ]);
    const retiredOrigin = nginx.slice(nginx.indexOf('# Keep control of the retired origin'));

    expect(nginx).toContain('server_name ai.shui.click;');
    expect(nginx).toContain('ssl_certificate /etc/letsencrypt/live/ai.shui.click/fullchain.pem;');
    expect(nginx).toContain('server_name ai.shui.click chat.mijiu.cloud;');
    expect(retiredOrigin).toContain('server_name chat.mijiu.cloud;');
    expect(retiredOrigin).toContain('return 308 https://ai.shui.click$request_uri;');
    expect(retiredOrigin).toContain("Content-Security-Policy \"default-src 'none'");
    expect(retiredOrigin).toContain('Referrer-Policy "no-referrer"');
    expect(retiredOrigin).not.toContain('proxy_pass');
    expect(nginx).not.toContain('Access-Control-Allow-Origin');
    expect(nginx).toContain('location = /api/health');
    expect(nginx.match(/if \(-f \/var\/lib\/quiet-room-deploy\/maintenance\) \{ return 503; \}/g)).toHaveLength(3);
    expect(nginx).toContain('limit_conn quiet_room_connections 32;');

    expect(bootstrap).toContain('server_name ai.shui.click;');
    expect(bootstrap).toContain('location ^~ /.well-known/acme-challenge/');
    expect(bootstrap).toContain('return 503;');
    expect(bootstrap).not.toContain('proxy_pass');
  });
});
