# Deployment workflow

The canonical production site is `https://ai.shui.click`. The retired
`https://chat.mijiu.cloud` origin must not serve application JavaScript; the
checked-in Nginx configuration keeps control of it only to return a direct
redirect to the canonical origin. Production deployments are immutable
Git-commit deployments from the private `zdaiwmm/shui-IM` repository. Only
commits contained in `main` are accepted by the server.

WebAuthn credentials, IndexedDB, Service Workers, push subscriptions, and PWA
installations are origin-scoped. A credential created on `chat.mijiu.cloud`
cannot unlock a vault on `ai.shui.click`. Do not weaken this boundary by using
`shui.click` as a parent RP ID, adding permissive CORS, or attempting to copy
vault data through server-side plaintext. A canonical-domain replacement is a
deliberate fresh-origin cutover.

## Normal deployment

For the fixed, non-GUI entry point that preserves an actively edited workspace,
use `node scripts/publish.mjs --sha <full-main-SHA>` after reviewing and merging
the release. It waits for matching CI and runs the checks below in an isolated
clone. See [RELEASING.md](./RELEASING.md) for the operational runbook and actual
lock-screen/host-availability limitations. The direct entry below remains useful
when already operating from a clean release checkout.

1. Work on a feature branch or in a Codex worktree.
2. Open a pull request and wait for the **CI** workflow to pass.
3. Merge the reviewed change into `main`.
4. On a trusted computer with the dedicated production SSH key, update the
   local `main` branch so it matches `origin/main`.
5. Run the fixed isolated publisher with the exact merged SHA:

   ```bash
   npm run deploy:production -- --sha <full-40-character-main-commit>
   ```

   The `--sha` argument replaces only the interactive confirmation; all
   preflight, CI, clone, server and live-SHA checks still run. The direct
   checkout-only implementation remains available as
   `npm run deploy:production:direct` for an explicitly prepared release
   checkout.

After the outer fixed publisher has verified its exact-SHA receipt, run the
independent repository readback as a separate post-cutover step:

```bash
npm run deploy:readback -- --sha <full-40-character-deployed-commit>
```

This command uses the same host/user/key-path configuration but has no GitHub,
CI, deployment-helper, Compose, maintenance-gate, backup, or rollback action.
It reads deployment metadata and container inspection fields over SSH, fetches
only public health and build assets, compares those assets with the running
container, and opens a new public WebSocket. It does not inspect the data volume,
messages, attachments, recovery material, or backup contents. Re-running the
same exact-SHA command is therefore the only supported automatic continuation
after a readback failure; it must never be replaced by another deployment call.
Successful and failed attempts write redacted JSON under the local repository's
Git metadata directory's `quiet-room-readback/` subdirectory (resolved with
`git rev-parse --absolute-git-dir`, including linked worktrees). See `RELEASING.md` for evidence and
failure-state interpretation.

### Fixed release entry point and one-time setup

Use `npm run deploy:doctor` before a release. It checks GitHub code access,
GitHub CI read access, and SSH access to the installed production helper without
changing production. Do not invent another release route when a check fails.

Save machine-specific settings once with the setup command below. The default
location is `~/.config/quiet-room/deploy.json`, so every clone and worktree on
the trusted computer reuses the same settings. A repository-local
`.deploy.local.json` remains a supported override for an isolated environment;
both files contain host/user/key **paths**, never private keys or tokens. The
`QUIET_ROOM_DEPLOY_CONFIG` variable can select another absolute config path.
Environment settings below override JSON values. `githubKey` is optional: the
fixed publisher uses the authenticated GitHub CLI credential for HTTPS clones
when it is absent. SSH host verification stays strict; provision and verify
host fingerprints separately, never disable verification to release.

Run once on each trusted computer (the key file must already exist):

```bash
npm run deploy:setup -- \
  --host <production-host> \
  --user <deploy-user> \
  --server-key /absolute/path/to/production-key
```

The command atomically writes mode `0600` configuration and verifies the key
path. It never copies or prints key contents. Use `--github-key` only when a
dedicated GitHub deploy key is intentionally configured; otherwise run
`gh auth login -h github.com --web --git-protocol https` once and let the
publisher use the OS credential store.

