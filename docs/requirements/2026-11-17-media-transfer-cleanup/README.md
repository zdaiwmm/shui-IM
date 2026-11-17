# Local media transfer cleanup V1

## Scope and authorization

- Authorized in the current conversation on 2026-11-17: implement the preceding cleanup proposal, changing 72 hours to **24 hours**. No new page or visual design is required.
- Rule source and starting main: `c9bb202df9bdf47ad6bbe2bc2efcb650c6d6b180`, [AGENTS](../../../AGENTS.md), [workflow](../../context/workflow.md), [verification](../../workflows/publish-efficiency.md).
- Exclusive branch: `codex/media-transfer-cleanup-20261117`; independent checkout under the configured worktree root, with its own Git metadata. The shared source and other task worktrees remain untouched.
- Risk: high; local persistent media, cancellation, retry and privacy lifecycle. Full CI is required. Production deployment is outside this implementation authorization.

## Behavior

1. Transfer ciphertext is disposable after **24 hours since the last activity**, including failed preparation, interrupted transfers and completed but unconsumed staging. Grant expiry alone does not remove usable data. Each staged chunk and worker activity renews the idle timestamp; an active worker also heartbeats once per minute.
2. Collection runs on application startup, authenticated unlock, foreground return, before preparing a transfer, and every 15 minutes while visible. Browsers do not guarantee execution while closed, suspended or powered off; overdue collection occurs on the next available trigger.
3. One IndexedDB transaction fences expired tasks, clears their scoped transfer token and deletes expired/cancelled/orphaned parts using key cursors. Worker notification and best-effort grant retirement follow the durable local decision. Cancelled/expired metadata tombstones are removed after another idle 24 hours; missing-task checks still reject late writes.
4. Explicit upload cancellation and clearing pending upload records retire pre-intent transfers too. New plans and upload tasks carry the opaque original client message ID so cancellation does not depend on file metadata or the final encryption callback.
5. The authenticated collector scans paged chat history, retained Safe history, restored gallery history, durable outbox and live transfer intentions under the existing vault lifecycle lease. Only unreferenced disposable media entries are eligible, normally after 24 hours, or immediately after explicit cancellation. It checks the current vault plus cache timestamp/byte count again in its delete transaction. Authentication failure, damaged records or an aborted runtime stop collection without treating missing evidence as an unused asset.
6. Ordinary quota/LRU cache policy remains in effect. Recovery-manifest cache namespaces, private archive/media stores, source-video library originals, messages, attachment keys, upload descriptors, already generated MLS ciphertext and outbox records are not deleted by the collector. Expired pending uploads retain their original descriptor/key/hash and show a reselect/download notice; source imports restart with a fresh task/key/nonce prefix.
7. Successful upload staging is removed after durable enqueue, and successful download staging after a complete verified media cache exists, using the existing completion paths. This change adds the expiry fallback for interrupted completion.

## Verification and delivery

- Local build passed; targeted retention, worker, cache policy, locale and video classification checks passed (43 tests at the first verification checkpoint).
- New Chromium/WebKit test covers the 24-hour boundary, failed/done/orphaned staging, late writes, unchanged encrypted outbox/upload descriptors, Safe-only/chat references, explicit cancellation and fail-closed collection on corrupt history. Registered in the full browser runner.
- Local browser verification is blocked by `listen EPERM` on loopback and browser launch `SIGABRT`. These are environment failures, not passing browser evidence. Full local verification cannot complete in this sandbox. No physical iPhone result is claimed.
- Full local `ensure check:full` was attempted: build passed; unit phase ended with 126 files / 1235 tests passing, 46 files / 123 tests failing and one unhandled loopback `EPERM`. Failures include unavailable listeners, sandboxed process/network operations and concurrency timeouts; they are not waived or marked passing. The browser phase was not reached. The new focused tests pass separately.
- GitHub destination was independently confirmed as the existing public repository `zdaiwmm/shui-IM` (ID 1355832700); the connected account is its owner. Nevertheless automatic approval review twice rejected Git tree creation because it did not accept the destination/disclosure authorization. No workaround was attempted. Only an isolated remote branch and unreferenced blobs were created before that rejection; no new commit, PR, CI, merge or production deployment exists.
- User subsequently explicitly confirmed uploading this exact change to `zdaiwmm/shui-IM`, creating a PR, and merging after complete CI passes. This confirmation supersedes the prior delivery block; no production deployment was requested. Remote PR/CI/merge results are pending and must be recorded separately.
