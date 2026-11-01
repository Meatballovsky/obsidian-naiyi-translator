# Changelog

## 0.1.7

- Enforce concurrent logical tasks and real HTTP attempts independently from request launch rate. Retries and individual batch fallbacks use the same transport limiter.
- Keep real requests counted until the underlying transport settles, including after a timeout or logical cancellation. Propagate session cancellation to prevent queued requests and AI fallback attempts from starting.
- Protect common inline code, math, URLs, Markdown destinations, wiki links, line breaks, and standalone separators with verified placeholders. Preserve code and link syntax when collecting rendered paragraphs.
- Reject missing/duplicated placeholders and empty output before caching. Conservatively flag long non-Chinese prose returned for a Chinese target; short labels and mixed-language sources remain permissive. Validation failures use the configured retry budget.
- Version translation cache identities to avoid reusing earlier unprotected results. No note files are modified.

## 0.1.6

- Clear translated sections even when the reading view temporarily parks them outside the live DOM.
- Cancel in-flight tasks logically as well as queued tasks, preventing late failures and retries from affecting a new translation session.
- Ignore callbacks from retired viewport observers and preserve pending viewport targets when the preload margin changes.
- Recreate a removed floating button, reset sessions after preview-root replacement, and recover cleanly from failed startup.
- Added regressions for parked blocks, late failures, observer replacement, and repeated toggles across preview reconstruction.

## 0.1.5

- Addressed community review errors: removed redundant manifest wording, gave each Markdown translation its own disposable render component, sanitized embedded SVGs, used native settings headings, and replaced direct orb style assignments with DOM helpers.
- Use the app's language API and window timers; replaced the build dependency on builtin-modules with Node's builtinModules.
- Require Obsidian 1.8.7 for the app-language API. Removed newer slider calls and retained the imperative settings UI for versions before 1.13.
- Added English installation and usage instructions while preserving the original Chinese introduction.

## 0.1.4

- Simplified the floating frog to one translation-layer toggle. Click or tap once to enable scroll-loaded translations; click again to cancel pending work and remove translations.
- Removed the hover menu, selection translation command, and automatic selection translation setting. Switching notes resets the layer to off; cached results can be reused when enabled again.
- Fixed repeated off/on clicks and rapid toggling during session startup. Native button activation supports keyboard and assistive clicks; dragging does not toggle translations.
- Fixed the grayscale frog SVG so it renders correctly, and made dock positioning responsive to pane size.
- Replaced full cards with text-following gray/ivory shading. Fixed empty shaded lines between Markdown paragraphs and quotes.
- Updated existing translations when switching light/dark mode or changing theme styles.
- Validated with 47 offline tests, a production build, and desktop Obsidian interaction checks. Physical mobile-device testing remains pending.

## 0.1.3

Added interface localization, translation style options, and flat frog artwork. The interaction and rendering fixes above are available in 0.1.4.