The fixed entry point also requires GitHub CLI (`gh`) with authenticated read
access to this private repository's Actions. Reuse `gh`'s existing login or
supported token environment; do not store tokens in the release config. A Git
SSH key permits pushing code but is not a GitHub Actions API login. Browser
login alone likewise does not authenticate `gh`. Initial CLI installation/login
is a separate setup step, not an action silently performed by deployment.

The direct `release.mjs` entry point requires a clean local `main` matching
`origin/main`; the fixed `publish.mjs` entry point instead uses an isolated
shallow clone. Both paths verify the latest **CI push or manually dispatched run
for that exact main SHA**. That run
must succeed and include a successful **Full application verification** job.
PR CI and a green documentation-only run are insufficient. If the current main
has only documentation checks, manually run the full CI workflow as described
in `RELEASING.md`; the approved SHA must still match main afterward.
It invokes the existing root helper only after those checks, then
reads back the live SHA. The helper retains responsibility for cold backups,
traffic gating, health/WebSocket checks and safe rollback. No root-helper
self-update, firewall change, automatic merge or CI bypass is introduced.

If SSH times out, consult the approved source-IP restriction in `OPERATIONS.md`.
An authenticated Workbench browser session is not a reusable CLI credential.
Do not widen the firewall or extract browser session credentials to make a
release pass. A trusted reachable SSH route must be established separately.
After an ambiguous cutover disconnect, inspect the current SHA, gate and helper
logs before retrying; the script never automatically retries the deployment.

### Fixed GitHub repository workflow

Use the repository commands for routine synchronization. They require the
canonical `origin`, use the authenticated `gh` credential, refuse dirty trees,
fast-forward `main` only, and refuse direct pushes from `main`:

```bash
npm run repo:doctor                 # one read-only check
npm run repo:pull                   # safe fast-forward of local main
npm run repo:push                   # push the current task branch and verify its SHA
```

`repo:pull` stops on local commits or divergent history instead of resetting or
stashing work. `repo:push` requires a non-`main` branch and a clean tree; open
the pull request and wait for the exact main CI result before publishing.

For a reviewed release, keep the approved full SHA visible and use the fixed
isolated publisher followed by the independent readback:

```bash
node scripts/publish.mjs --sha <full-main-sha>
npm run deploy:readback -- --sha <full-deployed-sha>
```

The publisher reads the shared per-user configuration, clones the exact
GitHub `main` into a temporary isolated directory, verifies matching CI, and
does not copy uncommitted files from the current worktree.

Before the first release using the traffic gate, separately install the reviewed
Nginx configuration and root-owned deployment helper. Source synchronization
alone does not update either installed file. The helper creates a persistent,
root-owned marker at `/var/lib/quiet-room-deploy/maintenance`, verifies public
`/api/rooms`, a general API path, and `/ws` all return 503, and verifies the exact
health endpoint remains healthy before it stops any container. A missing or
unreadable gate aborts the release before data changes. Keep the marker directory
mode 0755 so Nginx can stat it; it contains no credentials.

Alternatively configure these environment variables; host, user, and private-key
paths are not embedded in tracked repository files:

```bash
export QUIET_ROOM_SERVER_HOST='your-production-host'
export QUIET_ROOM_SERVER_USER='your-deploy-user'
export QUIET_ROOM_SERVER_KEY='/path/to/production-key'
export QUIET_ROOM_GITHUB_KEY='/path/to/read-only-github-key'
npm run deploy:production
```

## Optional voice/video calling in production

Production STUN/TURN configuration and the coturn overlay are enabled by an
administrator-owned persistent file: `/opt/quiet-room/shared/calls.env`. Its
absence leaves the base Compose deployment unchanged. The new application still
offers direct WebRTC calls when both devices advertise support; absent STUN/TURN
configuration does not disable that entry point or guarantee cross-network calls. Once present, the updated deployment helper always includes
`compose.calls.yaml`, the `calls` profile, and this second environment file for
the application and TURN service. The local release command and exact-SHA
confirmation stay the same; do not pass a one-off Compose flag from a laptop.

