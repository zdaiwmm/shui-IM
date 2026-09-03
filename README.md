# Quiet Room

Quiet Room is a mobile-first, two-person encrypted chat with independently keyed multi-device access. There are no accounts. The page opens as an empty white surface; holding the bottom-right corner for one second reveals the local unlock flow. Text, reply relationships, message type, image metadata, and original image bytes are encrypted in the browser before they reach the service.

The canonical production origin is `https://ai.shui.click`. Passkeys and local
history are intentionally bound to that exact origin; the retired
`chat.mijiu.cloud` origin is not a compatible local-vault namespace.

The implementation includes:

- one-time participant invitation, followed by independently authorized multi-device access for each participant;
- passkey-only local vault unlock using WebAuthn PRF output and system user verification, plus one-time migration for legacy password/gesture vaults;
- RFC 9420 MLS forward secrecy for new rooms, authenticated key-package binding, signed Add/Remove commits, opaque welcome messages, and atomic ratchet persistence;
- device management with independent device identities and tokens, six-digit out-of-band approval codes, a three-device-per-participant limit, revocation, and server-enforced history boundaries;
- heartbeat-monitored WebSocket delivery with transactional per-room sequence numbers;
- encrypted persistent outbox, stable message IDs, idempotent retries, and incremental reconnect synchronization;
- signed peer delivery receipts that distinguish server persistence from actual peer receipt;
- encrypted message replies whose target, sender, and generic type remain inside the MLS payload, while any content preview is derived only from this device's local history;
- original-byte image encryption in resumable 2 MiB chunks;
- single encrypted 2–9-image album messages, viewport-triggered local previews, and an overlay viewer with paging and original download;
- encrypted per-device reading anchors and emoji/meme favorites;
- more than 100 emoji choices and locally bundled OpenMoji 17.0.0 meme artwork with CC BY-SA 4.0 attribution;
- role-aggregated chat-page presence that is independent from WebSocket connection state;
- mobile-keyboard-aware layout, deliberate page/viewer motion, transparent in-page bars, and page-level double-tap zoom suppression;
- two-part local recovery using an encrypted package plus an independently stored 256-bit recovery code, followed by new-device rebinding;
- opt-in payload-free Web Push wake-ups that reveal no sender, room, message type, content, attachment metadata, or count in the push request;
- online WAL-consistent backup, completed-blob snapshotting, per-file checksums, verification, scheduled retention, and guarded restore tooling;
- responsive PWA shell, strict production security headers, and immediate privacy locking on blur, backgrounding, or page hide;
- SQLite ciphertext metadata storage and filesystem ciphertext blob storage;
- production container files and automated crypto/storage/WebSocket tests.

Read [SECURITY.md](./SECURITY.md), [OPERATIONS.md](./OPERATIONS.md), and [PRODUCTION_SECURITY_GATE.md](./PRODUCTION_SECURITY_GATE.md) before deployment. New rooms use RFC 9420 MLS, but the browser library declares that it has not undergone a formal security audit, and a web client cannot fully defend itself if its hosting server actively replaces the delivered JavaScript. The public high-security release gate is therefore not yet cleared.

Production releases are commit-pinned, manually triggered from a trusted computer, backed up before cutover, health checked, and automatically rolled back on failure. See [DEPLOYMENT.md](./DEPLOYMENT.md) for the GitHub CI, direct-SSH workflow, and one-time canonical-domain provisioning sequence.

## Requirements

- Node.js 24 or later. The server uses the built-in `node:sqlite` module.
- A modern browser with Web Crypto, IndexedDB, WebSocket, WebAssembly, PWA support, and a WebAuthn PRF-capable passkey or hardware security key.
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
3. The creator selects **设置通行密钥** and completes system biometric or device-password verification. Both syncable passkeys and single-device credentials are accepted. The creator then shares the invitation QR code or full invitation link through a trusted channel.
4. The second person opens the invite, holds the bottom-right corner, creates a passkey-protected local vault, and joins. The creator publishes a signed opaque MLS welcome; neither side enables the composer before MLS setup completes.
5. The participant invite seals after the second person joins. Compare the **设备安全码** shown in the top-right menu on both sides.
6. Each person exports a recovery package, separately records the one-time displayed recovery code, and stores them in different locations.

