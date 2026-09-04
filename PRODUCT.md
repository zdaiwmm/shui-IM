# Product

## Register

product

## Users

Two trusted people use the product from mobile or desktop browsers and installed PWAs. Each person may authorize up to three independently keyed devices. They need a quiet private channel for exchanging text and original-quality images without creating accounts. They expect the interface to stay concealed until intentionally unlocked, and they accept that losing both the local vault and recovery package makes history unrecoverable.

## Product Purpose

Provide a small, dependable one-to-one encrypted chat whose cloud service can order, relay, and retain ciphertext but cannot read message or image contents. Success means all authorized devices exchange new messages in a deterministic order, reconnect without gaps or duplicates, review only their locally available history and images, and verify that downloaded image bytes match the original upload.

## Brand Personality

Quiet, private, dependable. The product should feel composed and discreet, with clear system feedback and no security theater in its unlocked interface.

## Anti-references

Do not resemble a neon cyber-security dashboard, hacker terminal, crypto trading product, social feed, or decorative glassmorphism showcase. Avoid theatrical lock imagery, fear-based copy, excessive cards, gratuitous animation, and unfamiliar controls where platform conventions work better.

## Design Principles

1. Privacy is structural: sensitive content and keys stay on the endpoint, while visual concealment is treated only as a privacy curtain.
2. Calm before cleverness: standard controls, concise copy, and restrained feedback keep attention on the conversation.
3. Make system truth visible: pending, delivered, disconnected, locked, failed, and recovery states must be unambiguous.
4. Preserve originals: uploaded image bytes remain unchanged through encryption, storage, download, and decryption.
5. Fail closed: authentication, decryption, integrity, version, and sequence errors never silently downgrade or display partial content.

## Delivery Semantics

- **等待发送** (accessible description: 等待服务器): the payload is durably encrypted in the local outbox but has not yet been observed in the server sequence.
- **单柄对勾 / 已发送** (accessible description: 服务器已保存): the signed ciphertext has a committed server sequence and can be recovered by reconnect synchronization.
- **双柄对勾 / 已送达** (accessible description: 对端已安全接收): at least one active device owned by the other participant verified, decrypted, and durably stored the message, then signed a receipt bound to that exact message ID and sequence.
- Retries always reuse the original client message ID. After any disconnect, both message and receipt streams resume from the last locally durable contiguous sequence.
- A disconnected network cannot deliver instantly. The product must preserve the message locally, state the offline condition accurately, and converge automatically after connectivity returns.

## Creator Gallery

- Only the room creator sees the gallery entry and may enter the gallery or its image-detail views. The invited participant continues to see images that were sent in chat, but receives no gallery navigation or gallery-upload control.
- The creator gallery combines original images sent in chat with creator uploads made directly from the gallery. A direct gallery upload is represented separately and never appears as a chat bubble on either device.
- Both upload entry points support multiple selected files, preserve the exact original bytes, and use the same encrypted, resumable chunk pipeline. Gallery selections upload in order as individual gallery-only images.

## Chat Images

- Pasting actual image files in the chat composer (Cmd/Ctrl+V or the native Paste action) uses the same original-byte encrypted upload path, grouping and capability gates. Image data takes precedence over accompanying text/HTML while preserving the current text draft; text-only paste stays native. Clipboard content is only read from the paste event. A busy upload asks the user to paste again; a covered, locked or detached input cannot start an upload.
- There is no nine-image limit on a user selection. Chat divides selected originals in order into messages containing at most nine images and at most 256 MiB of original bytes each. A one-image group uses an ordinary image message; each larger group uses one encrypted album payload, outbox item, server sequence, and chat bubble. Every original has its own encrypted, integrity-checked manifest. Albums require every active device to report `image-album-v1` through its authenticated current-version connection.
- Images in or near the visible chat viewport decrypt on the endpoint and render directly in their bubble without a second reveal tap. Once loaded, a single-image bubble fits the media dimensions without a large empty frame; albums use a compact, ordered collage.
- Chat, gallery, and viewer reuse verified image caches within the unlocked session. Initial loading uses quiet placeholders with accessible status text; failures retain a visible retry action. Locking clears decrypted image caches and revokes their object URLs.
- Tapping a chat image or an album cell opens an overlay viewer at that exact item. The full-screen viewer fits each photo without cropping, animates from its thumbnail, and supports dragging vertically to shrink and dismiss the photo. Previous/next controls, horizontal paging, a position counter, current-original download, focus return, and reduced-motion behavior remain available.

## Voice Messages

