# High-security public release gate

The repository now contains the requested architecture, but it must not yet be represented as an independently audited high-security service. “Uses a mature standard” and “this implementation has been independently validated” are different claims.

## Blocking gates

All of the following are required before public high-security launch:

1. Commission an independent cryptographic review of the MLS integration, identity-to-key-package binding, state serialization, welcome-message authentication, replay behavior, and atomic ratchet persistence. The selected `ts-mls` package implements RFC 9420 but explicitly states that it has not undergone a formal security audit.
2. Commission an application-security review covering invitation capabilities, WebAuthn PRF use, IndexedDB transactions, recovery-code handling, service-worker updates, CSP, WebSocket authentication, quotas, attachments, push endpoints, and operational logging.
3. Add a signed/reproducible client release channel or a separately trusted installed client. HTTPS and CSP do not stop a malicious or compromised origin from serving JavaScript that steals plaintext after unlock.
4. Run cross-browser/device validation for the exact support matrix, covering both syncable and single-device WebAuthn PRF credentials. Document that syncable passkeys do not provide strict physical-device binding; deployments that require it must mandate a compatible single-device authenticator or hardware security key. Unsupported authenticators must fail closed with a documented hardware-key path. Include real-device iOS Safari/Chrome and installed-PWA validation for the soft keyboard, image picker, album/viewer paging, reading-anchor restoration, safe areas, double-tap behavior, page motion, reduced motion, and transparent in-page bars. A normal website cannot force browser-owned native toolbars transparent; `theme-color` and PWA display settings are best effort.
5. Configure off-host immutable/versioned backups, backup-age/capacity alerts, and complete a timed restore drill. A local Compose backup directory alone does not satisfy disaster recovery.
6. Independently audit the implemented device authorization and replacement flow: short-lived claim capability, six-digit safety-code comparison, per-device access tokens, signed MLS Add/Remove commits, activation history boundaries, stale-epoch message rejection/re-encryption, live-session closure, and push-token revocation. Checkpoint restore must still be used only after the source copy is offline because two copies of one restored physical-device identity are intentionally unsupported.
7. Configure VAPID secrets, test Android and installed iOS PWA delivery, verify that push requests remain payload-free, and document notification metadata leakage.
8. Define and load-test measurable availability/latency SLOs from each intended user region. Local 53 ms end-to-end tests prove a regression budget, not Internet-wide instant delivery.
9. Complete abuse controls and public-service operations: admission policy, capacity budgets, DDoS/WAF strategy, vulnerability intake, incident response, secret rotation, dependency/container scanning, and on-call ownership.
10. Complete a privacy and spoofing review of chat-page presence. Confirm per-socket `chat|away` state remains process-memory-only, proxy/application logs do not accidentally retain it beyond the published policy, multi-device role aggregation cannot be confused with a verified person, and product copy never promotes server-asserted presence to an E2E identity, attention, delivery, or safety signal.
11. Complete the distribution-license review for bundled OpenMoji 17.0.0 meme assets. Preserve the pinned source, CC BY-SA 4.0 license, OpenMoji/HfG Schwäbisch Gmünd attribution, and applicable share-alike notices in every web/container/PWA artifact; confirm CSP and runtime traces make no third-party meme request.

## Current acceptance evidence

- RFC 9420 MLS group creation, authenticated welcome, bidirectional application messages, independent third-device Add/welcome, pre-join history rejection, membership-epoch advancement, and replay rejection are covered by automated tests.
- The real-browser suite covers WebAuthn PRF vault binding without a gesture for new vaults, two-participant MLS setup, encrypted replies, signed delivery receipts, reconnect/outbox behavior, encrypted attachment transfer, recovery file plus independent recovery code, new-device rebinding, legacy vault migration, and mobile accessibility assertions.
- Strict payload validation supports one encrypted 2–9-image album message with ordered unique manifests. Browser assertions cover one-bubble rendering, viewport-triggered endpoint decryption, overlay paging, encrypted local reading-anchor restoration, and encrypted emoji/meme favorites.
- The expression panel includes more than 100 emoji choices and locally packaged, attributed OpenMoji 17.0.0 meme assets; meme sends reuse the encrypted original-image pipeline rather than disclosing a third-party URL.
- Chat-page presence is implemented independently from transport connection state: clients replay desired `chat|away` after authentication, the service aggregates any active device by role, and close, membership changes, and control-frame ping/pong timeout clear stale state. Automated API/service coverage treats it as ephemeral metadata, not MLS-authenticated content.
- Browser assertions cover composer focus retention for image/expression controls, outside-tap dismissal, visual-viewport positioning, transparent application-owned bars, page-level double-tap suppression, and bounded/reduced motion. Real-device iOS acceptance remains a blocking gate, especially for browser-owned chrome.
- MLS state and the already-encrypted outbox envelope are committed in one IndexedDB transaction before network transmission. Retries reuse identical ciphertext rather than advancing the ratchet again.
- Incoming MLS state, decrypted local history, and the pending signed receipt are committed together before the receipt is sent.
- Online SQLite/WAL backup, completed-blob consistency, checksum verification, tamper refusal, and restore to an empty target are covered by automated tests.
- Background pushes carry no application payload. They exclude the sender and cannot mark a message delivered.

## Claims that remain prohibited

Do not claim “absolute security,” “unhackable,” “zero metadata,” “guaranteed instant delivery,” “Signal-compatible,” “independently audited,” or “post-compromise recovery” on the basis of the current code. Do not claim that the server cannot observe whether a device reports the chat page, that an online label proves the person is present or cryptographically authenticated, or that Safari/Chrome native toolbars are guaranteed transparent. MLS application-message ratchets provide forward secrecy; recovery from a live endpoint compromise additionally depends on authenticated epoch updates and a clean endpoint, and that full operational recovery procedure is not yet implemented or audited here.
