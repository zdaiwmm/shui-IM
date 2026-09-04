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
- **已保存** (accessible description: 服务器已保存): the signed ciphertext has a committed server sequence and can be recovered by reconnect synchronization.
- **已送达** (accessible description: 对端已安全接收): at least one active device owned by the other participant verified, decrypted, and durably stored the message, then signed a receipt bound to that exact message ID and sequence.
- Retries always reuse the original client message ID. After any disconnect, both message and receipt streams resume from the last locally durable contiguous sequence.
- A disconnected network cannot deliver instantly. The product must preserve the message locally, state the offline condition accurately, and converge automatically after connectivity returns.

## Creator Gallery

- Only the room creator sees the gallery entry and may enter the gallery or its image-detail views. The invited participant continues to see images that were sent in chat, but receives no gallery navigation or gallery-upload control.
- The creator gallery combines original images sent in chat with creator uploads made directly from the gallery. A direct gallery upload is represented separately and never appears as a chat bubble on either device.
- Both upload entry points preserve the exact original bytes and use the same encrypted, resumable chunk pipeline.

## Chat Images

- A single selected image remains one encrypted image message. Selecting 2–9 images creates one encrypted album payload, one outbox item, one server-ordered message, and one chat bubble; it must never fan out into separate messages. The ordered album contains a separately encrypted and integrity-checked manifest for every original, and its aggregate original size is capped at 256 MiB to bound receiver resource use. The sender enables this payload only after every active device has reported `image-album-v1` through its authenticated current-version connection.
- Images in or near the visible chat viewport decrypt on the endpoint and render directly in their bubble without a second reveal tap. Once loaded, a single-image bubble fits the media dimensions without a large empty frame; albums use a compact, ordered collage.
- Tapping a chat image or an album cell opens an overlay viewer at that exact item. The full-screen viewer fits each photo without cropping, animates from its thumbnail, and supports dragging vertically to shrink and dismiss the photo. Previous/next controls, horizontal paging, a position counter, current-original download, focus return, and reduced-motion behavior remain available.

## Voice Messages

- The empty text composer exposes a microphone action. Record, pause, preview, continue, discard, and send all happen inline, without navigating to a new page. Pause releases microphone access. Continuing records a new local segment and combines it into one message.
- Voice is limited to 0.5 seconds–5 minutes and 16 MiB. Browser recording segments are converted only on-device into portable 24 kHz mono PCM WAV. Reaching the limit pauses for review and never sends automatically. Real audio amplitudes produce the waveform.
- Audio bytes, metadata, duration, waveform, and reply references use the existing encrypted attachment and message pipeline. Playback begins only after authenticated decryption and full length/digest verification. Voice never enters the creator's image gallery.
- Only one voice message can load or play at a time. Playback controls include play/pause, duration, an accessible waveform seek slider, and explicit loading/error/retry states. Messages are retained like ordinary chat; automatic transcription, automatic expiry, raise-to-listen, and background recording are outside this version.
- All active devices must confirm `voice-message-v1` before sending a voice message or a reply referencing voice. This gate does not claim that capabilities are end-to-end authenticated.
- Unsent voice drafts and upload retry plans are memory-only. Failed sends preserve a frozen draft for same-session retry. Navigating away, locking, hiding, or backgrounding stops microphone/playback and clears unsent drafts; only completed encrypted-outbox commits receive normal durable retry semantics.
- A user-initiated microphone permission prompt suppresses only blur events for at most 30 seconds. It never suppresses hidden visibility, pagehide, explicit lock, or idle lock. Late permission grants must immediately stop their tracks and never revive a locked or cancelled recorder.

## Conversation Continuity and Interaction