- The empty text composer exposes a microphone action. Record, pause, preview, continue, discard, and send all happen inline, without navigating to a new page. Pause releases microphone access. Continuing records a new local segment and combines it into one message.
- Voice is limited to 0.5 seconds–5 minutes and 16 MiB. Browser recording segments are converted only on-device into portable 24 kHz mono PCM WAV. Reaching the limit pauses for review and never sends automatically. Real audio amplitudes produce the waveform.
- Audio bytes, metadata, duration, waveform, and reply references use the existing encrypted attachment and message pipeline. Playback begins only after authenticated decryption and full length/digest verification. Voice never enters the creator's image gallery.
- Only one voice message can load or play at a time. Playback controls include play/pause, duration, an accessible waveform seek slider, and explicit loading/error/retry states. Messages are retained like ordinary chat; automatic transcription, automatic expiry, raise-to-listen, and background recording are outside this version.
- All active devices must confirm `voice-message-v1` before sending a voice message or a reply referencing voice. This gate does not claim that capabilities are end-to-end authenticated.
- Unsent voice drafts and upload retry plans are memory-only. Failed sends preserve a frozen draft for same-session retry. Navigating away, locking, hiding, or backgrounding stops microphone/playback and clears unsent drafts; only completed encrypted-outbox commits receive normal durable retry semantics.
- A microphone permission request times out after 30 seconds and receives no privacy-lock exemption. Losing focus during the prompt locks immediately. Late permission grants must immediately stop their tracks and never revive a locked or cancelled recorder.

## Conversation Continuity and Interaction

- Each device stores an encrypted local reading anchor containing the first relevant visible message, its viewport offset, and whether the user was pinned to the bottom. Entering chat, returning from gallery or image detail, and unlocking restore that position instead of replaying a visible scroll from the first message. Sending a new message keeps the newest message above the composer as its height or the keyboard changes.
- Unsent text is saved automatically as an encrypted local draft and restored after unlocking. Sending clears only the submitted draft after durable outbox storage; newer input remains intact.
- Opening the chat image picker preserves keyboard intent only while the page remains unlocked; native focus loss takes precedence and shows the privacy curtain. Tapping outside the composer dismisses the keyboard. Dedicated emoji, meme, and expression-favorites controls are not provided.
- Page-level double-tap, gesture, and modifier-wheel zoom are suppressed; media enlargement belongs to the dedicated image viewer. The page uses the visual viewport so the composer follows the mobile soft keyboard.
- Chat uses native document scrolling so real message content can extend behind Safari chrome. The header and composer stay attached to the visual viewport, with safe-area padding and keyboard space. Each floating control samples the conversation through a bounded glass filter, directional sheen and a crisp light/dark rim; the edge wash has no additional blur. Reduced transparency/high contrast uses opaque controls. Pages enter without translating their layout; viewer, menu, and local-security notices honor `prefers-reduced-motion`.
- A normal web page cannot force Safari or Chrome's browser-owned bottom toolbar to become transparent. `theme-color`, edge-to-edge layout, and installed-PWA display settings are best-effort hints; the browser and operating system retain final control over native chrome.

## Chat-page Presence

- “Online” means that at least one active device for that participant is currently on the chat page. Presence is aggregated by participant role across devices: one role remains online while any of its active sockets reports `chat`; gallery, image viewer, and device-management surfaces report `away`.
- Self presence is shown at the left of the chat header. The centered peer title shows “对方” with a status icon on its first line, then “在线” or the elapsed time since the last online state on its second line. The last-online timestamp stays in server memory and is unavailable after a server restart.
- Chat-page presence is independent from transport connectivity. Moving to another product surface updates presence without closing or reconnecting the WebSocket, while reconnect replays the desired surface state. Socket close, device removal, and ping/pong timeout provide stale-session cleanup.
- Presence is ephemeral server-memory behavioral metadata and is broadcast as a role-level snapshot. It is not persisted as conversation history, is not protected or authenticated by the end-to-end message protocol, and must never be presented as proof of identity, attention, physical presence, or cryptographic safety.

## Multi-device and Reply

