# High-security public release gate

The repository now contains the requested architecture, but it must not yet be represented as an independently audited high-security service. “Uses a mature standard” and “this implementation has been independently validated” are different claims.

## Blocking gates

All of the following are required before public high-security launch:

1. Commission an independent cryptographic review of the MLS integration, identity-to-key-package binding, state serialization, welcome-message authentication, replay behavior, and atomic ratchet persistence. The selected `ts-mls` package implements RFC 9420 but explicitly states that it has not undergone a formal security audit.
2. Commission an application-security review covering invitation capabilities, WebAuthn PRF use, IndexedDB transactions, recovery-code handling, service-worker updates, CSP, WebSocket authentication, quotas, attachments, push endpoints, and operational logging.
3. Add a signed/reproducible client release channel or a separately trusted installed client. HTTPS and CSP do not stop a malicious or compromised origin from serving JavaScript that steals plaintext after unlock.
4. Run cross-browser/device validation for the exact support matrix. Strict device binding rejects backup-eligible/syncable passkeys; unsupported authenticators must fail closed with a documented hardware-key path.
5. Configure off-host immutable/versioned backups, backup-age/capacity alerts, and complete a timed restore drill. A local Compose backup directory alone does not satisfy disaster recovery.
6. Implement and audit an authenticated device-replacement flow that revokes the old device session and advances the MLS epoch before treating recovery as safe after device loss or compromise. The current checkpoint restore must only be used after the source copy is offline; concurrent original and restored copies are intentionally unsupported.
7. Configure VAPID secrets, test Android and installed iOS PWA delivery, verify that push requests remain payload-free, and document notification metadata leakage.
8. Define and load-test measurable availability/latency SLOs from each intended user region. Local 53 ms end-to-end tests prove a regression budget, not Internet-wide instant delivery.
9. Complete abuse controls and public-service operations: admission policy, capacity budgets, DDoS/WAF strategy, vulnerability intake, incident response, secret rotation, dependency/container scanning, and on-call ownership.

## Current acceptance evidence

- RFC 9420 MLS two-member group creation, authenticated welcome, bidirectional application messages, state advancement, and replay rejection are covered by automated tests.
- The real-browser suite covers strict WebAuthn PRF device binding, gesture plus device verification, two-device MLS setup, signed delivery receipts, reconnect/outbox behavior, encrypted attachment transfer, recovery file plus independent recovery code, new-device rebinding, legacy vault migration, and mobile accessibility assertions.
- MLS state and the already-encrypted outbox envelope are committed in one IndexedDB transaction before network transmission. Retries reuse identical ciphertext rather than advancing the ratchet again.
- Incoming MLS state, decrypted local history, and the pending signed receipt are committed together before the receipt is sent.
- Online SQLite/WAL backup, completed-blob consistency, checksum verification, tamper refusal, and restore to an empty target are covered by automated tests.
- Background pushes carry no application payload. They exclude the sender and cannot mark a message delivered.

## Claims that remain prohibited

Do not claim “absolute security,” “unhackable,” “zero metadata,” “guaranteed instant delivery,” “Signal-compatible,” “independently audited,” or “post-compromise recovery” on the basis of the current code. MLS application-message ratchets provide forward secrecy; recovery from a live endpoint compromise additionally depends on authenticated epoch updates and a clean endpoint, and that full operational recovery procedure is not yet implemented or audited here.