The invite URL fragment contains the room access capability and pairing secret. Anyone who obtains an unused invite can claim the second slot. Share it only with the intended participant.

## Additional devices and replies

Open **设备管理** from the chat menu to add or remove one of your own devices. An add link expires after ten minutes. The new device generates its own identity, MLS key package, access token, and passkey-protected vault; no private key or old group state is copied from the existing device. Both screens derive a six-digit safety code from the link and the two public identities. Approve only when the codes match.

Approval publishes a signed MLS Add commit and advances the group epoch. The service records the exact message and receipt boundary at activation and will not return earlier records to that device. It also rejects application ciphertext from an obsolete MLS epoch; a connected client then applies the membership update and atomically re-encrypts its pending message under the current epoch. Consequently a newly added device can decrypt messages accepted after approval, but cannot decrypt or fetch earlier history. Each participant can have at most three active devices. Removing a device publishes a signed MLS Remove commit, invalidates its device token and push subscription, closes its live socket, and rotates keys for subsequent messages. Already decrypted history on the removed physical device cannot be remotely erased.

To reply, long-press an incoming message, open its context menu, or use the visible reply shortcut on pointer devices. The quoted message ID, sequence, sender, kind, and a generic non-content label are part of the version-2 encrypted message payload. The server sees only the ordinary opaque MLS ciphertext and cannot learn which message was replied to. A device that already owns the referenced message derives the visible quote from its encrypted local history; a newly linked device shows that the historical message is unavailable instead of receiving a copied excerpt from before its MLS join boundary.

## Ordering model

For new rooms, the client advances the RFC 9420 MLS application-message ratchet and commits the resulting ciphertext, updated encrypted ratchet state, and encrypted outbox item in one IndexedDB transaction before network transmission. Retries reuse exactly that ciphertext and one stable UUID. Incoming ratchet state, decrypted local history, and the pending signed receipt are also committed together. After signature verification, the service atomically increments the room sequence and stores only the opaque envelope. It acknowledges only committed messages and broadcasts them with that sequence. Clients render confirmed messages by sequence and request everything after their last contiguous sequence following a reconnect. The server uniqueness constraint makes repeated sends converge to one stored message.

The UI uses three distinct states. **等待服务器** means only the encrypted local outbox is durable. **服务器已保存** means the server committed the signed ciphertext. **对端已安全接收** appears only after the other enrolled device decrypts the message, persists local history, and returns an ECDSA-signed receipt. A server cannot forge that final state without the peer signing key.

This defines a deterministic server-acceptance order. It does not claim to know which person physically tapped Send first when two devices send concurrently over networks with different latency.

## Original image behavior

The browser reads the selected file bytes directly. It does not use Canvas, resize, recompress, remove EXIF, or change the encoding. The encrypted manifest stores the original name, MIME type, length, and SHA-256 digest. After download and decryption, the client rejects the result unless the byte length and digest match the upload.

Selecting one image creates an ordinary encrypted image message. Selecting 2–9 images creates one `image-album` payload with ordered, unique manifests, one encrypted outbox item, one server sequence, and one collage bubble instead of separate messages. Each original still uses its own resumable encrypted chunks and integrity check; the aggregate original size of one album message is capped at 256 MiB to bound receiver memory pressure. Sending an album requires every active device to have reported `image-album-v1` after opening the current version, so an old client is never sent an unknown encrypted payload. Visible and near-visible chat media is downloaded, verified, and decrypted locally into an inline preview automatically; the service neither generates nor receives a plaintext thumbnail. The media bubble fits the loaded image or compact album grid rather than reserving a large empty text-bubble frame.

