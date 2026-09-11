---
name: iphone-debug
description: Connect a USB iPhone to a Mac for real-device Safari UI debugging, screenshots, bounded screen recordings, keyboard motion capture, and numeric viewport diagnostics. Use when the user asks for iPhone real-device debugging or automatic recording; distinguish physical-device evidence from desktop browser simulation.
---

# iPhone debugging

Use the scripts beside this file. Run `python3 scripts/device.py --help` first.
`setup` installs the pinned Python dependencies in a persistent user cache;
it requires Python 3.12+. Reuse that runtime on subsequent sessions.

1. Run `doctor`. It discovers USB devices, selects the sole iPhone (or requires
   `--device` for multiple devices), and checks the native display service. It also
   attempts lock state; iOS 27 can return unsupported, reported as unknown.
   With `--origin https://host:port --ca /path/rootCA.pem`, also verify HTTPS.
   Do not replace the project's stable origin or disable certificate verification.
2. Use `screenshot --output /absolute/new-run`. Inspect it before any touches.
   Device trust, unlock, Developer Mode when required, and Safari Web Inspector
   remain physical prerequisites; only ask about the actual missing prerequisite.
3. Use `record --seconds 30 --output /absolute/new-run` for passive recording.
   Wait for CAPTURE_READY before asking the user to reproduce. Recordings are
   bounded, use RTCP keepalive, and produce timing metadata plus a playable MP4.
4. For an authorized automatic keyboard test, verify Safari's current project
   page using the fresh screenshot and current session's known origin. Only then
   pass `--keyboard X,Y,X,Y` (normalized 0..65535: input tap, safe blank tap) and
   `--target-verified`. Coordinates must come from this device's fresh screenshot,
   never from an old task. This repeats focus/dismiss only, without typing or sending.
   Skip automation if the target or a safe dismiss point is uncertain.
5. For DOM timing, inject `scripts/viewport-probe.js` only into the verified local
   development page through an available inspector. It observes for 30 seconds;
   read `window.__iphoneDebug.result` afterward. It collects numeric geometry and
   text length only, no message text. `window.__iphoneDebug.stop()` cancels it.
   The probe is not bundled or enabled in production. Do not claim inspector access
   from successful USB discovery: raw Web Inspector connections may still fail.
6. Compare video timestamps with numeric geometry. Stable DOM rectangles do not
   prove a stable native compositor. Gray blocks or adaptive resolution changes
   can be encoder artifacts even with zero RTP sequence gaps. Confirm with another
   capture or the user's observation before changing CSS based on a single frame.
7. Report the actual device/version, command outcomes and unverified scope.
   Run `cleanup --output /absolute/run` after extracting the required evidence;
   it removes only media named in the tool's manifest and preserves numeric metadata.
   Recordings can contain notifications: do not transcribe private content or commit
   raw media. No background recorder is installed.

For Quiet Room, read the current main's AGENTS.md and workflow first. Existing LAN
services and integration locks have owners; this tool does not restart or replace
them. Application changes still need the project's normal isolated worktree and
validation. A skill installation does not grant push or production permissions.
