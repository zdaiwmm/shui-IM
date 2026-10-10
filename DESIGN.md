# Quiet Room Design System

The browser IM visual system follows P1, explicitly approved for implementation on 2026-10-11. The primary reference is the user's Telegram light/dark screenshots, interpreted for Quiet Room's existing two-person product. This replaces the former Liquid Glass direction. Confirmation, source samples and scope live in the [requirement record](docs/requirements/2026-10-10-ui-system-exploration/README.md).

## Intent and palette

Messages are the primary surface when two people read a private conversation on a phone in daylight or at night. The interface uses compact typography, opaque controls, quiet borders and limited elevation. Browser chrome and a tall native keyboard are part of the available-space constraint.

`src/design-tokens.css` owns shared foundations, including the standalone administration entry; `src/design-system.css` owns app component rules; `src/appearance.css` supplies the other three local palettes. The existing `blue` storage identifier now means **经典** and retains compatibility with saved preferences. 松绿、雾紫、暖杏 remain available. All four follow the system light/dark preference, apply immediately and preserve failed-write rollback and cross-tab synchronization. This refactor adds no separate brightness preference.

| Role | Classic light | Classic dark |
| --- | --- | --- |
| Wallpaper anchors | `#CAD381`, `#66AB84`, `#89BE87`, `#D0D7B2` | `#000000` |
| Incoming message | `#FFFFFF` | `#342234` |
| Outgoing message | `#E0FFC6` | Continuous `#944CD5` → `#9349F4` → `#3768FF` |
| Header | `#C6E6B7` | `#252525` |
| Composer | `#BCE8CF` | `#242424` |
| Primary action | `#34784A`, white text | `#7950BD`, white text |
| Secondary message time | `#67726B` incoming / `#3C783B` outgoing | `#C3B4C5` incoming / near-white outgoing |

Wallpaper colors and message fills follow the confirmed samples. Action colors and small metadata are adjusted for readable contrast, rather than copying low-opacity screenshot text. Pure black/white are deliberate reference choices. The local line-art tile is arranged from the existing Lucide 0.468.0 icons, with its ISC notice embedded in `src/assets/chat-pattern.svg`; it is bundled with the app, not fetched remotely. The prototype's larger Telegram pattern is not shipped.

## Surfaces and typography

- `--paper`, `--paper-pure`, `--surface`, `--surface-raised` define opaque page, grouped and elevated surfaces. `--ink` and muted variants define text; `--accent`, `--action-surface`, `--action-ink`, `--danger` and `--focus` remain semantic.
- Legacy `--glass*` names are opaque compatibility aliases; sheen, control blur and glass shadows are disabled. New components use the semantic surface tokens. Do not remove media-concealment or privacy filters while changing decorative material.
- Use the system UI font. Messages are 16px / 22px at the default root size; their rem sizing scales with accessible text enlargement. Inputs remain at least 16px to avoid iOS focus zoom. Row labels and action text are 14px, supporting text 12–13px, message time 11px in rem units. Delivery glyphs retain their approximately 16px geometry and accessible descriptions.
- Use 4px within a message group and 12px between adjacent groups. A date separator ends a group. Bubble radius is 16px, with a 6px terminal side corner. Main surface radius is 16px; bounded controls 12px. Borders are quiet 1px lines, not luminous rims.
- Keep controls visually compact while preserving 44px hit targets, visible focus and native text selection. Small glyphs are usually 20–23px. Do not scale whole pages or reduce the body font to make them fit.

`--on-accent` remains the legacy outgoing-message text token. Filled actions use `--action-ink` separately, so pale light-mode bubbles do not force dark text onto a dark action button.

## Chat and keyboard space

The normal header is 48px plus the top safe area; the keyboard state is 40px plus that safe area. Existing presence, connection information, space navigation and optional heart remain available. The compact state arranges presence and status on one line instead of allocating a second tall row. It does not add a new title or duplicate the peer information.

The composer starts at 52px plus any bottom safe-area contribution. Its controls have 44px targets and a capsule input. Multiline text grows to 88px and then scrolls internally, retaining native caret and composition behavior. Growth reads the CSS cap rather than maintaining a different JavaScript limit. Reply drafts, recording and expression tools keep their existing state owners.

Desktop input uses the same compact vertical scale; its floating tools keep an 8px gap above the input row. The mobile expression panel retains its occupied height so it cannot cover the keyboard toggle. Held recording uses a 72px feedback disc inside the viewport; cancel feedback remains destructive red.

