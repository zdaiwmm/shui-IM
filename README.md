# Quiet Room

Quiet Room is a mobile-first, two-person encrypted chat. There are no accounts. The page opens as an empty white surface; holding the bottom-right corner for one second reveals the local unlock flow. Text, message type, image metadata, and original image bytes are encrypted in the browser before they reach the service.

The implementation includes:

- one-time invitation and permanent two-device room sealing;
- device-bound vault encryption combining an Argon2id-hardened gesture with WebAuthn PRF user verification, plus one-time legacy migration;
- RFC 9420 MLS forward secrecy for new rooms, authenticated key-package binding, opaque signed welcome messages, and atomic ratchet persistence;
- heartbeat-monitored WebSocket delivery with transactional per-room sequence numbers;
- encrypted persistent outbox, stable message IDs, idempotent retries, and incremental reconnect synchronization;
- signed peer delivery receipts that distinguish server persistence from actual peer receipt;
- original-byte image encryption in resumable 2 MiB chunks;
- client-side image history, integrity verification, and original download;
- two-part local recovery using an encrypted package plus an independently stored 256-bit recovery code, followed by new-device rebinding;
- opt-in payload-free Web Push wake-ups that reveal no sender, room, message type, content, attachment metadata, or count in the push request;
- online WAL-consistent backup, completed-blob snapshotting, per-file checksums, verification, scheduled retention, and guarded restore tooling;
- responsive PWA shell, strict production security headers, and immediate privacy locking on blur, backgrounding, or page hide;
- SQLite ciphertext metadata storage and filesystem ciphertext blob storage;
- production container files and automated crypto/storage/WebSocket tests.

Read [SECURITY.md](./SECURITY.md), [OPERATIONS.md](./OPERATIONS.md), and [PRODUCTION_SECURITY_GATE.md](./PRODUCTION_SECURITY_GATE.md) before deployment. New rooms use RFC 9420 MLS, but the browser library declares that it has not undergone a formal security audit, and a web client cannot fully defend itself if its hosting server actively replaces the delivered JavaScript. The public high-security release gate is therefore not yet cleared.

Production releases are commit-pinned, manually triggered, backed up before cutover, health checked, and automatically rolled back on failure. See [DEPLOYMENT.md](./DEPLOYMENT.md) for the GitHub Actions and direct-SSH workflow.

## Requirements

- Node.js 24 or later. The server uses the built-in `node:sqlite` module.
- A modern browser with Web Crypto, IndexedDB, WebSocket, WebAssembly, PWA support, WebAuthn PRF, and a non-syncable platform credential or compatible hardware security key.
- HTTPS for every non-local deployment.

## Local development

```bash
npm install
npm run dev
```

The browser runs at `http://127.0.0.1:5173`, but device-key testing should open `http://localhost:5173` because WebAuthn relying-party IDs are domain names. The API and WebSocket service run at `http://127.0.0.1:8787` through the Vite proxy.

To exercise the actual entry interaction, hold the bottom-right 64 by 64 pixel area for one second. Keyboard users can focus the concealed trigger and hold Space or Enter for one second.

## Production build

```bash
npm ci
npm run check
HOST=127.0.0.1 PORT=8787 DATA_DIR=/srv/quiet-room/data npm start
```

`DATA_DIR` contains:

```text
quiet-room.sqlite
quiet-room.sqlite-wal
quiet-room.sqlite-shm
blobs/<room-id>/<blob-id>/<chunk-index>.bin
```

All message bodies and blob chunks in that directory are encrypted. Operational metadata and public keys are not secret.

## Container deployment

Build and run directly:

```bash
docker build -t quiet-room:local .
docker run --rm \
  -p 127.0.0.1:8080:8080 \
  -v quiet-room-data:/app/data \
  quiet-room:local
```

Or use the included Compose file:

```bash
docker compose up -d --build
```

The Compose port is deliberately bound to loopback. Put Caddy, nginx, Traefik, or a cloud load balancer in front of it and expose only HTTPS. The proxy must preserve WebSocket upgrades on `/ws`, allow request bodies slightly above 2 MiB, apply creation/upload rate limits, and return HSTS on the public hostname. Compose also starts the backup worker; set `QUIET_ROOM_BACKUP_DIR` to a mount replicated outside the application host.

Example nginx location block:

