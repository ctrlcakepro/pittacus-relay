// Appearance preferences shared by every layer. Kept free of Electron and the DOM like src/core.
// The colors themselves live in the renderer's styles.css, keyed by these IDs.

export const THEMES = ['system', 'light', 'dark'] as const
/** "system" follows the OS light/dark setting. */
export type ThemePref = (typeof THEMES)[number]

/** Pittacus violet first (the default), then Apple's system colors in macOS accent-picker order. */
export const ACCENTS = ['violet', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'teal', 'graphite'] as const
export type Accent = (typeof ACCENTS)[number]

export const DEFAULT_ACCENT: Accent = 'violet'

export function isThemePref(value: unknown): value is ThemePref {
  return (THEMES as readonly unknown[]).includes(value)
}

export function isAccent(value: unknown): value is Accent {
  return (ACCENTS as readonly unknown[]).includes(value)
}