- Every physical device has an independent identity key pair, MLS leaf/key package, local vault, passkey binding, and server access token. Private identity keys and existing MLS state are never copied through an add-device link.
- An existing same-participant device creates a ten-minute link. The claimant and authorizer must display the same six-digit safety code before the authorizer signs the MLS Add commit. A device is not active before that approval.
- The activation sequence is a hard history boundary: the new device starts from the Add welcome state, the service omits earlier messages and receipts, and application ciphertext from any prior MLS epoch is rejected. Pending stale-epoch messages are re-encrypted after the client processes the membership update.
- Device management lists both participants' active devices, allows removal only within the current participant's device set, prevents removal of the last device for a participant, and caps each participant at three active devices.
- A 500 ms long press highlights the source bubble above a dimmed background and opens a six-emoji reaction bar with a compact vertical copy/select/reply menu. Selecting text activates native selection directly in the original bubble; there is no separate copy sheet. The browser controls native handles and edit-toolbar presentation. Supported devices receive brief vibration feedback. Context-menu and keyboard shortcuts remain available.
- Each participant can add, replace, or remove one reaction per confirmed chat message. The emoji, removal, and exact target stay inside encrypted message history and the durable outbox; reactions project into corner badges and never become chat rows. All active devices must advertise `message-reactions-v1`. Target validation and local history boundaries also apply after reopening.
- Reply references use a compact, low-contrast local preview. The reference and generic kind label stay inside the encrypted message payload; content previews are derived only from this device's encrypted history. If the original is outside this device's local history boundary, the quote reports that the historical message is unavailable and does not copy pre-join content into the new reply.

## Local Unlock and Privacy Curtain

- New vaults use a random 256-bit master key wrapped by a key derived from a WebAuthn PRF-capable passkey. Setup and unlock use the operating system's biometric or device-password user verification; entering the version-3 unlock gateway automatically starts verification, with manual retry after cancellation or failure.
- Both single-device and syncable passkeys are accepted. Backup eligibility is recorded at registration and verified on later assertions; it informs the security properties of the credential but does not make a valid credential fail setup.
- Legacy password vaults migrate to passkey-only version 3 after one successful password unlock. Existing version-2 gesture vaults require the old gesture once because it is part of the old key derivation, then are immediately rewrapped as passkey-only version 3.
- A browser-load-failure cover retains the blank bottom-right long-press entry. A permanently mounted opaque curtain synchronously conceals the app on every blur and hidden-visibility event, before cleanup and without an animation frame or transition. Hidden visibility, `pagehide`, `freeze`, persisted `pageshow`, explicit lock, and idle timeout invoke the same immediate, idempotent lock. Focus loss during a native picker, export, microphone, clipboard, or confirmation surface also locks immediately. Ordinary window blur defers session teardown for 250 ms; quick focus recovery can cancel that teardown. Locking clears visible plaintext, sockets, object URLs, transfers, and decrypted session references. A locked conversation never opens automatically on foreground return. The page cannot invalidate a thumbnail already cached by the browser or operating system.
- `ERR_CONNECTION_CLOSED` is followed by the device's unread incoming-chat count in the same monospace style with slightly stronger color. A restricted observer token can fetch only this number while the vault is locked. The server stores its hash, a monotonic per-device read cursor, and a countable-message flag; own-role messages, gallery uploads, and reactions do not count. Visible chat messages advance the read cursor. Foreground/online return refreshes the count, with 15-second polling while visible; offline cover keeps the last confirmed count. This is behavioral metadata, separate from cryptographic delivery receipts.
- A native image chooser retains its hidden input and selected files in memory until the same room and device unlock, then resumes the original chat or gallery destination. Cancellation, explicit lock, and `pagehide` discard the pending selection; no upload runs while covered.
- Only gateway passkey prompts may suppress their own blur or hidden events before a conversation or socket opens, including recovery and migration gateways. This exception ends when WebAuthn settles or after 65 seconds; settling while hidden locks immediately. It never overrides `pagehide`, explicit lock, or idle timeout.

## Recovery Setup

- An unconfirmed recovery setup appears as a compact pinned-message reminder below the chat header. Dismissing it records an encrypted per-device preference; exporting remains available in the menu.
- Preparing recovery immediately displays the independent recovery code. The user saves the encrypted package, then confirms both parts have been stored separately before the vault records completed recovery setup. Download initiation alone does not count as completion.

- MLS recovery uses the old package only to prove ownership and authorize a fresh device identity. Another active, trusted device must be online to commit the replacement; every other active device must support the recovery protocol. The original device is temporarily fenced during the request and permanently revoked when replacement succeeds.
- Recovery starts at a new message/receipt boundary. It does not import old IndexedDB history or reuse checkpoint sending keys. The replacement receives new messages, and must save a new recovery package and code. A pending request expires after at most 15 minutes; an expired request releases the original device and must be restarted.
- Full local history remains available through bounded paging: a reply can find its exact older local message outside the currently loaded page, and the creator gallery offers earlier locally saved media separately from the chat window.

## Accessibility & Inclusion

Target WCAG 2.2 AA for the unlocked experience. Support keyboard navigation, visible focus, screen-reader labels, sufficient contrast, touch targets of at least 44 by 44 CSS pixels, reduced-motion preferences, clear non-color-only status communication, and resilient layouts from small mobile screens through desktop browsers.
