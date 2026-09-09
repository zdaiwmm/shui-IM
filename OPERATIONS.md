# Production operations

This service can preserve confidentiality when storage is disclosed, but availability and recovery still depend on ordinary operations. A backup that has never been restored is not a recovery plan.

## Backup policy

The included backup worker uses SQLite's online backup API against the live WAL database, removes incomplete attachment reservations from the snapshot, copies only completed immutable ciphertext chunks, verifies SQLite with `PRAGMA quick_check`, and writes SHA-256 checksums for the database and every chunk. It stages into a partial directory and publishes the backup by atomic rename only after verification.

Compose runs that worker once at startup and then every 24 hours by default. It retains 14 completed snapshots. Configure `QUIET_ROOM_BACKUP_DIR` as a mount whose data is replicated to a different failure domain. A second directory on the same disk is not disaster recovery.

The public expression catalog stores its original images and publication state in the same SQLite database,
so online snapshots and restore include it. Public catalog bytes are separate from encrypted chat attachments.
Interrupted acquisition jobs remain interrupted after restart and require a new explicit administrator action.

Recommended minimum production policy:

- RPO: 24 hours or less; reduce `BACKUP_INTERVAL_MS` if that loss window is unacceptable.
- Retention: 14 daily snapshots, plus storage-provider lifecycle copies if required.
- Off-host copy: encrypted storage in another account/project or region, with versioning and deletion protection.
- Access: the application can read the live data volume; the backup worker mounts it read-only. Backup operators should not have application deployment privileges unless necessary.
- Alerting: alert if no `backup_verified` event is recorded within 1.5 backup intervals, if the target is nearly full, or if off-host replication lags.

Manual commands:

```bash
DATA_DIR=/srv/quiet-room/data BACKUP_DIR=/mnt/offsite/quiet-room npm run backup:create
npm run backup:verify -- /mnt/offsite/quiet-room/quiet-room-2026-09-03T00-00-00-000Z
npm run backup:restore -- /mnt/offsite/quiet-room/quiet-room-2026-09-03T00-00-00-000Z /srv/quiet-room/restore-drill
```

`backup:restore` refuses a non-empty destination. Restore into an isolated path, start an isolated server against it, verify `/api/health`, room/member/message counts, completed attachments, and a synthetic two-device decrypt flow, then record measured RTO. Do this at least monthly and before changing SQLite, filesystem, container, or backup versions.

Checksums detect accidental or partial corruption, but a manifest stored beside the backup is not a signature against an attacker who can rewrite both. Use immutable/versioned off-host storage and independent access logs for that threat.

## Privacy-preserving background notifications

Generate a VAPID key pair once:

```bash
npm run push:keys
```

Store `VAPID_PRIVATE_KEY` in the deployment secret manager, configure a real security contact in `VAPID_SUBJECT`, and expose only the public key to the client. Rotating the VAPID key invalidates existing subscriptions, so users must enable notifications again.

The server sends a Web Push request with no payload and excludes the sending device. The service worker creates a generic local notification only after the push arrives. The push provider can still observe the subscription endpoint, source service, timing, and traffic volume; it does not receive room ID, device ID, sender, message kind, text, attachment metadata, or unread count from the notification request.

Push subscriptions are accepted only for the provider hosts in
`PUSH_ALLOWED_HOSTS` (the Compose default covers FCM, Mozilla, Apple, and
Windows endpoints). Keep this allowlist explicit when adding a provider. At
wake time the server requires HTTPS, resolves every address, and rejects
loopback, private, link-local, reserved, multicast, and other non-public
targets. This is defense in depth; production egress should also be restricted
with a firewall or outbound proxy.

Permission is requested only after the user selects the notification control. A push is only a wake-up hint: it is not a delivery receipt, does not unlock the vault, and must never promote a message to “delivered.” iOS requires an installed home-screen web app for Web Push.

## Release and incident basics

The fixed independent post-release verification command is
`npm run deploy:readback -- --sha <full-deployed-SHA>`. Its output separates
phase timing from stable failure classes and saves a redacted local receipt under
`.git/quiet-room-readback/`. A `READBACK_BLOCKED` result means that production
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
- Legacy rooms use the original static-recipient envelope and do not gain forward secrecy automatically. Users must create a new room to obtain MLS.

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
