# Production operations

This service can preserve confidentiality when storage is disclosed, but availability and recovery still depend on ordinary operations. A backup that has never been restored is not a recovery plan.

## Capacity governance

The bounded host tool `deploy/server/quiet-room-capacity` exposes `preflight`,
`check`, and `cleanup`. Install it separately as root from a reviewed commit;
normal application deployment must not self-update privileged tools. See
[the governance requirement](docs/requirements/2026-09-22-capacity-governance/README.md).

- Preflight refuses deployments at 90% disk use or 80% inode use, below 400 MiB available
  memory, or below the larger of 4 GiB and twice the largest retained cold
  archive plus 2 GiB emergency reserve. This is a conservative estimate, not an
  upper bound on data/build growth. It runs before fetch/build and again before
  closing business traffic.
- The five-minute capacity timer records redacted metrics and issue codes in
  `/var/lib/quiet-room-deploy/capacity-status.json` and the system journal.
  Disk warning starts at 75%, urgent at 90%; local backup age is 36 hours,
  offsite verified receipt age 24 hours. A failed unit/local log is not proof
  that a person received a notification; external alert routing is separate.
- The daily retention timer shares the deployment lock. It keeps current plus
  two distinct successful application versions, every container image reference,
  and all image prefixes associated with failed-cutover archives. A missing or
  malformed root-owned successful-release registry blocks cleanup. Bootstrap
  that registry only from independently verified deployment records.
- Only exact project SHA image tags and registered successful release worktrees
  are removed. No force removal, volume pruning, live-data cleanup or continuous
  snapshot deletion is performed. Keep the latest three predeploy archives plus
  any archive paired with a failed cutover; failed/special archives require a
  separate case closure and verified offsite retention before deletion.
- Online backup can continue because cleanup never touches its source/target.
  Daily cleanup is serialized with deployment; the online backup worker's
  three-date verified snapshot policy is described below; offsite recovery remains separate.
  Before each online snapshot the worker checks destination free space (8 GiB),
  utilization (below 80%) and inodes (below 80%). Refusal leaves existing
  snapshots untouched and retries later; the stale-backup alert remains active.
  This admission floor is not a bound on arbitrarily growing snapshot sizes.
- Do not run automated `docker system df`, global prune, or builder prune on
  this 2 GiB host. A filtered builder prune caused management/public timeouts
  during this incident. Cache growth must hit the capacity gate rather than
  trigger another heavy cleanup. Builds now move to CI. On 2026-10-12, even
  stopped-container, supervised builder pruning caused host unresponsiveness;
  this method is disabled on the current production host.
- Checked-in journal and nginx rotation settings cap journal at 300 MiB/7 days
  and rotate nginx daily or at 20 MiB with seven files. Container logs rotate at
  10 MiB with three files per container after controlled recreation. Never
  remove open log files directly; preserve needed incident evidence first.

Install the service/timer files only after checks pass. Root helper, journal,
nginx rotation and Compose changes have separate activation/verification steps.
The source files alone do not mean production policy is enabled. Current disk
capacity must be measured after cleanup and a full readback must verify service
recovery; 40 GiB cannot support unlimited business-data growth.

<a id="supervised-build-cache-maintenance"></a>

## Build cache maintenance disabled after incident

The current production host must not run the previous supervised prune protocol
again. The 2026-10-12 attempt stopped the original containers but never returned
a completion receipt; SSH and public health became unresponsive. After explicit
user authorization for rescue and necessary restart, a normal cloud restart
resolved the old daemon execution. The original containers, images and
`05e868086454192e7f06f52c63f812df1b5d84a3` were restored. Independent readback
passed at `2026-10-12T09:55:40.229Z`. No new application version was published.

The cache helper is retained with its reviewed digest but mode `0644`.
The root-owned `/var/lib/quiet-room-deploy/cache-maintenance-disabled.json`
records the incident. A helper upgrade must preserve that record and must not
automatically re-enable this method. The helper rejects both plan and apply
when that path exists, including malformed or dangling-link state. Do not
clear it as routine cleanup. Daily retention and capacity/log timers remain
separate and enabled.

Historical cache reclamation remains incomplete: after recovery and two clean
release removals, available space was `3906973696` bytes (90.22% used). This
still fails deployment headroom. The previous kernel and Docker journals did
not establish an OOM or disk-error cause; high disk reads in cloud monitoring
are evidence of pressure, not proof of its cause. Do not promise that the
sampled 20.6 GiB of old layers can simply be deleted.