The old helper uses only `compose.yaml` and `--remove-orphans`; it would remove a
TURN service started manually in the same Compose project and omit the call
settings on the next release. Install the reviewed root-owned helper using the
separate procedure below **before** enabling calling. A normal application
release does not install or replace that privileged helper.

Prepare the following as a separate, reviewed administrator operation:

1. Start from `.env.calls.example`, replace every placeholder and select a
   reviewed `coturn/coturn` image digest for repeatable production releases. Use the same random `TURN_SECRET`
   for the application and TURN. Keep all other settings in `production.env`;
   `calls.env` is passed after it and should contain only calling settings.
2. Set `TURN_TLS_DIR=/opt/quiet-room/shared/turn-tls`, even if TLS is initially
   disabled, and prepare that persistent directory. If `TURN_TLS_ENABLED=true`,
   provide readable `fullchain.pem` and `privkey.pem` there. A path inside an
   immutable release is unsuitable: a later release or pruning can lose it.
3. Verify TURN DNS/public IPv4 routing, 3478 UDP/TCP and the configured relay UDP
   range in both firewalls. If using TLS, also verify 5349/TCP and the certificate
   hostname. The example deliberately leaves website HTTPS port 443 available.
   The shared TLS key must be readable by the selected TURN image's runtime UID
   while remaining inaccessible to unrelated users.
4. Install the completed settings as a regular, non-symlink file owned by
   `root:root` with mode `0600` at `/opt/quiet-room/shared/calls.env`. Never commit
   this file, put secrets in command arguments, or print `docker compose config`
   without `--quiet`. Ensure the shared directory is not writable by the deploy
   user. No shell script sources the environment file.
5. Deploy the reviewed application commit using the existing command:

   ```bash
   npm run deploy:production -- --sha <full-40-character-main-commit>
   ```

Before closing the business-traffic gate, the helper validates both new and
rollback Compose graphs with `config --quiet`, downloads the configured TURN
image, and refuses missing overlays or unsafe/missing calling settings. After a
successful cutover it records the enabled state in
`/opt/quiet-room/deploy-state/calls-enabled`. Normal later releases therefore
retain the overlay, credentials source and profile without extra local flags.
An unexpectedly missing `calls.env` aborts before downtime if that state or an
existing TURN container indicates calling was enabled; it does not silently
remove TURN. An intentional disable is a separate operator change to reconcile
the TURN container, persistent settings and marker under the deployment lock,
not deletion of the credentials file before a routine release.

Calling uses the same Compose project as chat. Deployments stop both services,
so active calls end; there is no promise to preserve calls across a release.
Rollback preserves the previous calling mode. On the first enable, if the
previous release was chat-only, a failed cutover restores chat-only service.
After calling was previously enabled, rollback requires the previous release's
calling overlay and retains it. The TURN image setting, runtime credentials and certificates are
shared operator configuration and are not rolled back with a Git commit; do not
combine secret rotation or certificate changes with an application cutover.

These preparations do not prove real media connectivity. The existing release
health checks cover HTTP/WebSocket service health, and Compose validation only
checks configuration structure. Before treating calling as production-ready,
verify the TURN container remains running, obtain authenticated call config
without exposing its credentials, and complete a forced-relay call between the
two intended devices on different networks. Include a long call and a network
switch. The local development environment used for this change has no Docker,
so the checked-in TURN image/configuration still needs this server-side check.
See `CALLS.md` for application behavior and the call acceptance checklist.

## First-time `ai.shui.click` provisioning

The canonical origin must be healthy before installing a deployment helper
that probes it. Perform this one-time infrastructure cutover before the normal
application deployment:

1. Confirm the `ai.shui.click` A record resolves to the production IPv4 address
   and that public TCP ports 80 and 443 are allowed.
2. Inspect the actual Nginx include and enabled-site paths with `nginx -T`.
   Back up the currently loaded site file under
   `/opt/quiet-room/deploy-state/nginx-backups/` before changing it.