The existing VisualViewport, keyboard gesture, list/document scrolling and bottom-following controllers remain authoritative. A header inset change must compensate a history reader's scroll in the same task before paint; latest-following retains its existing endpoint alignment. Group spacing must not alter the established latest-message/composer gap. Keyboard open/close, interrupted motion, Chinese composition and browser toolbar movement need regression coverage. A desktop short-viewport simulation is not evidence of real iPhone keyboard behavior, and native Safari toolbar transparency is not promised.

Outgoing dark bubbles sample one gradient field across the rendered timeline, using layout coordinates so in-flight FLIP transforms do not move their colors. Media and expression bubbles preserve their intrinsic geometry, concealment state and contrasting metadata overlays; expressions retain their transparent exterior.

## Long press and other overlays

Long press uses the approved reaction / selected message / action-list hierarchy. The six existing reactions and their protocol stay unchanged. Replies lead the current actions, destructive deletion is red, and text selection is last behind a divider. Availability still depends on message kind, ownership and confirmation; this design adds no pin, forward or report functions.

A sheet's visible handle is 32 × 4px. Interactive invitation handles retain a full-width 44px drag area around that mark. Restoring an already-open drawer from settings is immediate; a fresh open or close keeps its transition. Increased contrast retains explicit strong input/control boundaries.

The selected bubble is an inert, aria-hidden clone above an 8px blurred focus backdrop. It retains media concealment and removes duplicate element IDs. Placement keeps the reactions above the preview and a scrollable 216px action card below it. If the visible viewport is too short, only the inert preview is clipped; the real message is unchanged. Closing, Escape, keyboard traversal, deletion choices and privacy teardown retain their existing lifecycle.

Confirmation dialogs use opaque surfaces, 16px corners, 20px padding, a 17px heading and compact 44px actions. Half sheets use 18px top corners, a 32×4px handle and scrolling content; invitation drag thresholds and damping are unchanged. Recovery/history input panels keep their viewport-owned placement and security lifecycle. Toasts and tips use opaque 12px-radius surfaces, 13px text and semantic error colors. Successful operations and privacy cleanup never wait for a toast or transition.

## Settings and desktop

Settings remains the existing flat functional list, with 52px rows and native immediate-choice radios. Private-space drawers use compact rows, a 24px selected-space title and a fixed footer. The scrolling body must keep all security, backup, device and appearance controls reachable. Full-screen password, recovery and device pages share the same colors and smaller bounded controls without changing their authorization or storage behavior.

The confirmed desktop layout still begins at 1024 CSS px with its 280px collapsible sidebar and a 640px maximum text bubble. Embedded drawers have square outer edges; their selected-row titles stay 19px. Auxiliary content retains readable widths. Media viewers and recording keep their viewport and gesture owners. Call chrome uses the same opaque surfaces, 48px control discs, a compact 24px peer title and 80px identity mark; video overlays retain contrasting dark controls over unpredictable video. The reader uses 52px header chrome, 44px controls and a 16px toolbar; reading typography, pagination and file sanitization remain independent. Administration uses the same foundations, 44px actions and 12px control corners.

All existing routes are in scope: welcome and access verification; invitation, device joining and repair; browser access and passkey management; chat, space lists and settings; notifications, appearance and lock timing; devices; backup import/export and recovery; gallery, favorites and media details; document reading; voice and calls; help, releases and cover practice. Confirmations, bottom sheets, menus, inputs, switches, radios, empty/loading/error feedback and toasts share the component scale. Cover and privacy curtains preserve their immediate concealment and quiet browser-error presentation.

## Motion, accessibility and verification

Shared motion tokens live in `src/motion.css` and finite effects in `src/lib/motion.ts`: press feedback 100ms at .96 scale, local/message/page effects 180ms, half sheets 240ms, media 280ms, menu exit 140ms. Gesture settling remains critically damped and keyboard travel remains coordinated with the native viewport. Do not animate layout properties or restart progress/connection animations on every update.

Reduced motion disables decorative motion. Reduced transparency and increased contrast remove the focus backdrop blur and wallpaper; forced colors uses system surfaces and explicit borders. Preserve keyboard focus, screen-reader state, 44px targets, at least 4.5:1 small-text contrast and the original media privacy lifecycle. No analytics, remote assets or runtime observers are added.

Verify actual product styles in both system schemes, all four palettes, 320px narrow screens, short browser viewports and desktop layout. Existing timeline, keyboard, scrolling, selection, reactions, deletion, media, recovery and call tests remain the functional authority. True iPhone / iOS 27 Safari keyboard, toolbar and touch validation must be recorded separately from browser automation.
