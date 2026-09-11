# Quiet Room Design System

Quiet Room uses a restrained Liquid Glass inspired system for an encrypted one-to-one chat. The material is a supporting layer: messages, delivery state and privacy state remain the visual priority, and the existing information architecture stays unchanged.

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
- The chat tools grid remains the existing six-entry workflow. Its panel is a single surface with icon-first controls.
- Gallery and device pages reuse the same material tokens without introducing new navigation or product concepts.

## Motion

Existing lifecycle and keyboard motion remain authoritative. The design layer only adds visual feedback and uses the existing `--motion-out` curve. Decorative transitions are disabled when `prefers-reduced-motion: reduce` is active. CSS layout properties are not animated.

## Accessibility and Performance

The system preserves keyboard focus rings, semantic colors, native text selection and the existing 44px target minimum. Backdrop filters are limited to bounded controls and panels; reduced-transparency and forced-colors modes remove the filter. No third-party analytics, remote assets or runtime observers are introduced.

## Verification

Visual checks should cover the unlocked chat, tools panel, message menu, gallery tabs, device page, light/dark themes, narrow mobile width, desktop width, reduced motion, reduced transparency and forced colors. Behavioral checks remain the existing browser suites because this layer does not change message, attachment, privacy or navigation logic.