Any replacement strategy must first preserve and verify the live data volume,
TURN state, current and rollback images, and source/configuration outside Docker.
Reinitializing Docker storage or relocating business volumes requires a new
reviewed plan and explicit maintenance authorization. Never delete individual
Docker layer directories or use global/volume prune. See the
[incident and remaining work](docs/requirements/2026-10-12-ci-image-environments/README.md#维护事故恢复与剩余事项).

`deploy/server/quiet-room-cache-maintenance` is a separately reviewed root tool,
never a timer or an application-release hook. Install it atomically from the
exact reviewed commit, verifying its digest, Python 3.6 syntax and root ownership,
using the same staging procedure as the deployment helper. Never delete Docker
layer directories directly or replace this with a global/volume prune.

Killing a prune client does not prove the daemon stopped. Never blindly retry.
Retained dirty release trees
are reported as `CLEANUP_PARTIAL`; other clean eligible trees are still processed.
That partial result is visible locally and is not proof an external alert arrived.

## Verified Docker storage replacement

`deploy/server/quiet-room-storage-maintenance` is a separate privileged maintenance
tool, activated only after explicit approval of this replacement strategy and
the exact source's CI. It is never called by an application deployment or timer.
The 2026-10-12 user approval covers recovery verification, a new maintenance
window, restoration of the unchanged application, independent readback, and only
then retirement of the verified obsolete Docker root. This is not authorization
to publish a new application SHA or to repeat builder prune.

Preparation exports all protected images, restores a retained cold backup and
checks SQLite with the original image, and independently imports the images into
a temporary memory-limited Docker daemon with its own containerd, storage roots,
state directories and short sockets under `/run`. It verifies original digest associations and creation of
the original runtime configuration without starting those trial containers.
Data and image rehearsals are sequential. Image streaming and post-stream
unpacking share one 600-second deadline; completion uses the remaining time.
Disk budgets must pass before downtime.
The private session directory is root-only; `runtime.json` contains credentials
and must never be printed, downloaded into a source tree, or uploaded as evidence.
Public plans and status contain only identifiers and fingerprints.

For the supported classic overlay2 store, preparation captures the native
`image/overlay2/repositories.json` mapping only after every entry matches the
original Docker API references and image IDs. The mapping and its hash are bound
to the private snapshot and public plan. Each fresh, empty replacement root is
seeded before its daemon starts; existing or active roots fail closed. After
archive import, Docker must resolve every original tag and digest to its original
image ID. Preparation and replacement use these captured references offline,
avoiding a registry dependency during recovery. This is an image reference index;
business volume directories still move only at the verified transaction boundary.

The prepared plan binds the host, current release, image references, all volume
directory identities, networks, runtime/configuration fingerprints and tool
digest. Within 15 minutes, apply requires the identical reviewed plan bytes and
checksum plus `--maintenance-window`. Durable systemd workers record each phase;
disconnecting a client does not restart or cancel a transaction. Use `status` to
inspect the existing session, not another apply.

A blocked online preparation has no applicable plan. Inspect its recorded phase,
private worker state and the original service before preparing again. A verified
duplicate image export may be removed under the deployment lock only after all
original protected references are confirmed intact and its identity/checksum are
recorded. Retain the failed session audit and canonical business cold backups.

During the window the traffic gate closes, every original container stops, and
fresh cold archives are restored and checked against every source file before
the old daemon is stopped. The old Docker root is retained under its recorded
identity. A fresh root imports the exact images, recreates preserved networks
and volume metadata, and atomically receives the original volume directories.
Directory identity and complete contents are checked; no old database is
substituted. Containers are recreated from the original private runtime
configuration and mount names, including TURN's original state volume.

Before public traffic opens, failures can move those same original directories
back to the retained root and recover the original service. After the opening
boundary is persisted, automatic data rollback is forbidden. `recover` is only
for the pre-open case; `finish-opening` can complete a validated opening without
restoring data. Failure retains evidence and requires inspection; never blindly
repeat the replacement.

Run the fixed independent production readback for the unchanged SHA. Only its
fresh, complete success receipt can authorize legacy retirement. The helper
then rechecks every protected image, original volume identity and runtime,
requires no remaining data directory or mount in the retired root, and removes
that whole verified obsolete root with memory/CPU limits and paced operations.
It checks public health during removal and stops on uncertainty. A partial
retirement resumes only after another fresh independent readback; it never
repeats replacement or restores an older database. Current volume contents,
continuous backups and canonical cold archives remain protected. Only the
duplicate image export is removed after completion; private case records remain
root-only. The resulting free space must be measured, not inferred from image
sizes. The immutable source and regression boundaries live with
[the confirmed requirement](docs/requirements/2026-10-12-ci-image-environments/README.md#重新确认的存储重建方案).

## Backup policy

Administrator status projection (2026-10-25): the backup worker publishes a small allowlisted receipt every 30 seconds to a separate named status volume; the application mounts only this volume read-only. The projection includes sampling time, verified/snapshot/attempt times, attempt result and local/Mac mode, never backup paths or files. The admin reader bounds it to 4 KiB and rejects samples older than 120 seconds or in the future; the original 36-hour backup health check remains authoritative for freshness. Publication failure does not change snapshot/retention or initiate a backup. A current sample is not a restore drill, a new checksum scan, or proof that clients uploaded their latest history.

The included backup worker uses SQLite's online backup API against the live WAL database, removes incomplete attachment reservations from the snapshot, copies only completed immutable ciphertext chunks, verifies SQLite with `PRAGMA quick_check`, and writes SHA-256 checksums for the database and every chunk. It stages into a partial directory and publishes the backup by atomic rename only after verification.

Compose runs that worker once at startup and then every 24 hours by default. It retains the latest verified snapshot for each of three distinct UTC dates by default (minimum two). Invalid/unknown points are retained for investigation. Configure `QUIET_ROOM_BACKUP_DIR` as a mount whose data is replicated to a different failure domain. A second directory on the same disk is not disaster recovery.

Unchanged completed attachment chunks may share inodes **between backup points only**, after checking actual bytes; live chunks and restored files never share those inodes. Databases stay independent. Creation, verification and retention share a process lock, and failed creation removes its own staging directory. Older interrupted directories require a separate reviewed inventory. This reduces duplicate attachment space but does not protect against shared-block corruption or disk loss. See the [storage contract](docs/requirements/2026-09-24-storage-calls/storage-contract.md) for migration, online-message windows and cache limits.

The public expression catalog stores its original images and publication state in the same SQLite database,
so online snapshots and restore include it. Public catalog bytes are separate from encrypted chat attachments.
Interrupted acquisition jobs remain interrupted after restart and require a new explicit administrator action.

Recommended minimum production policy:

- RPO: 24 hours or less; reduce `BACKUP_INTERVAL_MS` if that loss window is unacceptable.
- Retention: three distinct daily recovery points, plus separately configured offsite lifecycle copies if required.
- Off-host copy: encrypted storage in another account/project or region, with versioning and deletion protection.
- Access: the application can read the live data volume; the backup worker mounts it read-only. Backup operators should not have application deployment privileges unless necessary.
- Alerting: alert if no `backup_verified` event is recorded within 1.5 backup intervals, if the target is nearly full, or if off-host replication lags.

The worker now atomically records `.backup-state.json` with the last verified
snapshot creation time and last attempt result. Compose probes
`scripts/backup-health.mjs` every five minutes; missing, invalid, future, stale
state or a failed latest attempt is unhealthy. `BACKUP_MAX_AGE_MS` defaults to
36 hours. This reports the worker's verification evidence, not a fresh checksum
scan on every probe or actual delivery of an external alert. Successful cycles
are scheduled from their start time; failures wait up to five minutes after
completion. A 24-hour schedule plus generation/export delay does not prove a
24-hour RPO; measure the end-to-end age and shorten intervals accordingly.

Manual commands:

```bash
DATA_DIR=/srv/quiet-room/data BACKUP_DIR=/mnt/offsite/quiet-room npm run backup:create
npm run backup:verify -- /mnt/offsite/quiet-room/quiet-room-2026-09-03T00-00-00-000Z
npm run backup:restore -- /mnt/offsite/quiet-room/quiet-room-2026-09-03T00-00-00-000Z /srv/quiet-room/restore-drill
```

The manual `backup:create` entry checks target capacity before snapshot work, using the existing strict policy by default. It rejects unknown statistics, utilization/inode pressure at the strict threshold, or less than 8 GiB free. An operator may explicitly select the existing `BACKUP_CAPACITY_POLICY=reserve` policy on a busy disk; the free-byte/inode floor remains enforced. This is admission, not a reservation or a guarantee against space being consumed during copying.

Manual backups retain **all** existing snapshots by default. A stderr notice and the additive JSON `retention`/`capacityPolicy` fields make this explicit; the existing snapshot result fields remain available. To opt into the existing verified daily retention, use `npm run backup:create -- --retain-days 3`: keep the newest verified point for each of three distinct UTC dates, minimum two dates. This can remove earlier same-day points as well as older dates. Automatic worker retention is unchanged. New snapshot creation and verification must succeed before pruning under the existing lock; failure retains old recovery points. Unknown or invalid snapshots remain for investigation. No automatic deletion policy is added for manual callers who omit the flag.

`npm run test:restore-drill` uses entirely synthetic data and isolated temporary directories. The manual backup entry performs its actual policy against a controlled capacity fixture; real SQLite/WAL, ciphertext chunks, checksums, restore, HTTP health, two-party MLS and original-byte decryption still execute. Output includes per-stage/total timing and the fixture label. These measurements are not production RTO, real-disk admission evidence, an external alert receipt or immutable-storage proof. External destinations and notification routing are deferred by the user's [V1 scope decision](docs/requirements/2026-10-27-audit-backup-safety/README.md).

`backup:restore` refuses a non-empty destination. Restore into an isolated path, start an isolated server against it, verify `/api/health`, room/member/message counts, completed attachments, and a synthetic two-device decrypt flow, then record measured RTO. Do this at least monthly and before changing SQLite, filesystem, container, or backup versions.

Checksums detect accidental or partial corruption, but a manifest stored beside the backup is not a signature against an attacker who can rewrite both. Use immutable/versioned off-host storage and independent access logs for that threat.

## Privacy-preserving background notifications

Generate a VAPID key pair once:

```bash
npm run push:keys
```

Store `VAPID_PRIVATE_KEY` in the deployment secret manager, configure a real security contact in `VAPID_SUBJECT`, and expose only the public key to the client. Rotating the VAPID key invalidates existing subscriptions, so users must enable notifications again.

The server sends a Web Push request with no payload and excludes the sending device. The service worker creates a local notification only after the push arrives, using the device’s saved fixed title/body or generic defaults. Custom copy is stored only in that browser’s durable cache and never sent to the server or provider. Worker upgrades preserve both the copy and master gate; clearing site data removes them. Accepted non-chat sync frames (`countUnread=false`) and presence transitions do not trigger chat wakes; real countable messages and browser-access requests retain their existing paths. The push provider can still observe the subscription endpoint, source service, timing, and traffic volume; it does not receive room ID, device ID, sender, message kind, text, attachment metadata, or unread count from the notification request.

Push subscriptions are accepted only for the provider hosts in
`PUSH_ALLOWED_HOSTS` (the Compose default covers FCM, Mozilla, Apple, and
Windows endpoints). Keep this allowlist explicit when adding a provider. At
wake time the server requires HTTPS, resolves every address, and rejects
loopback, private, link-local, reserved, multicast, and other non-public
targets. This is defense in depth; production egress should also be restricted
with a firewall or outbound proxy.

Permission is requested only after the user explicitly enables the device-wide master control in Settings → 本机 → 通知管理. This page manages all locally joined spaces; per-space opt-out keeps the shared browser subscription, and master opt-out preserves space preferences while unsubscribing the browser. There is no test-notification action. A push is only a wake-up hint: it is not a delivery receipt, does not unlock the vault, and must never promote a message to “delivered.” iOS requires an installed home-screen web app for Web Push.

## Release and incident basics

The fixed independent post-release verification command is
`npm run deploy:readback -- --sha <full-deployed-SHA>`. Its output separates
phase timing from stable failure classes and saves a redacted local receipt under
`quiet-room-readback/` inside the current worktree's Git metadata directory
(resolved with `git rev-parse --absolute-git-dir`). A `READBACK_BLOCKED` result means that production
verification is incomplete, not that the application was rolled back or that a
new cutover is authorized. Repeat only this read-only command for the same SHA
after resolving connectivity or probe conditions. If its state fields reveal a
different SHA, a remaining maintenance marker, stopped/unhealthy containers, or
an image mismatch, keep `PRODUCTION_STATE_UNRESOLVED` until the actual state is
understood; do not blindly redeploy. A successful `READBACK_OK` still does not
close certificate, off-site backup, alerting, device-validation, or independent
security-audit requirements.

- Serve only through HTTPS with HSTS. Preserve `/ws` upgrades and cap bodies slightly above the encrypted 2 MiB chunk size.
- Treat `ai.shui.click` DNS control, its exact WebAuthn RP ID, and automatic TLS renewal as key-material-grade dependencies. Alert before certificate expiry, and never replace the exact-origin checks with a parent-domain RP ID or wildcard cross-origin access.
- Keep the retired `chat.mijiu.cloud` hostname controlled but do not serve application JavaScript from it. Its redirect/retirement vhost and certificate are part of the origin-takeover defense, not an application compatibility promise.
- Do not add analytics, tag managers, remote fonts/scripts, session replay, or plaintext error reporting.
- Pin dependencies with `package-lock.json`, run `npm ci`, `npm run check:full`, dependency review, container scanning, and an isolated restore drill before release.
- Retain minimal reverse-proxy logs. Never log authorization headers, URLs containing invite fragments, WebSocket frames, request bodies, push endpoints, or recovery data.
- If a reverse proxy is used, configure `TRUSTED_PROXY_ADDRESSES` with its exact
  source addresses. Only then will the application use the first
  `X-Forwarded-For` address for its own rate-limit buckets; untrusted forwarding
  headers are ignored.
- Treat a client release compromise as a key-compromise incident. Stop serving the release, preserve forensic artifacts, notify users out of band, and require creation of new rooms from a clean signed release.
- Legacy rooms use the original static-recipient envelope and do not gain forward secrecy automatically. Legacy-room migration has been retired. Existing rooms, encrypted records and recovery capabilities are retained; no automatic conversion or deletion runs. See `CHAMBER_IDENTITY.md`.

See [PRODUCTION_SECURITY_GATE.md](./PRODUCTION_SECURITY_GATE.md) for the conditions that must be met before marketing or operating the service as high-security.

### Production cutover: 2026-09-04

- Application commit `5ad2864832f8a159342a8d83f08882be045e5afd` was deployed successfully at 07:56 CST. The public application origin is now `https://ai.shui.click`; the retired origin returns a no-script 308 redirect.
- The deployment helper verified a cold data archive before replacing containers. The cloud system-disk snapshot `pre-recovery-20260904-0231` also completed before the ordinary server restart. Neither is a substitute for independent off-host backups.
- **Certificate renewal is not automated yet.** HTTP-01 validation failed at the CA (first a secondary DNS SERVFAIL, then HTTP 403 despite local/public preflight access). The new certificate was issued using manual DNS-01 validation. Its expiry is **2026-12-02 22:54:18 UTC**. Renew well before that date; target a maintenance window by **2026-11-02**. The temporary `_acme-challenge.ai` TXT record was removed after successful issuance.
- Unattended renewal requires a tested, least-privilege DNS authentication hook, or a separately verified working HTTP-01 renewal configuration. Do not assume the existing Certbot timer can renew this manual certificate. Do not store broad Alibaba Cloud account credentials in the repository or weaken TLS/origin checks to work around renewal.
- Ordinary restart restored system responsiveness. Nginx initially failed with port-binding conflicts while Certbot also attempted startup; `nginx -t` passed and starting Nginx after that activity restored service. Review startup ordering before the next planned reboot. Failures for other hosted domains' renewal jobs were observed but their configurations were not changed.
- Public SSH remained unavailable from the operator after the cloud firewall was restricted to the approved single address. The release used authenticated Alibaba Cloud Workbench access. Do not reopen SSH globally without a deliberate access-control decision.
- Post-release checks confirmed the exact running commit, healthy application/backup containers, trusted TLS for the exact hostname, HTTP 200 health/home/service-worker responses, service-worker cache version `quiet-room-shell-v4`, and a real WSS upgrade. Foreign-origin WSS requests are rejected by destroying the upstream socket; Nginx consequently reports 502 rather than an application 403. These smoke checks do not replace on-device biometric or multi-device business regression testing.


## Prepared operational automation (2026-09-04)

The repository now includes `quiet-room-backup-export`,
`quiet-room-check-operations`, a Certbot deploy hook, and systemd service/timer
files under `deploy/`. They have local syntax and behavioral coverage. **They
are not automatically installed by an application deployment; no cloud remote,
DNS credentials, retention policy, or certificate renewal state is changed by
committing these files.** The historical manual-certificate warning above
remains active until a real unattended renewal dry run succeeds.

For independent backup export:

1. Provision a dedicated remote in another failure domain with provider
   versioning/deletion protection and a least-privilege credential. Configure
   the host's rclone remote in a root-readable file outside the repository.
2. Create `/etc/quiet-room/backup-export.env` with mode 0600. Set
   `QUIET_ROOM_BACKUP_DIR` to the actual completed snapshot directory,
   `QUIET_ROOM_BACKUP_REMOTE` to the provisioned named remote and prefix, and
   `RCLONE_CONFIG` to that host-only configuration file. Example variable shapes
   are `QUIET_ROOM_BACKUP_REMOTE=offsite:private-bucket/quiet-room` and
   `RCLONE_CONFIG=/etc/quiet-room/rclone.conf`; replace them with the actual
   approved destination. No destination is embedded in source.
3. Install the reviewed export/check scripts as root-owned executables under
   `/usr/local/sbin/`, create `/var/lib/quiet-room-deploy` with mode 0755, and
   install the corresponding service/timer files under `/etc/systemd/system/`.
4. Run `systemctl daemon-reload`, then run the export service once and inspect its
   status and remote snapshot. Only after it succeeds, enable
   `quiet-room-backup-export.timer` and `quiet-room-operations-check.timer` with
   `systemctl enable --now`. The exporter needs Docker and rclone installed on
   the host; it does not add them to the application container.
5. Connect service failures to the existing operations alert destination. The
   check runs every six hours and exits nonzero if the certificate expires
   within 30 days, unattended renewal is not configured, its timer is inactive,
   or no verified remote copy was recorded within 36 hours. A failed systemd
   unit is observable state, not a claim that an external notification was sent.

Export verifies the local SQLite/chunk manifest and rejects stale snapshots
before upload. It copies only to a named remote with `--immutable --checksum`,
then downloads and compares the remote bytes. It writes the freshness receipt
only after all stages succeed. It never uses a destructive sync/delete command
and never mounts the live data volume. Remote versioning/immutability must still
be enforced by the storage provider. See the official [rclone check
semantics](https://rclone.org/commands/rclone_check/) and [immutable copy
option](https://rclone.org/docs/#immutable).

The exporter also records `offsite-snapshot-at` after remote comparison. The
operations checker requires both that snapshot time and `offsite-verified-at`,
and checks age from the snapshot, so copying an old point cannot refresh its
RPO. Install the paired exporter/checker and run a verified export when
activating this version; an old receipt without a snapshot time fails closed.
Installation, capacity expansion, independent storage and actual notification
delivery still require operational evidence. Candidate acceptance and synthetic
measurements are tracked in the [architecture optimization record](docs/requirements/2026-09-30-architecture-resource-optimization/README.md).

For certificate renewal, first select an unattended authenticator that actually
works for the installed certificate: a verified HTTP-01 webroot path or a
least-privilege DNS authentication hook. Install
`deploy/certbot/quiet-room-reload-nginx` under
`/etc/letsencrypt/renewal-hooks/deploy/` only after reviewing the host's Nginx
service; the hook tests configuration and reloads Nginx after successful
renewal. It does not by itself automate manual DNS-01 validation. Run
`certbot renew --cert-name ai.shui.click --dry-run`, record the successful CA
validation, and confirm the actual Certbot timer is enabled and active. If the
host uses a different timer name, set `QUIET_ROOM_CERTBOT_TIMER` in
`/etc/quiet-room/operations.env`. This follows the official [Certbot renewal and
hook workflow](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates).

## Cutover write boundary and shared-IP connections

The current Nginx template allows 32 `/ws` connections from a shared IP, supporting
six participant devices plus reconnect overlap; authenticated room/device and
global application caps still apply. Install and test the actual Nginx config
before treating this repository limit as production behavior.

During a deploy, the root-owned maintenance marker blocks public business APIs
and new WebSockets before old containers stop. Validation runs while the gate
is closed. Before reopening it, the helper permanently ends automatic database
rollback for that release. A post-open WSS failure retains all current data and
reports `POST_OPEN_CHECK_FAILED`; do not manually restore the old archive over
messages clients may already have acknowledged. A marker left after an
interruption survives reboot and requires inspection before another deployment.


## Verified deployment and remaining dependencies (2026-09-04, audit fixes)

- Application commit `bebcc1090206c1df752000f1092fd2840bb217f9` was pushed to GitHub and deployed through the authenticated Alibaba Cloud Workbench. The running container image matches that commit and reports healthy. The deployment helper completed its local/public HTTP and WebSocket probes, returned `DEPLOY_OK`, and removed the maintenance marker. Public health returned `{"ok":true,"database":true,"storage":true}`.
- Release directory: `/opt/quiet-room/git-releases/20260904T025836Z-bebcc1090206`. The verified cold predeploy archive is `/opt/quiet-room/backups/predeploy/data-20260904T025836Z-bebcc1090206.tar.gz`.
- The revised root-owned deployment helper and `/etc/nginx/conf.d/ai-shui.conf` were installed separately, after staging from that exact commit and comparing SHA-256 digests with the trusted local files. `nginx -t` passed; the helper is `root:root` mode `0755`. Previous installed copies are preserved in `/opt/quiet-room/deploy-state/pre-bebcc109/`.
- The operations checker, offsite exporter, their systemd units, and the Certbot post-renewal Nginx reload hook are installed. `quiet-room-operations-check.timer` is enabled. The host's existing renewal timer is **`certbot-renew.timer`**, enabled and active; `/etc/quiet-room/operations.env` sets `QUIET_ROOM_CERTBOT_TIMER=certbot-renew.timer`. Do not assume the Debian-style `certbot.timer` name on this host.
- Certificate expiry was re-read as **2026-12-02 22:54:18 UTC**. Certbot 1.22.0 still has manual DNS authentication configured for this domain. A dry-run with webroot and explicit `--preferred-challenges http-01` reached CA validation but failed with HTTP **403**. No production certificate or renewal authentication was replaced. Automated DNS validation remains to be configured with appropriate existing credentials; merely having an active timer is insufficient.
- No configured offsite destination, verified offsite receipt, or rclone executable was found in the inspected deployment configuration. The export timer remains disabled until the destination/runtime is configured and a real export plus download comparison succeeds. No destination, credential, or successful cloud copy has been invented.
- An actual operations-check run reports `TLS_UNATTENDED_RENEWAL_NOT_CONFIGURED` and `OFFSITE_BACKUP_MISSING_OR_STALE`. These are unresolved external configuration requirements, not a failure of the deployed application. The six-hour timer records failures in systemd/journal; external notification delivery must be integrated with the operator's monitoring service.

## 自动恢复备份与后台运维

客户端的恢复包和历史归档以密文存放在主 SQLite 中，既有在线快照及冷备份会包含这些表；历史附件仍依赖已完成密文块。客户端仅在前台解锁联网时同步，所以服务器快照新鲜不等于每台设备的最新消息已备份。恢复演练需同时验证 QR3 取件、本地完整性、可信设备协助替换、新码轮换、主动历史/相册恢复及原件可用性，使用合成会话。协议详见 [RECOVERY_BACKUPS.md](./RECOVERY_BACKUPS.md)。

存在恢复备份的未配对会话不会按普通无用邀请自动过期。后台按会话查看设备、时间和大小；不要只按消息数为零就删除。清理要求完整会话号及新的密码/TOTP 验证，删除在线会话和恢复材料并清理附件。附件删除中断由持久队列重试；独立快照与设备副本不会被远程删除。审计记录仅保留删除动作、会话号和时间，不记录管理员表单或恢复材料。现场运行应对元数据记录采取适当访问及保留策略。

`admin.mijiu.cloud` 后台默认关闭，配置步骤见 `DEPLOYMENT.md`。管理员配置在聊天数据卷之外，只读挂载给应用，需独立安全保管并保持服务器时钟准确。后台密码哈希与 TOTP 种子不具备用户内容解密能力。备份工作人员仍不得记录 Authorization、请求正文、恢复码、凭据二维码或归档读取令牌。发布维护门必须同时覆盖普通应用和后台写入，不能让管理员在可回滚的验证窗口修改数据库。

数据快照可能包含历史恢复包装和旧取件哈希。恢复旧服务器快照会恢复当时的权限/版本状态，不应把在线轮换当作不可回滚的全局吊销；在受信任维护中评估快照时点、客户端更新与需重新建立的恢复保护，不能静默对外宣称旧码永远无法再次使用。

## Mac 主动拉取模式

没有常在线异地存储时，可将当前 Mac 作为独立于生产服务器的恢复副本。
这是过渡方案：Mac睡眠、退出登录、断网或损坏会中断备份；FileVault保护静态磁盘，
不会防止已登录用户或恶意管理员删除文件，也不构成不可变／异地存储。

服务器持久生产环境设置 `BACKUP_MODE=mac-pull`、`BACKUP_TMPFS_SIZE=384m`。
local模式保持原有容量门槛。mac-pull将SQLite暂存到既有可写BACKUP_DIR中的
`.quiet-room-mac-export/`，不再把完整数据库放入tmpfs；附件密文仍直接流传。
暂存前按实际page_count预留完整数据库大小加8GiB余量，备份进度中继续检查余量和inode，
失败清理本次暂存，不删除旧恢复点。数据库上限20GiB、整个流32GiB，非数据库单文件仍256MiB、
清单8MiB；源端和Mac接收端均执行边界。容器仍限制512MiB内存，复制/校验使用有界块。
允许上限不是磁盘容量保证；数据库增长及磁盘不足必须失败并报警，不得越过余量或删用户数据。
超过限制、缺少附件或传输错误均失败。
备份健康只认可Mac完成落盘独立验证后与本次会话／清单绑定的回执，36小时过期失败。

按部署规则分别审阅并安装root拥有、0755的
`deploy/server/quiet-room-mac-backup` 到 `/usr/local/sbin/quiet-room-mac-backup`，
仅授权运维用户无参数调用此固定入口；不可授予通用Docker／shell新权限。
普通生产发布不会自动更新该helper。可使用 `scripts/configure-mac-backup-server.mjs`
只读输出计划，审阅后用 `--apply` 原子安装固定helper、无参数sudo规则与持久环境设置，
保留root私有旧环境文件。设置不重启旧版应用；新容器启用模式后才执行新入口。

在Mac已提交且干净的任务版本，使用已有配置运行：

```sh
QUIET_ROOM_DEPLOY_CONFIG=/absolute/path/to/existing-config.json node scripts/install-mac-backup.mjs
# 审阅同一计划后添加 --apply；安装不会启动任务
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/click.shui.quiet-room-backup.plist"
```

安装器把精确提交的纯Node运行文件保存到用户Library，避免依赖任务worktree或node_modules。
LaunchAgent每5分钟检查，距离最近成功快照12小时才再次拉取；任务使用caffeinate防止执行期间
闲置睡眠，一小时截止、互斥防重入。强制手动运行同一runner的 `scripts/mac-backup.mjs`
（不传 `--scheduled`）可立即拉取。需要Mac当前用户登录；唤醒后的补跑不代表睡眠时仍备份。
日志只含操作状态及快照大小／目录，不含生产记录，需定期检查与清理日志。

Mac目标目录必须为真实私有目录，文件0600、目录0700。默认 `strict` 策略仍要求至少8GiB可用、磁盘及inode使用率低于80%。2026-10-17用户确认当前Mac可显式选择 `reserve` 策略：不以磁盘使用率拒绝，改为每个文件写入前预留该文件字节及8GiB，传输中每16MiB复核剩余文件预算，独立验证后／发布前再次检查8GiB余量。未知容量、预算无效或inode使用率达到80%仍失败；空间不足删除半成品，不发送成功回执，不提前删除旧恢复点。其他目标和服务器本地模式默认仍为strict。

仅在已确认的Mac上安装该策略：`scripts/install-mac-backup.mjs --capacity-policy reserve`先输出计划，审阅后追加`--apply`。策略写入本机LaunchAgent的`QUIET_ROOM_MAC_BACKUP_CAPACITY_POLICY`，不由服务器或传输头选择；未设置时仍为strict，未知值失败关闭。安装不会启动备份，后续按原bootstrap入口启动。服务器保持mac-pull，来源、私钥路径、SSH主机校验与真实成功回执不变。完整确认与验证由[本次需求](docs/requirements/2026-10-17-mac-backup-reserve/README.md)拥有。
落盘逐文件SHA-256、独立重读SQLite quick_check／索引／附件校验通过后原子发布；服务器
确认成功退出后才执行三个不同UTC日期的保留策略。未知、损坏、发布前恢复点保留。
备份没有成功或已过期时不得放宽独立生产回读门槛。发布后等待首次真实快照及容器健康
探针通过，再运行固定独立回读；若回读失败只续跑回读，不再次切换。
Mac目录与同一Mac上的另一个APFS卷都不等于独立物理备份盘；后续有外置盘后另行迁移与验收。

### 2026-10-23 大数据库灾备兼容升级

先从已验证的干净提交准备新版Mac固定runner，复制清单须包含server/backup-limits.mjs；
保留原LaunchAgent的目标、配置路径、容量策略、12小时间隔及旧runner，再原子切换。
新版接收器兼容原v1流，旧接收器会拒绝大于256MiB的数据库，因此在发布新版服务端前完成接收器升级。
本轮root拥有的无参数服务端helper字节及sudo规则无需变更；现有BACKUP_DIR挂载承载受控暂存。
应用上线后完成真实回执核对；本地270MB合成恢复通过不能替代生产备份新鲜度或实际RTO。

## 隔离合成恢复演练与2026-10-25只读核查

开发验收入口为 `npm run test:restore-drill`。它在独立临时目录创建真实SQLite、两端MLS消息及跨分块加密附件，生成／校验快照后关闭源存储，恢复到空目录并启动回环服务。只有健康、双向MLS解密和附件原字节全部一致才通过；结束关闭服务并移除本轮合成数据。输出只含阶段耗时、条数和字节数，不记录正文或密钥。

流式传输夹具以受控容量输入执行真实strict／reserve策略，保留真实SQLite、文件、摘要和发布／失败回执。低容量、在途容量下降、未知配置、路径越界、篡改、截断及旧恢复点保留分别验证。生产探针与阈值不变。受控测试成功不证明宿主盘满足真实strict准入，也不是整站生产RTO。

本次只读核查：Mac代理已加载，300秒检查、reserve策略、最近退出0；最近实际快照创建2026-10-25T04:44:07.823Z、校验04:45:02.956Z，三个保留点。固定入口对既有应用24c89baa25865fd4bb256851597351e421ce7190重新取得READBACK_OK，未切换生产。此为时点证据，后续必须重新测量新鲜度。

TLS实际有效期仍到2026-12-02T22:54:18Z；续期认证器为manual，没有manual_auth_hook配置，certbot-renew.timer已启用且active。无人值守续期保持未完成；需先具备已授权的DNS验证条件或验证可用HTTP-01路径，再执行真实续期演练。仅有定时器或健康回读不能关闭该项。外部告警送达及不可变异地存储的既有缺口保留。
