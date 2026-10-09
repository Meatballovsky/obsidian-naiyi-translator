# Changelog

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
