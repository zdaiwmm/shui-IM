# Quiet Room Design System

The browser IM visual system follows P1, explicitly approved for implementation on 2026-10-11. The primary reference is the user's Telegram light/dark screenshots, interpreted for Quiet Room's existing two-person product. This replaces the former Liquid Glass direction. Confirmation, source samples and scope live in the [requirement record](docs/requirements/2026-10-10-ui-system-exploration/README.md).

## Intent and palette

Messages are the primary surface when two people read a private conversation on a phone in daylight or at night. The interface uses compact typography, opaque controls, quiet borders and limited elevation. Browser chrome and a tall native keyboard are part of the available-space constraint.

`src/design-tokens.css` owns shared foundations, including the standalone administration entry; `src/design-system.css` owns app component rules; `src/appearance.css` supplies the other three local palettes. The existing `blue` storage identifier now means **经典** and retains compatibility with saved preferences. 松绿、雾紫、暖杏 remain available. The independent brightness preference offers system (default), light and dark. Old, malformed or unavailable storage falls back to system. Explicit light/dark overrides the OS inside the app; selecting system resumes OS changes. Palette and brightness save immediately in the current browser/PWA data space, synchronize same-origin tabs and preserve the previous effective value and selection after a failed write. There is no cross-device sync. The synthetic preview never reads private messages. This is the approved [V1 fidelity correction](docs/requirements/2026-10-11-p1-fidelity/README.md).

| Role | Classic light | Classic dark |
| --- | --- | --- |
| Wallpaper anchors | `#CAD381`, `#66AB84`, `#89BE87`, `#D0D7B2` | `#000000` |
| Incoming message | `#FFFFFF` | `#342234` |
| Outgoing message | `#E0FFC6` | Continuous `#944CD5` → `#9349F4` → `#3768FF` |
| Header | `#C6E6B7` | `#252525` |
| Composer | `#BCE8CF` | `#242424` |
| Primary action | `#34784A`, white text | `#7950BD`, white text |
| Secondary message time | `#67726B` incoming / `#3C783B` outgoing | `#C3B4C5` incoming / near-white outgoing |

Wallpaper colors and message fills follow the confirmed samples. Action colors and small metadata are adjusted for readable contrast, rather than copying low-opacity screenshot text. Pure black/white are deliberate reference choices. The local line-art tile is arranged from the existing Lucide 0.468.0 icons, with its ISC notice embedded in `src/assets/chat-pattern.svg`; it is bundled with the app, not fetched remotely. The prototype's larger Telegram pattern is not shipped. The local tile repeats at 200×250px; wallpaper gradients use the P1 top-left yellow-green, top-right green and lower-left teal arrangement. The synthetic appearance preview shares these tokens and the local tile.

## Surfaces and typography

- `--paper`, `--paper-pure`, `--surface`, `--surface-raised` define opaque page, grouped and elevated surfaces. `--ink` and muted variants define text; `--accent`, `--action-surface`, `--action-ink`, `--danger` and `--focus` remain semantic.
- Legacy `--glass*` names are opaque compatibility aliases; sheen, control blur and glass shadows are disabled. New components use the semantic surface tokens. Do not remove media-concealment or privacy filters while changing decorative material.
- Use the system UI font. Messages are 16px / 22px at the default root size; their rem sizing scales with accessible text enlargement. Inputs remain at least 16px to avoid iOS focus zoom. Row labels and action text are 14px, supporting text 12–13px, message time 11px in rem units. Delivery glyphs retain their approximately 16px geometry and accessible descriptions.
- Use 4px within a message group and 12px between adjacent groups. A date separator ends a group. Bubble radius is 16px, with a 6px terminal side corner. Main surface radius is 16px; bounded controls 12px. Borders are quiet 1px lines, not luminous rims.
- Keep controls visually compact while preserving 44px hit targets, visible focus and native text selection. Small glyphs are usually 20–23px. Do not scale whole pages or reduce the body font to make them fit.

`--on-accent` remains the legacy outgoing-message text token. Filled actions use `--action-ink` separately, so pale light-mode bubbles do not force dark text onto a dark action button.

## Chat and keyboard space

The normal header is 48px plus the top safe area; the keyboard state is 40px plus that safe area. Existing presence, connection information, space navigation and optional heart remain available. The compact state arranges presence and status on one line instead of allocating a second tall row. It does not add a new title or duplicate the peer information.