Tap an inline image or an album cell to open the full-screen overlay at that item. Albums can be paged by touch, previous/next controls, or arrow keys, show the current position, and allow the current verified original to be downloaded. Closing the overlay restores focus and the prior surface state; reduced-motion preferences bypass decorative transitions.

The server never creates thumbnails and does not know that a message contains an image. The creator-only gallery decrypts message manifests locally, then downloads and decrypts originals when needed. It contains both chat images and images the creator uploads directly from the gallery; direct gallery uploads do not create chat bubbles. The invited participant has no gallery entry or gallery route, while chat images remain visible in the conversation. The first version limits one image to 256 MiB and 128 encrypted 2 MiB chunks. Upload reservations and completed chunk indexes are persisted, so selecting the same file after an interruption resumes without changing the blob ID, key, or IV prefix.

Opening the system image picker can blur or hide the browser. While a user-initiated chat or gallery image picker is active, Quiet Room ignores only those picker-generated blur/hidden events so the current screen remains visible and a confirmed file can proceed directly to encrypted upload. Selection, cancellation, or a bounded timeout removes the exception. A user-initiated passkey prompt receives the same narrow treatment only before a decrypted session is opened, and the exception ends as soon as the WebAuthn operation settles. `pagehide`, explicit lock, idle timeout, and later unrelated blur/background events still activate the white privacy curtain and clear the decrypted session.

## Reading position, expressions, and presence

Quiet Room encrypts a per-device chat reading anchor in IndexedDB with the same local-record protection used for other vault-owned state. Returning from the gallery or viewer, or reopening an unlocked conversation, restores the anchored message and viewport offset instead of visibly scrolling from the beginning. An anchor that was already at the bottom stays at the bottom, and sending a new message deliberately positions the sender at the latest message.

The expression panel contains more than 100 emoji choices, eight locally packaged meme choices, and a favorites tab. Emoji and meme favorites can be toggled from the picker or an eligible message and are encrypted in the per-device local preference record; they are not uploaded or synchronized between devices. The eight SVG meme assets are unmodified OpenMoji 17.0.0 color emoji by the OpenMoji project of HfG Schwäbisch Gmünd, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Full pinned-source and attribution details ship with the assets in `public/memes/openmoji-17.0.0/LICENSE.md`; the running app does not fetch meme art from a third party.

If the composer is focused, opening the image picker does not intentionally dismiss the keyboard, and focus is restored after selection. Opening and using the expression panel keeps the composer and keyboard active; tapping outside the composer dismisses both. The layout follows `VisualViewport` changes so the input remains above the mobile soft keyboard. Page-level double-tap/gesture zoom is disabled, while image enlargement remains available through the purpose-built overlay viewer.

The chat header and composer, gallery/viewer headers, and other page-owned bars use transparent backgrounds. Navigation, viewer, menu, and local-security notice transitions use longer platform-style easing and honor `prefers-reduced-motion`. A normal website cannot force Safari or Chrome's native bottom toolbar to be transparent: the transparent `theme-color`, edge-to-edge viewport, and installed-PWA manifest are best-effort integration hints, and browser-owned chrome may remain opaque.

The two online labels describe chat-page presence, not raw WebSocket connectivity. Each authenticated socket starts `away` and reports `chat` only while its device is on the chat surface; a participant role is online when any active device for that role reports `chat`. Moving to gallery, image viewer, or device management reports `away` without tearing down the socket. The client remembers the desired state and replays it after authentication on reconnect, while socket close, member changes, and ping/pong timeout remove stale presence. Presence exists only in server memory and is role-aggregated before broadcast. It is server-visible behavioral metadata and an advisory UI hint—not an end-to-end-verifiable identity, attention, or safety signal.

## Recovery and loss