3. Install `deploy/nginx-ai.shui.click-bootstrap.conf` as a temporary enabled
   HTTP-only vhost. It may coexist with the old full vhost because it defines no
   shared rate-limit zones. Create the ACME webroot and test it from an external
   network:

   ```bash
   sudo install -d -o root -g root -m 0755 \
     /var/lib/letsencrypt/.well-known/acme-challenge
   sudo nginx -t
   sudo systemctl reload nginx
   ```

4. Issue a separate certificate lineage. Do not expand or overwrite the old
   certificate, because keeping independent lineages makes rollback possible:

   ```bash
   sudo certbot certonly \
     --webroot \
     --webroot-path /var/lib/letsencrypt \
     --cert-name ai.shui.click \
     -d ai.shui.click
   sudo openssl x509 \
     -in /etc/letsencrypt/live/ai.shui.click/fullchain.pem \
     -noout -subject -issuer -dates -ext subjectAltName
   ```

5. In one change, disable the bootstrap and old full site, then enable
   `deploy/nginx-ai.shui.click.conf`. The old and new full configs both define
   the same named rate-limit zones and must never be loaded together. Run
   `nginx -t` before reload; restore the backup without reloading if validation
   fails.
6. Before deploying new application code, verify that the currently running
   image is already reachable through the new reverse proxy:

   ```bash
   curl --fail --silent --show-error \
     --connect-timeout 5 --max-time 10 \
     https://ai.shui.click/api/health
   ```

   Also complete a real WebSocket upgrade with URL
   `wss://ai.shui.click/ws` and `Origin: https://ai.shui.click`.
7. Install the reviewed root-owned `deploy/server/quiet-room-deploy` helper by
   the separate atomic process below, then run the normal application
   deployment. Its pre-cutover probe deliberately refuses downtime if the new
   DNS/TLS/reverse-proxy path is unavailable.
8. After the release, verify certificate renewal without changing live
   certificates:

   ```bash
   sudo certbot renew --dry-run
   sudo systemctl list-timers --all | grep -i certbot
   ```

The final Nginx configuration sends the retired origin to the canonical origin
without serving the old app. Continue controlling the old DNS name and its TLS
certificate so it cannot become a dangling, takeover-prone origin. Do not send
`Clear-Site-Data`; old local vault destruction is unnecessary for the cutover.

GitHub runs the locked dependency install, production build, unit/integration
tests, two independent browser-test groups, call browser tests, credential scan
and production dependency audit in the **CI** workflow. Independent jobs run in
parallel and the final `verify` job requires every expected result. Only changes
limited to the explicit documentation allowlist use the lightweight document
and credential checks; unknown paths, uncertain comparisons and manual runs
require full verification. GitHub has no production SSH
private key and no login or root capability on the Alibaba Cloud server. Passing
CI does not publish automatically.

## Upgrading the root-owned deployment helper

Pushing this repository does not replace `/usr/local/sbin/quiet-room-deploy` on
the production host. When this helper itself changes, install the reviewed file
before using it for the next application cutover; otherwise that first cutover
still runs the old rollback behavior.

Stage the helper from the exact reviewed commit in a private directory owned by
the SSH administrator. Compare its SHA-256 digest with the trusted local copy,
run `bash -n` on the staged file, then use `sudo install` to create a root-owned
temporary file alongside the destination and `sudo mv` it atomically into
place. Finally run `sudo bash -n /usr/local/sbin/quiet-room-deploy` and compare
the installed SHA-256 digest again. The installed file must be owned by
`root:root`, must not be writable by the deploy user, and should remain mode
`0755` (or a stricter executable mode compatible with the sudo policy). Keep
the existing helper untouched until every staging check passes.

Do not make normal application deployments self-update this root-owned helper.
Keeping helper installation as a separate, explicit privileged operation
preserves the current sudo boundary and prevents an unreviewed application
commit from replacing root-executed deployment logic. A future repository
installer would only be appropriate if it pins a commit and digest, stages on
the same filesystem, validates syntax/ownership, and performs an atomic rename;
the normal `deploy:production` command must not become that installer.