The composer starts at 52px plus any bottom safe-area contribution. It is a continuous opaque toolbar with 44px control targets and a capsule input. Multiline text grows to 88px and then scrolls internally, retaining native caret and composition behavior. Growth reads the CSS cap rather than maintaining a different JavaScript limit. Reply drafts, recording and expression tools keep their existing state owners.

Desktop input uses the same compact vertical scale; its floating tools keep an 8px gap above the input row. The mobile expression panel retains its occupied height so it cannot cover the keyboard toggle. Held recording uses a 72px feedback disc inside the viewport; cancel feedback remains destructive red.

Mobile tools meet the composer as an 18px top-corner bottom sheet with a decorative 32×4px mark; desktop tools retain their anchored panel. Tool tiles use a 48×44px icon surface in a 64px row. Locked recording keeps the 72px send disc; paused previews return to a 44px send control. Composer text/tool changes do not animate margins, padding or width: only bounded opacity and transform effects run while the viewport controller measures the final input geometry.

The existing VisualViewport, keyboard gesture, list/document scrolling and bottom-following controllers remain authoritative. A header inset change must compensate a history reader's scroll in the same task before paint; latest-following retains its existing endpoint alignment. Group spacing must not alter the established latest-message/composer gap. Keyboard open/close, interrupted motion, Chinese composition and browser toolbar movement need regression coverage. A desktop short-viewport simulation is not evidence of real iPhone keyboard behavior, and native Safari toolbar transparency is not promised.

Outgoing dark bubbles sample one gradient field across the rendered timeline, using layout coordinates so in-flight FLIP transforms do not move their colors. Media and expression bubbles preserve their intrinsic geometry, concealment state and contrasting metadata overlays; expressions retain their transparent exterior.

## Long press and other overlays

Long press uses the approved reaction / selected message / action-list hierarchy. The six existing reactions and their protocol stay unchanged. Replies lead the current actions, destructive deletion is red, and text selection is last behind a divider. Availability still depends on message kind, ownership and confirmation; this design adds no pin, forward or report functions.

A sheet's visible handle is 32 × 4px. Interactive invitation handles retain a full-width 44px drag area around that mark. Restoring an already-open drawer from settings is immediate; a fresh open or close keeps its transition. Increased contrast retains explicit strong input/control boundaries.

The selected bubble is an inert, aria-hidden clone above an 8px blurred focus backdrop. It retains media concealment and removes duplicate element IDs. Placement keeps the reactions above the preview and a scrollable 216px action card below it. If the visible viewport is too short, only the inert preview is clipped; the real message is unchanged. Closing, Escape, keyboard traversal, deletion choices and privacy teardown retain their existing lifecycle.

Simple two-action confirmations use an approximately 280px opaque dialog, 14px corners, a 17px heading and separated horizontal 44px actions. Complex summaries and recovery forms keep wider 16px-corner containers and 20px content insets; do not shrink their security text into the simple-confirmation layout. Half sheets use 18px top corners, a 32×4px handle and scrolling content; invitation drag thresholds and damping are unchanged. Recovery/history input panels keep their viewport-owned placement and security lifecycle. Toasts and tips use opaque 12px-radius surfaces, 13px text and semantic error colors. Successful operations and privacy cleanup never wait for a toast or transition.

Operation verification sheets meet the viewport bottom, including its safe area. Secondary joint-code, history-restore and backup-privacy panels share 17px headings, 18px top corners, 20px horizontal padding and a decorative 32×4px handle on mobile; desktop uses centered 16px-corner forms. Existing close controls retain 44px targets and existing gesture ownership. Their content scrolls independently from the visible action area in a short visual viewport. Device note and passkey-name inputs share the full available width, at least 44px height and 16px type. Empty and single-line chat editors center their 22px line within the 44px field, with symmetric fixed insets that remain clear when the existing 88px capped editor scrolls. Message-information stages are read-only 40px rows; their actions retain 44px targets. Photo details have a 64×44px handle target and square outer edges when expanded to the full viewport. Update notes remain a centered 16px-radius dialog with a single 20px horizontal inset, a fixed header and independently scrolling content.

## Settings and desktop

