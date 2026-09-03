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