The local command connects directly as `admin` with the dedicated
`id_ed25519_shui_im_server` key and invokes the root-owned deployment program.
The server independently verifies that the requested 40-character commit is
contained in `origin/main`, serializes deployments with a file lock, builds an
image before downtime begins, takes a cold ciphertext-data backup, switches the
Compose project, checks local and public health, verifies the public WebSocket
upgrade, and performs a data-aware rollback only while public business traffic
remains gated. The marker is installed before old containers stop; stopping them
closes existing WebSockets before the cold backup. New HTTP business traffic
and WebSocket upgrades receive 503 throughout startup validation. The exact
health endpoint remains available, and an internal WebSocket probe checks the
new application while public traffic is blocked.

A rollback first stops every new project container, preserves possible schema
migrations in a separate `failed-cutover-*.tar.gz` archive, restores the verified
predeploy cold archive, and only then starts the previous image. The gate stays
closed until the restored service and public health route pass checks. Because
no client can receive new message ACKs during this validation window, restoring
the archive does not retract an acknowledged cutover-window message.

After all gated checks pass, the helper disables automatic database rollback
**before** publishing release metadata and opening traffic. The final public WSS
check then runs against the open service. If that check fails, the helper exits
with `POST_OPEN_CHECK_FAILED` and retains the current database; investigate the
route or roll application code forward without restoring an older data snapshot.
Once traffic has opened, new accepted messages must remain in the live database. The paths of both archives are printed
in the deployment log. Before every cold archive or restore, the helper also
fails if any running container still has the named data volume mounted; it does
not assume that stopping only the expected Compose services made the volume
quiescent.

Archive creation and restore are fail-closed. A cold archive is written to a
temporary filename, checked as a readable gzip/tar stream, and atomically moved
into place before the new image is allowed to start. If the new containers
cannot be stopped, failed-cutover data cannot be preserved, the predeploy
archive cannot be restored, or the previous release does not become healthy,
the helper leaves the application stopped and prints `ROLLBACK_FAILED` instead
of starting an old image against uncertain data. Preserve both archive paths
from that output for manual recovery; `ROLLBACK_OK` still exits non-zero with
the original deployment failure so automation cannot mistake a rollback for a
successful release.

The server has a separate, read-only GitHub Deploy Key scoped only to this
repository. It can fetch release source but cannot push to GitHub. Neither that
key nor the local production key is committed to this repository.

## Adding another trusted computer

Do not copy either private key between computers. Generate a new GitHub SSH key
and a new Alibaba Cloud production SSH key on the additional computer, add only
their public keys to the corresponding destinations, and configure the local
repository to use them. Each trusted computer can then run the same command:

```bash
npm run deploy:production -- --sha <full-40-character-main-commit>
```

Revoking one computer therefore does not affect the others. Remove its GitHub
account key and its public key from the server when the computer is retired or
lost.

## Server layout

```text
/opt/quiet-room/
├── repository.git/          # private bare mirror, owned by deploy
├── git-releases/            # detached immutable worktrees
├── current -> git-releases/…
├── shared/production.env    # production-only settings, never committed
├── shared/calls.env         # optional root:root 0600 calling settings
├── shared/turn-tls/         # persistent optional TURN certificate/key
├── deploy-state/            # current commit and deployment time
└── backups/
    ├── predeploy/            # cold backup before each cutover
    └── continuous/           # verified online backup snapshots
```

The existing named volume `quiet-room_quiet-room-data` remains the production
data source. Neither a Git checkout nor an image rebuild contains message data.

The deployment helper prunes only the oldest known Git worktrees
and `data-*.tar.gz` pre-deployment archives after a successful cutover, keeping
five releases and fourteen rollback archives by default. Continuous/off-host
backups and the active `current` release are never touched. Override the
positive-integer retention counts with `QUIET_ROOM_RELEASE_RETENTION_COUNT` or
`QUIET_ROOM_PREDEPLOY_BACKUP_RETENTION_COUNT` in the server environment; keep
at least one rollback point and monitor disk capacity separately.
`failed-cutover-*.tar.gz` archives are deliberately excluded from automatic
retention because they may contain writes accepted during a failed release.
After an operator reconciles or explicitly discards that data, remove the
archive manually under the same change-control process used for production
data deletion.

