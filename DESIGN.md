# Quiet Room Design System

Quiet Room uses a restrained Liquid Glass inspired system for an encrypted one-to-one chat. The material is a supporting layer: messages, delivery state and privacy state remain the visual priority, and shared visual tokens remain authoritative.

## Physical Intent

The unlocked conversation is read in changing daylight on a phone or desktop browser. Controls should feel light, quiet and anchored to the content behind them. Transparency is decorative and always has an opaque, high-contrast fallback.

## Tokens

`src/design-system.css` is the source of truth for shared UI tokens. Tokens cover:

- `--paper`, `--surface`, and `--surface-raised` for page and content planes.
- `--glass`, `--glass-control`, and `--glass-panel` for bounded translucent materials.
- `--glass-border`, `--glass-shadow`, and `--glass-sheen` for edge definition and restrained elevation.
- `--accent`, `--accent-soft`, `--danger`, and `--focus` for semantic emphasis.
- `--material-blur` and `--material-blur-strong` for controls and layered panels.
- `--radius-control`, `--radius-surface`, and `--radius-bubble` for stable geometry.

All colors use OKLCH and are overridden by `prefers-color-scheme: dark`. The palette keeps the canvas low contrast, gives outgoing messages a clear accent, and leaves status and error colors semantic.

## Materials

Use `.glass-surface`, `.glass-control`, and `.glass-panel` for future bounded controls or sheets. They require a visible border, a restrained shadow, and a fallback for `prefers-reduced-transparency`, `prefers-contrast`, and forced-colors mode. Do not apply glass to the entire page or to large message content areas.

## Component Rules

- Header controls and the composer use circular or capsule controls with a minimum 44px hit target.
- Incoming and outgoing message bubbles retain their existing geometry and delivery metadata. Incoming content stays neutral; outgoing content uses the accent surface.
- Menus and notices share the panel material and anchor-origin motion.
- History restoration reuses the recovery-code panel and shared `mountDialog` lifecycle. Its compact input panel follows the visible viewport during keyboard motion, has no Paste action or helper rows, and keeps balanced padding outside the textarea scroll area; privacy cancellation removes it immediately. Do not introduce a separate prototype theme.
- The chat tools grid remains the existing six-entry workflow. Its panel is a single surface with icon-first controls.
- Gallery and device pages reuse the same material tokens without introducing new navigation or product concepts.

## Motion

Lifecycle and native keyboard geometry remain authoritative. Shared presentation tokens live in `src/motion.css`; finite effects, interrupted transitions and gesture settling use `src/lib/motion.ts`. Controls, message layout, navigation and media have distinct timing and easing. Reply and invitation gestures settle with critical damping; repeated navigation and media gestures continue from the painted state. Decorative motion is disabled for reduced motion. Privacy cleanup, recording/call termination and business success never wait for animation. CSS layout properties are not animated. Root/browser sampling surfaces match the active page; native Safari toolbar transparency is not guaranteed.

## Accessibility and Performance

The system preserves keyboard focus rings, semantic colors, native text selection and the existing 44px target minimum. Backdrop filters are limited to bounded controls and panels; reduced-transparency and forced-colors modes remove the filter. No third-party analytics, remote assets or runtime observers are introduced.

## Verification

Visual checks should cover the unlocked chat, tools panel, message menu, gallery tabs, device page, light/dark themes, narrow mobile width, desktop width, reduced motion, reduced transparency and forced colors. Behavioral checks remain the existing browser suites because this layer does not change message, attachment, privacy or navigation logic.

## Private-space drawer

Use the existing panel material, system typography, semantic accent and 44px controls. The left drawer is `min(88vw, 380px)`, with a scrolling body and fixed footer. Selected space rows are at least 104px and other rows at least 82px; only pending invitations have a secondary theme-colored line. Settings has a 58px prominent neutral footer button; creation is a lighter text action above it. Settings and name editing reuse the drawer body with back navigation, not tabs or persistent row actions. The header shield and ellipsis are removed. The optional heart reuses the presence SVG and its lifecycle inside a 44px control at the top right; default capsule geometry is unchanged. Reduced motion removes drawer animation and presence motion. Reduced transparency and forced colors use existing opaque materials and explicit selection borders.

## Desktop presentation

The confirmed PC layout begins at 1024 CSS px with a 280px collapsible sidebar. It uses the same tokens, 44px controls and single-space business state. Content fills the remaining width, with 28px chat insets and 640px maximum individual text bubbles. Desktop header and composer have opaque page backgrounds; only bounded controls retain glass. Settings and auxiliary content use readable inner widths. Tools and expression panels are anchored above the composer and scroll when short windows constrain their height. Narrow windows continue the modal drawer. See the [confirmed requirement](docs/requirements/2026-09-28-desktop-ui/README.md).

## Local appearance and preferences

The existing blue palette is the default. `src/appearance.css` adds pine green, purple and apricot through the shared tokens while preserving semantic danger/success colors, geometry, materials and system light/dark selection. Preferences use a readable 560px maximum content width, an explanatory introduction and native radio rows with at least 44px targets. Selection applies immediately with inline status/error feedback; no Save footer. Settings are a flat list without local/space group labels. The update banner uses an accent-filled 44px 更新 action. See the [confirmed implementation requirement](docs/requirements/2026-10-10-settings-appearance-desktop/README.md).
