---
name: quiet-room-mobile-debug
description: Run this Quiet Room checkout in the Codex browser with a verified mobile UA, touch parameters, and the local Safari-style keyboard/chrome simulator. Use for this project's local mobile debugging; this is not Safari or physical-device verification.
---

Read the repository's AGENTS.md and [mobile debugging workflow](../../../docs/workflows/mobile-debug.md) before starting. Use the current task's isolated checkout. Do not copy an absolute path, port, test database, or browser authorization from an earlier computer/session.

Start `npm run dev:mobile` in that checkout, using explicit `--port`/`--api-port` only when needed. Respect occupied ports and other tasks; do not kill unrelated listeners. Keep this task's long-running service session for reuse. The launcher uses ignored local data and loopback-only listeners.

Use the documented `cua_repl` browser APIs to show the printed local URL. Before raw CDP, obtain the user's origin-specific authorization and ensure full CDP access is enabled. Reinitialize the browser runtime after a permission change if its documented capabilities remain stale; do not probe hidden APIs or connect around denied access.

Read `tools/mobile-debug/device-profile.json`. Apply its UA and touch settings through the documented tab CDP capability. For the centered shell set metrics width/height to 0, preserving the profile's screen dimensions, DPR, mobile flag, orientation, and scale 1. The shell's iframe owns the 393×852 device composition. For the direct app use the profile's normal width/height instead.

Do not enable mouse-to-touch conversion by default: it previously produced an incomplete touch sequence and blocked clicks. Raw touch injection may also be unavailable. Report the actual capability, not just the requested settings.

Read back the framed page's UA, platform, maxTouchPoints, DPR, coarse pointer, hover, layout height, and VisualViewport height. Verify the simulator's bridge is marked synthetic/installed, controls work, and the page remains centered without enlargement. Readback must use the current origin and actual frame. Keep the user-facing tab as a deliverable.

The simulator changes VisualViewport getters/events only inside its same-origin debug iframe. Never infer real Safari keyboard/chrome, IME, WebAuthn, permission, gesture, or security results from it. An iPhone UA does not make the host browser support passkeys. Follow the application's existing capability and fail-closed rules; do not install an authenticator or force password fallback to make a demo pass.

Only code, profiles, requirements, and instructions travel through GitHub. Each computer needs its own installed dependencies, test data, browser permission, and any real-device HTTPS setup. Do not modify another computer's global configuration.
