# iPhone Chat Viewport Investigation

## Scope And Candidate

- Device: iPhone16,1, iOS 27.0, Safari, connected to the Mac over USB.
- Origin: `https://zhoudingdemacbook-air.local:5173/`.
- Rule/development baseline: `28dbe2fa109799a34b66b81ae6d354c6545d1cf1`.
- Continuous-composer commit: `2e83b2b`; combined with local main
  `3a9a8f570d46a0ce51552451071fe9d3594e948a` in task merge `5e9d208`.
- Task branch: `codex/iphone-chat-viewport-20260908`.
- No remote synchronization, CI, or production deployment in this task.

## Evidence

The user requires a stationary header during bottom overscroll and keyboard
focus from history, a continuously visible composer moving with the keyboard,
and matching Safari URL-bar motion. Native screenshots and numerical geometry
are separate evidence; DOM coordinates do not establish final compositor paint.
No message text, device secrets, or credentials are included in this report.

The original candidate explicitly hid the composer during viewport motion.
Removing that fade alone passed the full automated suite but did not resolve
physical disappearance. One controlled combined header-translate/overscroll-none
trial measured header top zero while the user still saw flashing. It also removed
the required scrolling resistance and was rejected.

Runtime-only trials could be erased by page reload. Local main advanced during
the investigation, which can cause Vite reloads; this is a possible interference
source, not proof of the cause of every lost trial. Later evidence uses a fixed
task frontend and reload-persistent local numerical diagnostics, with mode and
page identifiers. The backend continues to use the existing local environment.

In that fixed candidate, keyboard dismissal briefly exposed header top 376 CSS
pixels before correction. Bottom compensation ranged from approximately -844
to 376 pixels during keyboard transitions. The user confirmed header movement
and composer disappearance in the same controlled run.

With native `bottom: 0` and continuous visibility, the user confirmed the composer
did not disappear or float, but it still did not move continuously with the
keyboard. Native frames show the composer reaching its endpoint while the
keyboard and Safari address controls are still moving. This is partial physical
evidence, not acceptance of the four requested outcomes. A header translateZ(0)
and backface-visibility trial still moved and was removed.

A temporary inner-scroll layout retained bounce and kept the header stable
while scrolling. Focusing from history moved the entire shell outside the
viewport; existing document-scroll ownership had not been migrated. That
incomplete structural trial was removed. A full migration also changes the
document-behind-native-glass contract and requires a product decision.

## Verification And Remaining Work

- Before the local-main merge, `npm run check:full` passed build, 500 tests
  across 61 files, and 26 browser entries in 355.50 seconds.
- WebKit lifecycle and bottom-control suites passed the continuous-composer
  implementation before the merge.
- After the native-bottom motion change, WebKit lifecycle passed. The
  bottom-control fixture initially kept its native fixed bottom at desktop
  height; after modeling the independent native bottom, that suite passed.
- The motion-only native-bottom source change is narrower than the always-zero
  physical trial; final exact-candidate physical acceptance remains required.
- Header focus stability, continuous composer motion, and Safari native URL-bar
  motion are unresolved. No claim of completed local integration or delivery.
