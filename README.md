# Quiet Room

项目接手、当前状态和决策导航见 [`AGENTS.md`](./AGENTS.md) 与
[`docs/context/`](./docs/context/)。新会话先读轻量入口，再按任务读取本页及专门文档。

Quiet Room is a mobile-first, two-person encrypted chat with independently keyed multi-device access. There are no accounts. The page opens as a browser-load-failure cover; holding the blank bottom-right corner for one second reveals the local unlock flow. Text, reply relationships, reactions, exact message type, image metadata, and original image bytes are encrypted in the browser before they reach the service. A restricted count-only credential updates the cover's unread number without opening the vault.

The canonical production origin is `https://ai.shui.click`. Passkeys and local
history are intentionally bound to that exact origin; the retired
`chat.mijiu.cloud` origin is not a compatible local-vault namespace.

The implementation includes:

- one-time participant invitation, followed by independently authorized multi-device access for each participant;
- passkey-only local vault unlock using WebAuthn PRF output, automatic system verification when entering unlock, and one-time migration for legacy password/gesture vaults;
- RFC 9420 MLS forward secrecy for new rooms, authenticated key-package binding, signed Add/Remove commits, opaque welcome messages, and atomic ratchet persistence;
- device management with independent device identities and tokens, six-digit out-of-band approval codes, a three-device-per-participant limit, revocation, and server-enforced history boundaries;
- heartbeat-monitored WebSocket delivery with transactional per-room sequence numbers;
- encrypted persistent outbox, stable message IDs, idempotent retries, and incremental reconnect synchronization;
- signed peer delivery receipts that distinguish server persistence from actual peer receipt;
- encrypted message replies whose target, sender, and generic type remain inside the MLS payload, while any content preview is derived only from this device's local history;
- encrypted emoji reactions with smoothly repositioned message-corner badges, left-swipe reply, red scoped delete actions, and native text selection inside the original bubble;
- encrypted voice messages with recording, pause/resume, local preview, waveform playback/seeking, and privacy-bound microphone cleanup;
- original-byte image encryption in resumable 2 MiB chunks;
- image selection without a nine-image cap, ordered encrypted message groups, gallery multi-upload, quiet local previews, and a full-screen viewer with paging, drag-to-dismiss, and original download;
- encrypted per-device unsent text drafts, reading anchors, and dismissible recovery reminders;
- role-aggregated chat-page presence that is independent from WebSocket connection state;
- native document chat scrolling behind Safari chrome, keyboard-aware floating glass controls, stable reading anchors, pinchable photos without opening zoom effects, and page-level double-tap zoom suppression;
- automatic encrypted per-device recovery/history backups, local recovery-code retrieval after fresh passkey verification, and explicit history restore after device replacement;
- optional room/device/backup administration with password + TOTP on `admin.mijiu.cloud`, without recovery-code escrow;
- payload-free Web Push wake-ups for existing opt-in subscriptions, revealing no sender, room, message type, content, attachment metadata, or count in the push request; the current UI has no subscription switch;
- online WAL-consistent backup, completed-blob snapshotting, per-file checksums, verification, scheduled retention, and guarded restore tooling;
- responsive PWA shell, strict production security headers, synchronous concealment on every blur, desktop-only in-memory resume with a 30-minute idle limit and F-key entry, and strict mobile/PWA and native-surface locking;
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

For iPhone or other LAN-device passkey testing, expose the frontend through a stable HTTPS hostname whose certificate the device trusts and whose name matches the certificate; keep the loopback API behind the frontend proxy. Home and office run separate local environments. Local `main` is the current computer's LAN-test candidate and is distinct from `origin/main` and production. Code and workflow rules may be synchronized through GitHub only when explicitly requested, while certificates, private keys, test data, passkeys, vaults, invitations, and recovery material remain local. See [Local LAN testing and cross-computer synchronization](docs/workflows/local-lan-testing.md).