```nginx
client_max_body_size 3m;

location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Terminate TLS with a valid public certificate. Do not bypass certificate warnings during setup.

## First conversation

1. Both people open the same site and see a white screen.
2. The creator holds the bottom-right corner for one second and selects **创建会话**.
3. The creator draws the same local unlock gesture twice and completes device user verification. Strict mode refuses a passkey that the authenticator marks as syncable. The creator then shares the invitation QR code or full invitation link through a trusted channel. A gesture needs at least four points; six or more are recommended.
4. The second person opens the invite, holds the bottom-right corner, sets a different local gesture, completes device verification, and joins. The creator publishes a signed opaque MLS welcome; neither side enables the composer before MLS setup completes.
5. The room seals after the second device. Compare the **设备安全码** shown in the top-right menu on both devices.
6. Each person exports a recovery package, separately records the one-time displayed recovery code, and stores them in different locations.

The invite URL fragment contains the room access capability and pairing secret. Anyone who obtains an unused invite can claim the second slot. Share it only with the intended participant.

## Ordering model

For new rooms, the client advances the RFC 9420 MLS application-message ratchet and commits the resulting ciphertext, updated encrypted ratchet state, and encrypted outbox item in one IndexedDB transaction before network transmission. Retries reuse exactly that ciphertext and one stable UUID. Incoming ratchet state, decrypted local history, and the pending signed receipt are also committed together. After signature verification, the service atomically increments the room sequence and stores only the opaque envelope. It acknowledges only committed messages and broadcasts them with that sequence. Clients render confirmed messages by sequence and request everything after their last contiguous sequence following a reconnect. The server uniqueness constraint makes repeated sends converge to one stored message.

The UI uses three distinct states. **等待服务器** means only the encrypted local outbox is durable. **服务器已保存** means the server committed the signed ciphertext. **对端已安全接收** appears only after the other enrolled device decrypts the message, persists local history, and returns an ECDSA-signed receipt. A server cannot forge that final state without the peer signing key.

This defines a deterministic server-acceptance order. It does not claim to know which person physically tapped Send first when two devices send concurrently over networks with different latency.

## Original image behavior

The browser reads the selected file bytes directly. It does not use Canvas, resize, recompress, remove EXIF, or change the encoding. The encrypted manifest stores the original name, MIME type, length, and SHA-256 digest. After download and decryption, the client rejects the result unless the byte length and digest match the upload.

The server never creates thumbnails and does not know that a message contains an image. The creator-only gallery decrypts message manifests locally, then downloads and decrypts originals when needed. It contains both chat images and images the creator uploads directly from the gallery; direct gallery uploads do not create chat bubbles. The invited participant has no gallery entry or gallery route, while chat images remain visible in the conversation. The first version limits one image to 256 MiB and 128 encrypted 2 MiB chunks. Upload reservations and completed chunk indexes are persisted, so selecting the same file after an interruption resumes without changing the blob ID, key, or IV prefix.

Opening the system image picker can blur or hide the browser. While a user-initiated chat or gallery image picker is active, Quiet Room ignores only those picker-generated blur/hidden events so the current screen remains visible and a confirmed file can proceed directly to encrypted upload. Selection, cancellation, or a bounded timeout removes the exception. `pagehide`, explicit lock, idle timeout, and later unrelated blur/background events still activate the white privacy curtain and clear the decrypted session.

## Recovery and loss

The version-2 recovery JSON contains the encrypted vault payload and a master key wrapped for a separately displayed random 256-bit recovery code. It contains neither the gesture nor the recovery code. Import requires both parts, then creates a new non-syncable WebAuthn credential and a new gesture binding on the target device.

The recovery package is a vault/ratchet checkpoint, not a backup of the encrypted IndexedDB history store. A restored device resumes after the checkpoint and can receive later peer messages, but prior locally rendered history is not copied to the new device. Export a fresh package after security-state changes and never run the original and restored copies concurrently.

Vaults created before the gesture release remain accessible. They are identified as legacy vaults, unlocked once with the original password, and re-encrypted under a newly confirmed gesture with a fresh Argon2id salt before the conversation opens.

If both the local IndexedDB vault and recovery package are lost, the server cannot reset the gesture or decrypt the history. That is an intended consequence of the server having no content keys.

A gesture is more convenient than a strong password, not inherently stronger. The minimum four-point pattern is a usability floor; use six or more non-obvious points. Argon2id hardens the gesture, while the WebAuthn PRF output makes the normal vault key device-bound. Online unlock attempts are delayed exponentially after repeated failures. The exported recovery path intentionally bypasses the original device and is protected by a separate 256-bit random code, so protect both recovery parts as private-key material and store them separately.

## Resource and operations controls

The server enforces request and WebSocket frame rates, per-room connection limits, message-count/message-byte quotas, a 256 MiB per-image limit, per-room/global blob reservations, and a maximum number of incomplete uploads. Incomplete uploads are garbage-collected after 24 hours by default. `/api/health` verifies both SQLite access and data-directory readability/writability.

The defaults can be tuned with `MAX_BLOB_BYTES`, `MAX_ROOM_STORAGE_BYTES`, `MAX_TOTAL_STORAGE_BYTES`, `MAX_INCOMPLETE_BLOBS`, `MAX_MESSAGES_PER_ROOM`, `MAX_ROOM_MESSAGE_BYTES`, `MAX_CONNECTIONS_PER_ROOM`, `MAX_CONNECTIONS_TOTAL`, and `INCOMPLETE_BLOB_TTL_MS`.

## Commands

```bash
npm run build       # Type-check and build the PWA
npm test            # Crypto, exact-image, storage, and WebSocket integration tests
npm run check       # Build and all tests
npm run test:browser # Real Chrome: gestures, two peers, receipts, blur/pagehide, outbox, creator gallery, file pickers, migration
npm run check:full  # Build, unit/integration tests, and the real-browser suite
npm run backup:create # Create and verify an online backup
npm run backup:verify -- /absolute/backup/path
npm run backup:restore -- /absolute/backup/path /absolute/empty/target
npm run push:keys   # Generate deployment VAPID keys
npm start           # Serve dist/, API, WebSocket, SQLite, and blob storage
```

The browser suite uses the installed Chrome channel by default. Set `CHROME_PATH` to an explicit Chromium-compatible executable when needed.
