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

- **等待服务器**: the payload is durably encrypted in the local outbox but has not yet been observed in the server sequence.
- **服务器已保存**: the signed ciphertext has a committed server sequence and can be recovered by reconnect synchronization.
- **对端已安全接收**: at least one active device owned by the other participant verified, decrypted, and durably stored the message, then signed a receipt bound to that exact message ID and sequence.
- Retries always reuse the original client message ID. After any disconnect, both message and receipt streams resume from the last locally durable contiguous sequence.
- A disconnected network cannot deliver instantly. The product must preserve the message locally, state the offline condition accurately, and converge automatically after connectivity returns.

## Creator Gallery

- Only the room creator sees the gallery entry and may enter the gallery or its image-detail views. The invited participant continues to see images that were sent in chat, but receives no gallery navigation or gallery-upload control.
- The creator gallery combines original images sent in chat with creator uploads made directly from the gallery. A direct gallery upload is represented separately and never appears as a chat bubble on either device.
- Both upload entry points preserve the exact original bytes and use the same encrypted, resumable chunk pipeline.

## Chat Images and Expressions

- A single selected image remains one encrypted image message. Selecting 2–9 images creates one encrypted album payload, one outbox item, one server-ordered message, and one chat bubble; it must never fan out into separate messages. The ordered album contains a separately encrypted and integrity-checked manifest for every original, and its aggregate original size is capped at 256 MiB to bound receiver resource use. The sender enables this payload only after every active device has reported `image-album-v1` through its authenticated current-version connection.
- Images in or near the visible chat viewport decrypt on the endpoint and render directly in their bubble without a second reveal tap. Once loaded, a single-image bubble fits the media dimensions without a large empty frame; albums use a compact, ordered collage.
- Tapping a chat image or an album cell opens an overlay viewer at that exact item. The viewer supports previous/next controls, horizontal paging, a position counter, current-original download, focus return, and reduced-motion behavior.
- The composer provides more than 100 emoji choices plus a bundled meme panel. Meme artwork is served from the local application package rather than a third-party runtime request. The bundled assets are unmodified OpenMoji 17.0.0 artwork under CC BY-SA 4.0 and retain the required OpenMoji/HfG Schwäbisch Gmünd attribution.
- Emoji and bundled memes can be added to or removed from a per-device favorites view. Favorites are encrypted in the local preference store under the unlocked vault key; they are neither plaintext preferences nor a server-synchronized profile.

## Conversation Continuity and Interaction

- Each device stores an encrypted local reading anchor containing the first relevant visible message, its viewport offset, and whether the user was pinned to the bottom. Entering chat, returning from gallery or image detail, and unlocking restore that position instead of replaying a visible scroll from the first message. Sending a new message intentionally moves the sender to the newest message.
- Opening the chat image picker while the composer has focus preserves the input focus and soft-keyboard intent. Opening or using the expression panel also keeps the composer focused; tapping outside the composer dismisses the keyboard and panel.
- Page-level double-tap, gesture, and modifier-wheel zoom are suppressed; media enlargement belongs to the dedicated image viewer. The page uses the visual viewport so the composer follows the mobile soft keyboard.
- Chat, gallery, and viewer headers and the chat composer bar use transparent page backgrounds. Page, gallery, viewer, menu, and local-security notices use measured enter/exit motion and honor `prefers-reduced-motion` so navigation does not flash or jump.
- A normal web page cannot force Safari or Chrome's browser-owned bottom toolbar to become transparent. `theme-color`, edge-to-edge layout, and installed-PWA display settings are best-effort hints; the browser and operating system retain final control over native chrome.

## Chat-page Presence

- “Online” means that at least one active device for that participant is currently on the chat page. Presence is aggregated by participant role across devices: one role remains online while any of its active sockets reports `chat`; gallery, image viewer, and device-management surfaces report `away`.
- Chat-page presence is independent from transport connectivity. Moving to another product surface updates presence without closing or reconnecting the WebSocket, while reconnect replays the desired surface state. Socket close, device removal, and ping/pong timeout provide stale-session cleanup.
- Presence is ephemeral server-memory behavioral metadata and is broadcast as a role-level snapshot. It is not persisted as conversation history, is not protected or authenticated by the end-to-end message protocol, and must never be presented as proof of identity, attention, physical presence, or cryptographic safety.

## Multi-device and Reply

- Every physical device has an independent identity key pair, MLS leaf/key package, local vault, passkey binding, and server access token. Private identity keys and existing MLS state are never copied through an add-device link.
- An existing same-participant device creates a ten-minute link. The claimant and authorizer must display the same six-digit safety code before the authorizer signs the MLS Add commit. A device is not active before that approval.
- The activation sequence is a hard history boundary: the new device starts from the Add welcome state, the service omits earlier messages and receipts, and application ciphertext from any prior MLS epoch is rejected. Pending stale-epoch messages are re-encrypted after the client processes the membership update.
- Device management lists both participants' active devices, allows removal only within the current participant's device set, prevents removal of the last device for a participant, and caps each participant at three active devices.
- A reply action is available by touch long-press, context menu, keyboard context-menu shortcut, and pointer shortcut. Its reference and generic kind label stay inside the encrypted message payload; content previews are derived only from this device's encrypted history. If the original is outside this device's local history boundary, the quote reports that the historical message is unavailable and does not copy pre-join content into the new reply.

## Local Unlock and Privacy Curtain

- New vaults use a random 256-bit master key wrapped by a key derived from a WebAuthn PRF-capable passkey. Setup and unlock use the operating system's biometric or device-password user verification; there is no application gesture for version-3 vaults.
- Both single-device and syncable passkeys are accepted. Backup eligibility is recorded at registration and verified on later assertions; it informs the security properties of the credential but does not make a valid credential fail setup.
- Legacy password vaults migrate to passkey-only version 3 after one successful password unlock. Existing version-2 gesture vaults require the old gesture once because it is part of the old key derivation, then are immediately rewrapped as passkey-only version 3.
- `visibilitychange` to hidden, window blur, `pagehide`, explicit lock, and idle timeout invoke the same idempotent lock behavior. Visible plaintext, sockets, object URLs, transfers, and decrypted session references are cleared immediately. Returning to the foreground never restores the conversation automatically.
- Two user-initiated system surfaces may temporarily suppress their own blur or hidden events: the image picker and a passkey prompt. The image-picker exception ends on selection, cancellation, or a bounded timeout. Passkey prompts occur only before a decrypted session is opened and end when the WebAuthn operation settles. Neither exception overrides `pagehide`, explicit lock, idle timeout, or a later unrelated blur/background event.

## Accessibility & Inclusion

Target WCAG 2.2 AA for the unlocked experience. Support keyboard navigation, visible focus, screen-reader labels, sufficient contrast, touch targets of at least 44 by 44 CSS pixels, reduced-motion preferences, clear non-color-only status communication, and resilient layouts from small mobile screens through desktop browsers.