The repository includes a fail-closed LAN launcher. It verifies the certificate hostname, validity period, and matching private key before binding Vite to the LAN; the API remains on loopback and is reached through the HTTPS frontend proxy:

```bash
npm run dev:lan -- --host <this-mac-local-hostname>.local
```

Certificate creation, iPhone trust setup, hostname discovery, firewall scope, and service readback are documented in [Local LAN testing and cross-computer synchronization](docs/workflows/local-lan-testing.md#首次配置本机可信-https). Do not use a certificate warning bypass, a raw IP address, or plain LAN HTTP for passkey testing.

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

1. Both people open the same site and see a browser-load-failure cover.
2. The creator holds the bottom-right corner for one second and selects **创建会话**.
3. The creator selects **设置通行密钥** and completes system biometric or device-password verification. Both syncable passkeys and single-device credentials are accepted. The creator then shares the invitation QR code or full invitation link through a trusted channel.
4. The second person opens the invite, holds the bottom-right corner, creates a passkey-protected local vault, and joins. The creator publishes a signed opaque MLS welcome; neither side enables the composer before MLS setup completes.
5. The participant invite seals after the second person joins. Compare the **设备安全码** shown in the top-right menu on both sides.
6. Each device automatically saves encrypted backups while unlocked and online. Open “备份与恢复”, verify the passkey again to view its recovery code, and save that code separately.

The invite URL fragment contains the room access capability and pairing secret. Anyone who obtains an unused invite can claim the second slot. Share it only with the intended participant.

## Additional devices and replies

Open **设备管理** from the chat menu to add or remove one of your own devices. An add link expires after ten minutes. Participant invitations and device links have distinct, strictly validated URL fragments, so every newly generated device link enters the device-approval flow even after another device has already been added; a claimed or expired device link reports its own state instead of the sealed participant-invite error. The new device generates its own identity, MLS key package, access token, and passkey-protected vault; no private key or old group state is copied from the existing device. Both screens derive a six-digit safety code from the link and the two public identities. Approve only when the codes match.

Approval publishes a signed MLS Add commit and advances the group epoch. The service records the exact message and receipt boundary at activation and will not return earlier records to that device. It also rejects application ciphertext from an obsolete MLS epoch; a connected client then applies the membership update and atomically re-encrypts its pending message under the current epoch. Consequently a newly added device can decrypt messages accepted after approval, but cannot decrypt or fetch earlier history. Each participant can have at most three active devices. Removing a device publishes a signed MLS Remove commit, invalidates its device token and push subscription, closes its live socket, and rotates keys for subsequent messages. Already decrypted history on the removed physical device cannot be remotely erased.

To reply, drag a confirmed bubble left until the resisted gesture arms, or use Reply in its long-press/context menu. The bubble settles back, the keyboard focuses automatically, and the one-line quote shares one outlined stack with the text field. A horizontal reply swipe also works while the keyboard is already open; vertical scrolling remains native. The quoted message ID, sequence, sender, kind, and a generic non-content label are part of the version-2 encrypted message payload. The server sees only the ordinary opaque MLS ciphertext and cannot learn which message was replied to. A device that already owns the referenced message derives the visible quote from its encrypted local history; a newly linked device shows that the historical message is unavailable instead of receiving a copied excerpt from before its MLS join boundary.

The same message menu exposes a red Delete action. “仅为我删除” is an encrypted preference on this device and does not change room history or the outbox. A confirmed message belonging to the same participant also offers “为所有人删除”, which sends a capability-gated encrypted tombstone that suppresses the target from chat and the creator Safe after validation. These actions are logical projections: they do not promise physical erasure from prior backups, exports, offline endpoints, or operating-system copies.

## Ordering model

For new rooms, the client advances the RFC 9420 MLS application-message ratchet and commits the resulting ciphertext, updated encrypted ratchet state, and encrypted outbox item in one IndexedDB transaction before network transmission. Retries reuse exactly that ciphertext and one stable UUID. Incoming ratchet state, decrypted local history, and the pending signed receipt are also committed together. After signature verification, the service atomically increments the room sequence and stores only the opaque envelope. It acknowledges only committed messages and broadcasts them with that sequence. Clients render confirmed messages by sequence and request everything after their last contiguous sequence following a reconnect. The server uniqueness constraint makes repeated sends converge to one stored message.

The UI separates submission from read feedback. **等待发送** means only the encrypted local outbox is durable. **单柄对勾 / 已发送** means the server committed the signed ciphertext, including messages received by the peer but not yet read. **双柄对勾 / 已读** requires an authenticated encrypted read event from the opposite participant bound to the exact message. Text, voice and ordinary file bubbles count when visible in focused foreground chat; images and videos additionally require verified, loaded and revealed previews. Read does not prove human attention, listening or document opening. The existing signed delivery receipt still records successful device reception internally. Non-media read events require every active device to support `message-read-v1`; older clients do not produce inferred double checks.

Time and receipt information appear inside the bottom-right of each message bubble. A centered date separator appears once per locally loaded calendar date, derived from the message's original `sentAt` in the device's local timezone, without changing server order or unread semantics. Earlier-history pagination relocates the separator and preserves the reading anchor. The down-arrow control remains attached above the composer, appears according to the newest message/control edge comparison, and scrolls back to the latest message with distance-sensitive motion while preserving keyboard focus.

This defines a deterministic server-acceptance order. It does not claim to know which person physically tapped Send first when two devices send concurrently over networks with different latency.

## Original photo, video, and file behavior

The browser reads the selected file bytes directly for encryption. It does not resize, recompress, remove EXIF, or change the original encoding. The encrypted manifest stores the original name, MIME type, length, and SHA-256 digest. After download and decryption, the client rejects the result unless the byte length and digest match the upload. A video preview is a separate, memory-only JPEG generated locally from the verified original; it never replaces the original bytes or goes to the service.

Both local file pickers accept arbitrary formats, including PDF, office documents, archives, audio/video files, and unknown MIME types. Nonempty files up to 256 MiB retain their exact bytes through the same encrypted, resumable transport. Chat sends each non-image using the existing file message format; videos show a preview and play control. PDF, EPUB and allowlisted text documents open in the local reader after full verification; other files show download controls. Format-specific icons distinguish document, book, spreadsheet, presentation, archive and other families. The reader uses bundled PDF.js for PDF, literal text for TXT/JSON/Markdown/CSV, liquid-glass controls, horizontal PDF paging, zoom and search. EPUB 2/3 uses epub.js, zip.js and DOMPurify for safe chapter reflow, a chapter directory, packaged images and search. Limits are 64 MiB / 2,000 PDF pages, 32 MiB compressed EPUB or 4 MiB / 2,000,000 text characters; EPUB extraction limits are detailed in PRODUCT.md and SECURITY.md. Password-protected PDF, EPUB DRM, publisher styling, OCR and Office rendering are not included. Mixed selections preserve order and keep consecutive images in their existing album groups. Files uploaded directly from the creator gallery remain outside both chat streams: videos appear in 相册, and other files appear in 文件. Arbitrary active file content is never executed. Sending files, gallery files, and replies to files requires every active device to advertise `file-message-v1`, including when retrying an existing encrypted outbox item. Video display reuses these payloads and also applies to older compatible file messages.

The creator gallery entry is labeled 保险箱. Its single header row contains back, a 44px-high 相册 / 文件 segmented control with muted loaded-item counts, an eye visibility toggle, and upload. Opening it defaults to 相册, which contains both photos and videos with all thumbnails blurred. Tap once to reveal a thumbnail and again to open the viewer; a video's second tap requests native fullscreen playback. Empty and unknown counts show no dash or ellipsis. The header aligns with chat, the segment indicator slides without rebuilding its controls, and category content and explicit thumbnail visibility changes fade. The eye / slashed-eye action shows or hides all current thumbnails. Long-pressing any photo, video, or Safe file opens Pin/Unpin and red Delete actions; both are encrypted device-local Safe projections, so chat order/content is unchanged, and a failed preference save rolls back. Thumbnails have no reveal text or time badge; videos have a play control, and photo and in-page fallback details show the message/upload time. Information shown in the native video player is controlled by the system. Visibility lasts only for the current visit, resets after leaving or locking, and does not change authentication or encryption. Newly arriving media starts hidden. Existing gallery-file videos appear in 相册 instead of 文件; the file list contains other direct uploads. Each tab has its own empty state and earlier-history loading; incomplete counts are distinguished from totals without acquiring a stray `+` after a completed tab has been revisited. Upload completion opens the category containing the newly uploaded item.

Chat photos, album cells and video still previews start blurred. A cover-fitted blur of the same verified local media fills any letterbox behind the contain-fitted foreground, including extreme portraits and panoramas, so the concealed frame has no mismatched strips. Tap once to reveal that thumbnail and again to open its viewer. Drag downward in the conversation to conceal all chat thumbnails; downward viewer dismissal does the same. The browser-failure privacy curtain immediately resets reveals and closes the viewer, even if focus quickly returns before mobile locking. Reveal state is memory-only during the unlocked session. Images open at their final size with a fade, support 1×–5× two-finger zoom and panning, and animate double-tap zoom/reset progressively. Horizontal paging follows the finger and settles over 380 ms using outgoing/incoming layers while the title bar remains mounted. Chat paging spans locally loaded photo/video messages, excluding expressions and other files. Paging to a video in chat, Safe or favorites requests the system player immediately; rejected native entry retains browser playback controls. Leaving stops playback and clears the source. Chat viewers have no download action and show favorite feedback; Safe viewers have no favorite action. Gallery loading uses a full-tile soft-glow skeleton until decoding completes, with reduced motion and visible retry feedback on failure.

Focus the chat composer and use **Cmd+V / Ctrl+V** or the native Paste action to send an image held in the clipboard. The browser must expose actual image data: copied HTML or a URL alone is not fetched as an image. Pasted files use the same encrypted original-byte upload path, keep the current text draft, and follow the same limits and compatibility checks as the image picker. Text-only paste works normally.

There is no nine-image limit on a selection. Chat groups originals in selected order into messages containing at most nine images and 256 MiB of original bytes each. A one-image group creates an ordinary image message; a larger group creates one `image-album` payload, encrypted outbox item, server sequence, and collage bubble. Each original keeps its own resumable encrypted chunks and integrity check. Sending an album requires every active device to have reported `image-album-v1` after opening the current version. Visible and near-visible media is verified and decrypted locally into inline previews; the service neither generates nor receives a plaintext thumbnail. Chat, gallery, and viewer reuse verified images during the unlocked session and use quiet loading placeholders. Locking clears decrypted caches and revokes their object URLs.

Tap an already revealed inline image or album cell to open the full-screen overlay at that item. Albums can be paged by touch, previous/next controls, or arrow keys, show the current position, and allow the current verified original to be downloaded. Dragging vertically at normal zoom moves the photo and releasing dismisses the viewer. Closing the overlay restores focus and the prior surface state; reduced-motion preferences bypass decorative transitions.

Chat videos show a blurred still preview and play control directly in the conversation. The first tap reveals the preview; tapping again directly requests Safari's native video player or the browser's video fullscreen mode for an already verified cached original. Done or Escape returns to the originating page. If the original still needs verification, fullscreen is unavailable or the browser rejects the request, native browser controls remain available in the page viewer. Native video zoom is owned by the system player and varies by browser; the page cannot guarantee a particular system gesture or fullscreen capability. Preview generation and playback require complete authenticated decryption and original length/digest verification. The preview-frame JPEG stays in memory and is never uploaded. An unsupported video format retains original-file download. Closing or paging the viewer stops playback and removes its source; privacy teardown also cancels pending media work, clears verified originals and preview caches, and revokes their object URLs.

The server never creates thumbnails and does not know the encrypted attachment type. The creator-only gallery decrypts message manifests locally, then downloads and decrypts originals when needed. Its 相册 contains chat photos and videos, including compatible older video file messages; ordinary chat files remain only in chat. Multiple direct uploads are processed in order as individual gallery-only images or files without chat bubbles. The invited participant has no gallery entry or gallery route, while photos and videos sent in chat remain visible in the conversation. Each original is limited to 256 MiB and 128 encrypted 2 MiB chunks. Upload reservations and completed chunk indexes are persisted, so selecting the same file after an interruption resumes without changing the blob ID, key, or IV prefix.

Native image pickers and microphone/camera prompts may own one bounded visible foreground focus handoff. A chooser that truly backgrounds, reaches `pagehide`/freeze, loses ownership, or remains unresolved after the short focus-return edge is invalidated: its hidden input is removed, late events are ignored, and the user must select again after unlocking. Upload never resumes from a detached chooser. Browser code cannot guarantee that an operating-system-owned picker or tooltip visually closes; input removal is best-effort cleanup. Exports, clipboard prompts, and confirmation dialogs immediately activate the white privacy curtain if they take browser focus. Mobile/tablet browsers and installed PWAs lock immediately on hidden visibility and use a 250 ms teardown debounce for ordinary blur. Ordinary desktop browsers instead show the cover and clear rendered history, media, transfers and sockets while retaining the unlocked session only in memory. Within 30 minutes of the last active in-app interaction, hold the bottom-right corner for one second or hold unmodified **F for two seconds** to resume without another device prompt. The cover hold plays a subtle ring and directly begins passkey verification; cancellation leaves a neutral Retry action without red error text. Cover activity and foreground return do not extend the deadline; expiry is checked before accepting new input and resuming even if background timers were suspended. Returning focus never opens the conversation by itself. Refresh, page close, freeze/BFCache restoration, explicit lock and expiry discard the retained session. Resuming reloads the authenticated saved vault; a changed or deleted vault falls back to verification. This convenience mode keeps decryption capability in page memory longer without adding key or plaintext persistence. Only a passkey prompt on the authentication gateway, including recovery and migration, has a bounded exception before a conversation or socket opens: WebAuthn settlement or 65 seconds ends it, and settlement while hidden locks. `pagehide`, explicit lock, and idle timeout always take precedence.

## Real-time calls

The chat header provides adjacent video-call and audio-call actions. The
FaceTime-style foreground interface supports answering, declining, muting,
camera switching and upgrading audio to video. Media uses browser-to-browser
WebRTC encryption, with optional self-hosted TURN relay. Calls require locally
verified MLS membership and device-signed identity attestations before media
negotiation; signaling is separately encrypted and signed. Covering or locking
the page stops capture, and there is no server recording or background calling.

See [CALLS.md](CALLS.md) for behavior, encryption boundaries, server sizing,
deployment configuration and verification. TURN is an optional deployment and
is not automatically enabled by building the application.

## Voice messages

When the text field is empty, hold the microphone to record and release to send.
The unavailable text-input surface is hidden while voice recording is active.
The microphone expands smoothly and follows only horizontal movement with
progressive resistance across a longer travel. Before the cancel threshold it
stays blue and says “松手发送”. Slide left by 220 CSS pixels to arm cancellation;
it turns red and says “松手取消”. Sliding back restores sending, and release commits
the displayed outcome. A cancel release cleans up capture and the draft before
the empty controls retract toward the right. Vertical
movement does not lock recording. A short tap or keyboard activation starts
hands-free recording. In the hands-free state,
use the large arrow to send or the button above it to pause. Pause opens a compact
waveform preview with delete, send, and a microphone to continue. The paused state
releases the microphone; continuing requests it again. Releasing a hold before
microphone permission is granted cancels it, including any late permission result. A voice message can be 0.5 seconds to
5 minutes long and is limited to 16 MiB. Reaching the limit stops recording and
offers a preview, never an automatic send. Denied, missing, busy, or timed-out
microphone requests have explicit recovery instructions.

Recording segments are decoded and joined entirely on the endpoint into a
portable 24 kHz mono 16-bit PCM WAV. This avoids cross-browser recorder-container
incompatibilities and makes a resumed recording a single message. At the maximum
duration, audio occupies about 14.4 MB before encryption; there is no server-side
transcoding or speech-recognition service. Recorded audio bytes, duration,
waveform, MIME type, filename, and generic reply references are encrypted. The
existing authenticated chunk pipeline verifies the attachment length and SHA-256
digest before exposing a local playback URL. Images retain their existing
original-byte behavior and voice messages do not appear in the image gallery.

Tap a voice bubble to download, decrypt, and play. Tap again to pause, or use its
waveform slider to seek. Starting a different voice message releases the previous
playback source. Voice can be replied to with the ordinary encrypted reply flow.
All active devices must report `voice-message-v1` before sending voice or replies
to voice; open the current version on every authorized device after upgrading.

Unsent audio and its upload retry plan live only in memory. A failed upload keeps
the same frozen draft for retry while the session remains open. Leaving chat,
locking, backgrounding, or hiding the page stops recording/playback, cancels
transfers, and discards that draft. After upload and durable encrypted outbox
commit, normal idempotent reconnect delivery applies. Already-sent voice remains
in history like text; there is no two-minute expiry, automatic transcript,
raise-to-listen sensor feature, or background recording.

Production uses `microphone=(self)` and `media-src 'self' blob:`. Recording needs
HTTPS (or localhost) and a compatible browser. Microphone requests time out after
30 seconds. Focus loss during permission UI locks immediately, as do hidden
visibility, `pagehide`, manual locking, and idle timeout. Late permission grants
are discarded and their microphone tracks stopped; recording can be started
again after unlocking.

## Reading position and presence

Quiet Room encrypts a per-device chat reading anchor in IndexedDB with the same local-record protection used for other vault-owned state. Returning from the gallery or viewer, or reopening an unlocked conversation, restores the anchored message and viewport offset instead of visibly scrolling from the beginning. An anchor that was already at the bottom stays at the bottom; sending keeps the newest message above the composer as its height or the keyboard changes. Unsent text is automatically saved as an encrypted local draft and restored after unlock. A successful send clears the submitted draft only after durable outbox storage and preserves any newer input.

If the composer is focused, opening the image picker preserves keyboard intent while the page remains unlocked; native focus loss takes precedence and shows the privacy curtain. Tapping outside the composer dismisses the keyboard. The layout follows `VisualViewport` changes so the input remains above the mobile soft keyboard. Page-level double-tap/gesture zoom is disabled, while image enlargement remains available through the purpose-built overlay viewer.

Messages use native document scrolling beneath the visual-viewport header and composer, allowing Safari to composite real conversation content behind its chrome. Individual controls use bounded blur, directional highlights and a crisp rim; reduced transparency and increased contrast use opaque surfaces. Keyboard space and encrypted reading anchors preserve the current position. Page navigation keeps layout positions stable; viewer, menu, and local-security notice transitions honor `prefers-reduced-motion`. A normal website cannot force Safari or Chrome's native bottom toolbar to be transparent: the transparent `theme-color`, edge-to-edge viewport, and installed-PWA manifest are best-effort integration hints, and browser-owned chrome may remain opaque.

The two online labels describe chat-page presence, not raw WebSocket connectivity. Each authenticated socket starts `away` and reports `chat` only while its device is on the chat surface; a participant role is online when any active device for that role reports `chat`. Moving to gallery, image viewer, or device management reports `away` without tearing down the socket. The client remembers the desired state and replays it after authentication on reconnect, while socket close, member changes, and ping/pong timeout remove stale presence. Presence exists only in server memory and is role-aggregated before broadcast. It is server-visible behavioral metadata and an advisory UI hint—not an end-to-end-verifiable identity, attention, or safety signal.

## Recovery and loss

Unlocked MLS devices automatically upload encrypted recovery checkpoints and encrypted local-history archives. “备份与恢复” shows status and retry controls. The current QR3 code is encrypted in the local vault and can be viewed after fresh passkey verification; users should also save it independently. Manual JSON export/import controls are removed.

On a replacement device, enter the QR3 code to locate the matching server backup and decrypt it locally. It contains the identity proof and encrypted archive keys, but never an active old MLS sending ratchet. Another trusted active device must be online to commit the signed MLS Remove+Add replacement; all other active devices must support `recovery-replace-v1`. The original device is fenced during the request and revoked at completion; unfinished requests expire within 15 minutes.

The replacement immediately generates a new code and rewraps every retained archive key. It persists the new request before upload and safely retries an identical request after acknowledgement loss. The server atomically retires old online retrieval only when the new recovery wrapper and archive transfer are saved. The user then receives the new code. Historical chat and creator gallery are restored only on an explicit request with this current code; gallery-only restoration includes photos and videos without adding old chat bubbles or reply previews. Original attachment ciphertext must still exist. Normal linked devices gain no pre-join history.

The administrator manages room/device/backup metadata on `admin.mijiu.cloud` after password + TOTP verification. Neither the administrator nor the server can retrieve recovery codes or decrypt these backups. Already copied old ciphertext can still be decrypted with its old code offline; rotation does not remotely erase it. Foreground backup may lag, and same-host storage is not disaster recovery. See [RECOVERY_BACKUPS.md](./RECOVERY_BACKUPS.md) for cryptographic construction, limits, failure handling, legacy-file migration and administration.

All local vault read/derive/write operations share the same physical `current` lifecycle lock, including unlock, import, migration, and deletion. The browser Web Locks API coordinates tabs when available, and an IndexedDB compare-and-swap rejects stale snapshots at commit. A stale window must lock and unlock again instead of overwriting a newer cryptographic state.

Legacy password vaults remain accessible: they are unlocked once with the original password and migrated directly to passkey-only version 3. A version-2 gesture-plus-passkey vault must accept its existing gesture one final time because that gesture is cryptographic input to the old wrapping key; after a successful unlock it is immediately rewrapped as passkey-only version 3.

If the usable local vault and recovery code are both lost, the server cannot reset the passkey binding or decrypt the history. That is an intended consequence of the server having no content keys.

Version-3 vault encryption still uses a random 256-bit master key and AES-GCM. Its wrapping key is derived from WebAuthn PRF output with HKDF-SHA-256 and is released only after authenticator user verification. Removing the gesture does not reduce the message cipher, MLS properties, key sizes, or at-rest encryption algorithm, but it deliberately removes one independent knowledge factor: local access now depends on the passkey plus the operating system's biometric/device-password policy. A syncable passkey can be available on another device in the same passkey ecosystem; use a compatible single-device authenticator or hardware security key when strict physical-device binding is required. Cloud recovery intentionally bypasses the original authenticator and uses a separate 256-bit random secret in the QR3 code. Protect the code as private-key material. The encrypted local copy helps only while that device can still unlock.

## Resource and operations controls

The server enforces request and WebSocket frame rates, per-room connection limits, message-count/message-byte quotas, a 256 MiB per-image limit, per-room/global blob reservations, and a maximum number of incomplete uploads. Expired add-device links and their never-approved pending members are removed automatically, so abandoned claims do not consume a device slot. Incomplete uploads and unclaimed one-member rooms without recovery backups are garbage-collected after 24 hours by default. `/api/health` verifies both SQLite access and data-directory readability/writability.

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
