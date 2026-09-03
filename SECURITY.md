# Security model

Quiet Room is a two-device encrypted chat. The browser encrypts message and image content before upload. The Node service stores public device keys and MLS key packages, an opaque signed MLS welcome, opaque message envelopes, signed delivery receipts, ordering metadata, push subscriptions, and encrypted image chunks. It does not receive local gestures, WebAuthn PRF output, vault master keys, recovery codes, pairing secrets, MLS private state, plaintext messages, filenames, MIME types, or original image hashes.

## Cryptographic construction

- Each device generates separate P-256 ECDH and ECDSA identity key pairs in Web Crypto and an RFC 9420 MLS key package using `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`.
- The MLS credential embeds the device ID and MLS signature public key. The device's P-256 identity key signs that binding; clients validate it against the public bundle authenticated by the invitation proof.
- The one-time invite pins the creator public-key fingerprint and carries a random pairing secret in the URL fragment.
- The joining device authenticates its public bundle with HMAC-SHA-256 under that pairing secret.
- New rooms create a two-member RFC 9420 MLS group. The creator signs the opaque welcome envelope with its P-256 identity key. MLS advances the application-message secret tree on every message, providing forward secrecy for deleted message generations.
- The sender additionally signs each complete outer envelope with ECDSA P-256/SHA-256. The server verifies this signature before persistence, and recipients verify it again before MLS processing.
- Legacy rooms retain the original per-message random AES-256-GCM content key and ephemeral P-256 ECDH wrapping construction. They do not acquire forward secrecy automatically and must be replaced with a new room.
- After a recipient verifies, decrypts, and persists a message, it signs a receipt that binds the room ID, message ID, server sequence, receiver device ID, and receipt time. Only that receipt promotes the sender UI from server-stored to peer-delivered.
- Images are encrypted in 2 MiB AES-256-GCM chunks. A unique eight-byte random prefix plus a four-byte chunk counter forms each nonce. The authenticated data binds the blob ID, index, total chunk count, and original size.
- The encrypted image manifest contains the file key and SHA-256 digest. A receiver accepts a reconstructed image only when its exact byte length and digest match.
- A random 256-bit AES-GCM master key encrypts the local vault, history, outgoing-message queue, pending-receipt queue, and upload-resume plans. A key-encryption key is derived with HKDF-SHA-256 from WebAuthn PRF output and Argon2id-hardened gesture bytes, then wraps the master key. Strict mode rejects WebAuthn credentials carrying the backup-eligible flag. Gesture paths, PRF output, and derived keys are not persisted.
- Recovery wraps the master key to a separate random 256-bit recovery code and stores only the encrypted wrapper beside the encrypted vault payload. Recovery creates a new device-bound wrapper before the conversation opens.

## What this protects

- Database, filesystem, object-volume, and backup disclosure does not reveal message or image contents without an endpoint key.
- The service cannot forge a valid participant message or silently modify ciphertext.
- A third device with only the room ID cannot join or decrypt.
- Client message IDs make retries idempotent. Transactional room sequence numbers define the display order.
- An outgoing payload is encrypted into IndexedDB before its first network send. Reconnect and acknowledgement-loss retries retain the same client message ID, while a server uniqueness constraint prevents duplicate commits.
- A failed or interrupted join is retried with the same locally persisted device identity, so a committed server join cannot strand the second slot merely because the response was lost.
- Losing page visibility, window focus, or the page itself immediately replaces rendered content with the white privacy curtain, closes the socket, aborts file transfers, revokes object URLs, and releases in-memory application references to the decrypted session.

## Explicit limitations

New rooms use the standardized RFC 9420 MLS protocol, but the selected browser-capable `ts-mls` implementation states that it has not undergone a formal security audit. The integration must pass independent cryptographic review before high-risk production claims. Legacy rooms have no forward secrecy.

Per-message MLS secret-tree advancement provides forward secrecy for deleted generations. Full post-compromise recovery requires authenticated epoch updates after the attacker loses endpoint access, clean endpoints, and an audited incident procedure; that complete mechanism is not implemented or claimed here.

A gesture has a much smaller practical search space than a strong random password. Argon2id and exponential delays after consecutive local failures raise attack cost, but they do not make a short gesture high entropy. Normal unlocking also requires the non-syncable WebAuthn credential. Recovery is instead protected by its independent random 256-bit code. Four points is the minimum accepted pattern and six or more non-obvious points are recommended. Gesture convenience must not be described as stronger security.

A fully malicious server can replace the JavaScript it serves and attempt to steal plaintext or keys on a later visit. CSP, pinned dependencies, HTTPS, and a separate static release channel reduce this risk but do not eliminate it. Strong protection from an actively malicious hosting server requires a signed client distributed from a separate trust root.

The server observes metadata needed for operation: room identifier, device pseudonyms and public keys, MLS key-package/welcome sizes, connection IP, ciphertext size, message count, acceptance time, delivery-receipt time, total order, and registered push endpoints. A push provider observes endpoint and timing/volume metadata even though the request carries no payload. The service can delay, drop, or deny delivery. Cryptography cannot force delivery or make a disconnected network instantaneous.

An endpoint compromise, malicious browser extension, screen recorder, operating-system compromise, or unlocked physical device can read plaintext. The hidden long-press entry is a privacy curtain, not an authentication boundary.

## Deployment requirements

- Terminate only modern HTTPS and proxy WebSocket upgrades correctly. Never expose this service over plaintext Internet HTTP.
- Do not add third-party analytics, tag managers, remote scripts, error collectors, or session replay.
- Keep `data/` on a private persistent volume with restrictive filesystem permissions.
- Run the included online backup worker, replicate completed snapshots to an independent failure domain with versioning/deletion protection, alert on backup age/capacity, and perform timed restore drills. See `OPERATIONS.md`.
- Keep the built-in request/frame limits, connection limits, message quotas, blob reservations, and incomplete-upload garbage collection enabled. Apply independent limits at the reverse proxy as defense in depth. A single encrypted chunk is slightly larger than 2 MiB.
- Review client dependency updates and run the complete test suite before every release.
- Treat both recovery parts as private-key material. Keep the recovery JSON and its independently displayed recovery code in different locations.
- A recovery checkpoint rebinds the same logical device identity; it does not revoke a still-running source device. Keep the source copy offline during recovery. Authenticated device replacement, old-session revocation, and a post-recovery MLS epoch update remain mandatory before public production use.
- Satisfy every blocking item in `PRODUCTION_SECURITY_GATE.md`, including independent cryptographic and application-security reviews, before using the service for high-risk communications.

## Reporting a vulnerability

Do not include real messages, invitations, recovery packages, private keys, or server data in a report. Provide a minimal synthetic reproduction and the affected commit or release identifier through the maintainer's private security channel.