Settings uses a complete mobile page or desktop content pane, a 48px header, grouped 10px-corner cards, 24px colored icon tiles with 17px glyphs and ordinary 44px rows with 14px copy. Long text and 200% text enlargement may increase row height. Groups follow function without restoring the removed local/space split. The online-style value sits on the same row when space permits. Appearance uses native immediate-choice radios, independent brightness options and a synthetic preview. Notifications have one page heading and one 20px content inset; explanatory, permission and privacy text stays visible, while rows without long text retain the 44px scale. Private-space drawers use compact rows, a 24px selected-space title and a fixed footer. The scrolling body must keep all security, backup, device and appearance controls reachable. Full-screen password, recovery and device pages share the same colors and smaller bounded controls without changing their authorization or storage behavior.

Two-line settings and recovery-entry rows use 14px labels, 12px supporting text and 6px vertical padding; text enlargement or wrapping may grow the row. Drawer headings are 17px. Backup-code input uses the shared 12px-radius surface, 16px input text and an 88px minimum textarea. Cover-practice navigation uses the same compact header scale while retaining the existing practice gesture target.

The confirmed desktop layout still begins at 1024 CSS px with its 280px collapsible sidebar and a 640px maximum text bubble. Embedded drawers have square outer edges; their selected-row titles stay 19px. Auxiliary content retains readable widths. Media viewers and recording keep their viewport and gesture owners. Call chrome uses the same opaque surfaces, 48px control discs, a compact 24px peer title and 80px identity mark; video overlays retain contrasting dark controls over unpredictable video. The reader uses 52px header chrome, 44px controls and a 16px toolbar; reading typography, pagination and file sanitization remain independent. Administration uses the same foundations, 44px actions and 12px control corners.

Call toolbars retain 18px corners and video previews 16px corners at narrow and landscape breakpoints; the base peer title stays 24px, with the existing 28px desktop variant. App and administration switches use a 36×22px track and 18px thumb inside a 44px target; native confirmation dialogs use the shared 16px/20px/17px dialog scale, 14px body text and 12px content gaps without page-form margins. Reader search-result tips share the 13px text and 12px surface radius.

All existing routes are in scope: welcome and access verification; invitation, device joining and repair; browser access and passkey management; chat, space lists and settings; notifications, appearance and lock timing; devices; backup import/export and recovery; gallery, favorites and media details; document reading; voice and calls; help, releases and cover practice. Confirmations, bottom sheets, menus, inputs, switches, radios, empty/loading/error feedback and toasts share the component scale. Cover and privacy curtains preserve their immediate concealment and quiet browser-error presentation.

## Motion, accessibility and verification

Shared motion tokens live in `src/motion.css` and finite effects in `src/lib/motion.ts`: press feedback 100ms at .96 scale with one WAAPI scale/opacity owner (the voice gesture retains its own press feedback), local/message/page effects 180ms, half sheets 240ms, media 280ms, menu exit 140ms. Gesture settling remains critically damped and keyboard travel remains coordinated with the native viewport. Do not animate layout properties or restart progress/connection animations on every update.

Photo-detail sheet entry and exit use 240ms; viewer fade, zoom and return-to-source use 280ms. Ordinary Toasts remain for 2.6 seconds; errors remain for 5 seconds with the existing inline/status error locations. Toast entry uses 180ms and exit 140ms. Themed tooltips use 13px text, 12px corners and a 400ms mouse/keyboard delay, dismiss on Escape/blur/scroll and clear immediately on privacy concealment. Touch controls keep accessible names; security-critical guidance stays inline. Message/reaction and gallery menus exit in 140ms. Centered update notes use 180ms entry and 140ms exit, without inheriting half-sheet timing.

Reduced motion disables decorative motion. Reduced transparency and increased contrast remove the focus backdrop blur and wallpaper; forced colors uses system surfaces and explicit borders. Preserve keyboard focus, screen-reader state, 44px targets, at least 4.5:1 small-text contrast and the original media privacy lifecycle. No analytics, remote assets or runtime observers are added.

Verify the full product cascade in both effective schemes, all four palettes and at 320/390/768/1024/1440px, including short viewports, 200% text, keyboard focus, reduced motion and forced colors. Capture the actual invitation body and release-notes body, populated media surfaces, reader/expressions/voice/call states and administration dialogs; a substituted mock body is not coverage. Existing timeline, keyboard, scrolling, selection, reactions, deletion, media, recovery and call tests remain the functional authority. True iPhone / iOS 27 Safari keyboard, toolbar and touch validation must be recorded separately from browser automation.