- Safari's delayed visual-viewport updates are also tracked upstream in
  [WebKit 265578](https://bugs.webkit.org/show_bug.cgi?id=265578); that report
  supports a platform limitation, not proof that every observed failure has
  the same cause.

## Authorized Structural Candidate

The user explicitly accepted independent list scrolling, prioritizing stable
chat interaction over the previous Safari native-glass behavior. D-034 records
that decision. The new candidate routes history, return-to-latest and reply
navigation through the list, disables document keyboard compensation for this
path, and anchors all chat controls in one viewport shell. Native inertia and
bounce stay enabled inside the list; root scrolling is locked.

The dedicated touch-WebKit fixture passed long-history scrolling, history
anchor restoration, keyboard endpoints, multiline input, return-to-latest,
root-scroll stability, and privacy teardown. Desktop WebKit lacks the iOS
touch-callout detection feature, so the fixture explicitly selects the device
layout. This is not an iPhone compositor or animation-speed acceptance result.

The user then confirmed the integrated list candidate kept the header stable
during bottom overscroll and matched composer movement during keyboard closing.
Keyboard opening and closing still flashed the header, and opening speed did
not match the keyboard. These are the remaining physical failures at this point.

A root-scroll reset during focus did not prevent the opening flash and regressed
closing motion, with a mid-screen pause. It was removed. An absolute shell
following the reported root offset preserved continuous closing but still
flashed during opening and closing. Adding a shared 300ms shell-height opening
animation did not improve physical synchronization and was also removed.
Numerical traces still show a 376px native root pan during opening, although
the corrected header's sampled DOM top is zero. The next isolated comparison
uses touch-end focus with `preventScroll: true` to prevent that native pan.

The user confirmed that touch-end focus prevented the header flash and still
opened the keyboard normally. Repeated geometry samples then kept root scroll
and header top at zero. Native screen streaming and controlled input/blank-area
taps over USB replaced the low-rate screenshot loop for timing analysis.
Recorded stream packets had no sequence gaps in the bounded control runs.

The measured browser-height event arrived about 130ms after opening focus and
about 450ms after dismissal blur. Frame callbacks also had a roughly 100ms gap
at opening. A frame-driven height transition could therefore skip visible
positions. The next candidate uses compositor transforms on the composer and
bottom-pinned list, a shared performance-time origin, bounded endpoint ownership,
and a measured critically damped approximation. The header is not animated.
First focus without a previously measured keyboard still depends on Safari's
first height report; no exact native animation synchronization is claimed.

The user reported a final small message displacement at keyboard dismissal.
Trace evidence showed composer height changing from 62px to 68px after motion
ended. The list-owned composer now retains a 68px minimum; the new regression
checks both its top edge and the last message before and after the late event.

The structural candidate passed build and 505 unit/integration tests before
the final endpoint correction. Its first full browser run was intentionally
interrupted after the new physical failure was reported, not counted as a
complete full-suite pass. Dedicated list/keyboard regression passes include
shared intermediate geometry, the touch dismissal gesture, gallery return,
reply navigation, responsive layouts, and the no-second-shift endpoint.
The final frozen candidate still requires its full gate and physical review.

## Editing And Multiline Follow-up

The user confirmed the final dismissal displacement was gone, the header was
stable, and composer motion was continuous. Subsequent initial typing and
deletion exposed a separate native root pan of 376px. The inner-list root still
inherited document-scroll padding; clearing that padding kept root displacement
at zero during hundreds of native editing/composition events. The user confirmed
short typing and deletion stopped shaking.

Multiline traces showed a one-line growth followed by a temporary shrink and
another growth across native composition frames. Retaining the expanded editing
area until composition commit removed that shake in the user's physical review.
Fixed transparent top/bottom borders replace scrollable textarea padding, keeping
text insets visible at the height cap; measurement includes those borders.
The user confirmed the restored insets, while noting a delay in line growth.
Live editor overflow now supplements clone measurement for native marked-text
wrapping. The user confirmed the result was generally stable, with occasional
text-only flicker on wrapping. A separate textarea compositor layer and native
`field-sizing: content` trials did not eliminate that flicker and were reverted.
The user explicitly deferred further optimization of this remaining issue.

The extended WebKit fixture also exposed an independent-list extent problem:
large composer padding could exceed the keyboard viewport and make the latest
message target unreachable. The bottom reserve is now scrollable spacer content,
so it cannot enlarge the list viewport. The fixture passes initial edits,
cross-frame composition, capped six-line insets, latest-message alignment, and
shared keyboard motion with the long draft. It still does not substitute for
iPhone compositor evidence or prove control over Safari's native URL bar.

The frozen implementation passed build and 505 tests across 62 files. The full
browser run passed its first four entries, then the new fixture read the old
height before a requested viewport resize became observable. After waiting for
the actual new viewport and composer endpoint, the remaining 23 entries passed
through the existing sequential runner (174.82 seconds). This is a complete
segmented result for 27 entries, not a claim that the original full command
exited successfully. A long USB stream had no RTP sequence gaps, but visible
encoder artifacts make it unsuitable as proof of individual text-paint frames.
