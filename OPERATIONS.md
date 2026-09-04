# Production operations

This service can preserve confidentiality when storage is disclosed, but availability and recovery still depend on ordinary operations. A backup that has never been restored is not a recovery plan.

## Backup policy

The included backup worker uses SQLite's online backup API against the live WAL database, removes incomplete attachment reservations from the snapshot, copies only completed immutable ciphertext chunks, verifies SQLite with `PRAGMA quick_check`, and writes SHA-256 checksums for the database and every chunk. It stages into a partial directory and publishes the backup by atomic rename only after verification.

Compose runs that worker once at startup and then every 24 hours by default. It retains 14 completed snapshots. Configure `QUIET_ROOM_BACKUP_DIR` as a mount whose data is replicated to a different failure domain. A second directory on the same disk is not disaster recovery.

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