- Each device stores an encrypted local reading anchor containing the first relevant visible message, its viewport offset, and whether the user was pinned to the bottom. Entering chat, returning from gallery or image detail, and unlocking restore that position instead of replaying a visible scroll from the first message. Sending a new message intentionally moves the sender to the newest message.
- Opening the chat image picker while the composer has focus preserves the input focus and soft-keyboard intent. Tapping outside the composer dismisses the keyboard. Dedicated emoji, meme, and expression-favorites controls are not provided.
- Page-level double-tap, gesture, and modifier-wheel zoom are suppressed; media enlargement belongs to the dedicated image viewer. The page uses the visual viewport so the composer follows the mobile soft keyboard.
- Chat messages scroll underneath the top header and bottom composer, whose translucent gradient masks keep controls legible while revealing the conversation below. Pages enter without translating their layout; viewer, menu, and local-security notices honor `prefers-reduced-motion`.
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
- A 500 ms long press opens the message menu with reply, copy, and selective text-copy actions. Native callout/selection is suppressed on chat bubbles; the separate copy sheet allows selecting a substring. Supported devices receive brief vibration feedback. Context-menu and keyboard shortcuts remain available. Its reference and generic kind label stay inside the encrypted message payload; content previews are derived only from this device's encrypted history. If the original is outside this device's local history boundary, the quote reports that the historical message is unavailable and does not copy pre-join content into the new reply.

## Local Unlock and Privacy Curtain

- New vaults use a random 256-bit master key wrapped by a key derived from a WebAuthn PRF-capable passkey. Setup and unlock use the operating system's biometric or device-password user verification; there is no application gesture for version-3 vaults.
- Both single-device and syncable passkeys are accepted. Backup eligibility is recorded at registration and verified on later assertions; it informs the security properties of the credential but does not make a valid credential fail setup.
- Legacy password vaults migrate to passkey-only version 3 after one successful password unlock. Existing version-2 gesture vaults require the old gesture once because it is part of the old key derivation, then are immediately rewrapped as passkey-only version 3.
- `visibilitychange` to hidden, window blur, `pagehide`, explicit lock, and idle timeout invoke the same idempotent lock behavior. Visible plaintext, sockets, object URLs, transfers, and decrypted session references are cleared immediately. Returning to the foreground never restores the conversation automatically.
- Two user-initiated system surfaces may temporarily suppress their own blur or hidden events: the image picker and a passkey prompt. The image-picker exception ends on selection, cancellation, or a bounded timeout. Passkey prompts are exempt only on the authentication gateway before a conversation or socket opens, including recovery and migration gateways that hold imported key material. The exception ends when WebAuthn settles or after 65 seconds; settling while hidden locks immediately. Neither exception overrides `pagehide`, explicit lock, idle timeout, or a later unrelated blur/background event.

## Recovery Setup

- An unconfirmed recovery setup appears as a compact pinned-message reminder below the chat header. Dismissing it records an encrypted per-device preference; exporting remains available in the menu.
- Preparing recovery immediately displays the independent recovery code. The user saves the encrypted package, then confirms both parts have been stored separately before the vault records completed recovery setup. Download initiation alone does not count as completion.

- MLS recovery uses the old package only to prove ownership and authorize a fresh device identity. Another active, trusted device must be online to commit the replacement; every other active device must support the recovery protocol. The original device is temporarily fenced during the request and permanently revoked when replacement succeeds.
- Recovery starts at a new message/receipt boundary. It does not import old IndexedDB history or reuse checkpoint sending keys. The replacement receives new messages, and must save a new recovery package and code. A pending request expires after at most 15 minutes; an expired request releases the original device and must be restarted.
- Full local history remains available through bounded paging: a reply can find its exact older local message outside the currently loaded page, and the creator gallery offers earlier locally saved media separately from the chat window.

## Accessibility & Inclusion

Target WCAG 2.2 AA for the unlocked experience. Support keyboard navigation, visible focus, screen-reader labels, sufficient contrast, touch targets of at least 44 by 44 CSS pixels, reduced-motion preferences, clear non-color-only status communication, and resilient layouts from small mobile screens through desktop browsers.
