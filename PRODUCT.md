# Product

## Register

product

## Users

Two trusted people use the product from their own mobile-first browser or installed PWA. They need a quiet private channel for exchanging text and original-quality images without creating accounts. They expect the interface to stay concealed until intentionally unlocked, and they accept that losing both the local vault and recovery package makes history unrecoverable.

## Product Purpose

Provide a small, dependable one-to-one encrypted chat whose cloud service can order, relay, and retain ciphertext but cannot read message or image contents. Success means the two enrolled devices exchange messages in a deterministic order, reconnect without gaps or duplicates, review locally decrypted history and images, and verify that downloaded image bytes match the original upload.

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
- **对端已安全接收**: the other enrolled device verified, decrypted, and durably stored the message, then signed a receipt bound to that exact message ID and sequence.
- Retries always reuse the original client message ID. After any disconnect, both message and receipt streams resume from the last locally durable contiguous sequence.
- A disconnected network cannot deliver instantly. The product must preserve the message locally, state the offline condition accurately, and converge automatically after connectivity returns.

## Creator Gallery

- Only the room creator sees the gallery entry and may enter the gallery or its image-detail views. The invited participant continues to see images that were sent in chat, but receives no gallery navigation or gallery-upload control.
- The creator gallery combines original images sent in chat with creator uploads made directly from the gallery. A direct gallery upload is represented separately and never appears as a chat bubble on either device.
- Both upload entry points preserve the exact original bytes and use the same encrypted, resumable chunk pipeline.

## Local Unlock and Privacy Curtain

- New vaults use a 3 by 3 gesture drawn twice during setup and once during unlock, plus a WebAuthn PRF-capable passkey. Four points is the minimum and six or more are recommended. The gesture is a convenience tradeoff, not a claim of stronger security than a strong password.
- Both single-device and syncable passkeys are accepted. Backup eligibility is recorded at registration and verified on later assertions; it informs the security properties of the credential but does not make a valid credential fail setup.
- Legacy password vaults remain accessible and are re-encrypted under a confirmed gesture with a fresh salt immediately after one successful legacy unlock.
- `visibilitychange` to hidden, window blur, `pagehide`, explicit lock, and idle timeout invoke the same idempotent lock behavior. Visible plaintext, sockets, object URLs, transfers, and decrypted session references are cleared immediately. Returning to the foreground never restores the conversation automatically.
- Two user-initiated system surfaces may temporarily suppress their own blur or hidden events: the image picker and a passkey prompt. The image-picker exception ends on selection, cancellation, or a bounded timeout. Passkey prompts occur only before a decrypted session is opened and end when the WebAuthn operation settles. Neither exception overrides `pagehide`, explicit lock, idle timeout, or a later unrelated blur/background event.

## Accessibility & Inclusion

Target WCAG 2.2 AA for the unlocked experience. Support keyboard navigation, visible focus, screen-reader labels, sufficient contrast, touch targets of at least 44 by 44 CSS pixels, reduced-motion preferences, clear non-color-only status communication, and resilient layouts from small mobile screens through desktop browsers.