The version-3 recovery JSON contains the encrypted vault payload and a master key wrapped for a separately displayed random 256-bit recovery code. It contains neither passkey PRF output nor the recovery code. Import requires both parts, then creates a new passkey-only binding on the target device. Version-2 recovery packages remain importable.

The recovery package is a vault/ratchet checkpoint, not a backup of the encrypted IndexedDB history store. A restored device resumes after the checkpoint and can receive later peer messages, but prior locally rendered history is not copied to the new device. Export a fresh package after security-state changes and never run the original and restored copies concurrently.

Legacy password vaults remain accessible: they are unlocked once with the original password and migrated directly to passkey-only version 3. A version-2 gesture-plus-passkey vault must accept its existing gesture one final time because that gesture is cryptographic input to the old wrapping key; after a successful unlock it is immediately rewrapped as passkey-only version 3.

If both the local IndexedDB vault and recovery package are lost, the server cannot reset the passkey binding or decrypt the history. That is an intended consequence of the server having no content keys.

Version-3 vault encryption still uses a random 256-bit master key and AES-GCM. Its wrapping key is derived from WebAuthn PRF output with HKDF-SHA-256 and is released only after authenticator user verification. Removing the gesture does not reduce the message cipher, MLS properties, key sizes, or at-rest encryption algorithm, but it deliberately removes one independent knowledge factor: local access now depends on the passkey plus the operating system's biometric/device-password policy. A syncable passkey can be available on another device in the same passkey ecosystem; use a compatible single-device authenticator or hardware security key when strict physical-device binding is required. The exported recovery path intentionally bypasses the original authenticator and is protected by a separate 256-bit random code, so protect both recovery parts as private-key material and store them separately.

## Resource and operations controls

The server enforces request and WebSocket frame rates, per-room connection limits, message-count/message-byte quotas, a 256 MiB per-image limit, per-room/global blob reservations, and a maximum number of incomplete uploads. Expired add-device links and their never-approved pending members are removed automatically, so abandoned claims do not consume a device slot. Incomplete uploads and unclaimed one-member rooms are garbage-collected after 24 hours by default. `/api/health` verifies both SQLite access and data-directory readability/writability.

The defaults can be tuned with `MAX_BLOB_BYTES`, `MAX_ROOM_STORAGE_BYTES`, `MAX_TOTAL_STORAGE_BYTES`, `MAX_INCOMPLETE_BLOBS`, `MAX_MESSAGES_PER_ROOM`, `MAX_ROOM_MESSAGE_BYTES`, `MAX_CONNECTIONS_PER_ROOM`, `MAX_CONNECTIONS_TOTAL`, `INCOMPLETE_BLOB_TTL_MS`, and `ORPHAN_ROOM_TTL_MS`. When deployed behind a reverse proxy, set `TRUSTED_PROXY_ADDRESSES` to the proxy's exact source addresses before enabling client-IP forwarding. `PUSH_ALLOWED_HOSTS` is an explicit comma-separated allowlist for Web Push provider hostnames; leave it empty to reject all subscriptions when push is not configured.

## Commands

```bash
npm run build       # Type-check and build the PWA
npm test            # Crypto, exact-image, storage, and WebSocket integration tests
npm run check       # Build and all tests
npm run test:browser # Real Chrome: passkeys, two participants, replies, receipts, blur/pagehide, outbox, gallery, file pickers, migration
npm run check:full  # Build, unit/integration tests, and the real-browser suite
npm run backup:create # Create and verify an online backup
npm run backup:verify -- /absolute/backup/path
npm run backup:restore -- /absolute/backup/path /absolute/empty/target
npm run push:keys   # Generate deployment VAPID keys
npm start           # Serve dist/, API, WebSocket, SQLite, and blob storage
```

The browser suite uses the installed Chrome channel by default. Set `CHROME_PATH` to an explicit Chromium-compatible executable when needed.