## 可选会话管理后台（admin.mijiu.cloud）

应用默认不开启后台。自动加密备份不依赖管理员登录，后台管理会话/设备/备份元数据、清理会话和公开表情资源库，不能获取恢复码或解密聊天内容。功能和风险边界见 [RECOVERY_BACKUPS.md](./RECOVERY_BACKUPS.md) 与 [MEMES.md](./MEMES.md)。新资源库初始为空，需先启用后台并上架资源。手动上传要求安装新版后台 Nginx 配置，仅精确资源入口允许 12 MiB 请求体，其他后台入口保持 64 KiB。本段是部署准备说明，不是发布授权或已安装记录。

1. 在受信任的交互终端运行 `node scripts/admin-setup.mjs --out /secure/path/admin.json`。输入至少 16 字符的管理员密码两次，扫描 Google Authenticator 二维码并验证动态码。脚本拒绝覆盖已有文件，以 0600 权限创建配置。不要把二维码、密码、种子或生成的 JSON 提交、记录到工单或终端日志。
2. 在服务器保护目录放置配置，例如 `/opt/quiet-room/shared/admin.json`。运行时应用为 Node 镜像的 `node` 用户（默认 UID/GID 1000，部署前核实），配置须可由该 UID 读取且为 0600；目录由 root 管理且不可被普通用户写入。容器通过单文件只读 bind mount 获取它，备份容器不挂载该文件。不要将它放在 `/app/data`、Git release 目录或公开静态目录内。
3. 将仅含 `QUIET_ROOM_ADMIN_CONFIG=/opt/quiet-room/shared/admin.json` 的管理员环境文件放到 `/opt/quiet-room/shared/admin.env`，root:root、0600；本例路径需与实际受限配置相符。不要在该文件中放恢复码或用户秘密。它与 `production.env`、可选 `calls.env` 分开，由 Compose 解析，不作为 shell 脚本执行。
4. 为精确域名 `admin.mijiu.cloud` 配置 DNS、可信证书及经过验证的自动续期。按既有独立特权安装流程部署 `deploy/nginx-admin.mijiu.cloud.conf` 并检查 Nginx。后台所有路径须受同一 `/var/lib/quiet-room-deploy/maintenance` 标记保护，且该域名不能开放应用 `/ws`。它不改变 `ai.shui.click` 的 WebAuthn RP ID、来源或本机数据位置。
5. 独立审查并安装当前 `deploy/server/quiet-room-deploy`。持久 `admin.env` 存在时，它自动合并 `compose.admin.yaml`，将管理员配置只读挂载至 `/run/quiet-room-admin.json`。已启用状态记录到 `deploy-state/admin-enabled`，后续版本及回滚都保留该覆盖。已启用而缺配置、配置权限不安全或缺新/旧覆盖时，停机前拒绝发布。首次启用失败可回滚到原本无后台的版本。
6. 正式启用依旧必须先合并、明确完整目标提交和用户发布授权，再运行 `RELEASING.md` 的固定入口。部署前验证 Compose 配置，禁止打印已解析的秘密。维护门实际探测包括 `https://admin.mijiu.cloud/admin-api/rooms` 必须返回 503；缺 DNS/TLS/代理门时拒绝切换。上线后单独验收 HTTPS 登录、TOTP、元数据、退出、来源隔离及配置挂载权限。

管理员 JSON 不随数据卷冷备份回滚；常规升级不会重新生成密码或验证器。更换管理员配置须通过受信任主机维护，重启进程使现有管理会话失效。先保管好独立的验证器应急副本；忘记管理员因素只能在主机上重新设置管理员，不构成用户聊天恢复途径。不要通过删除 `admin.env` 临时停用已启用的后台；有意停用需在独立维护中关闭 vhost、移除覆盖并同步状态，正常发布遇到文件意外丢失将失败关闭。
