/**
 * Theme preference: read it, apply it, keep every open surface in step.
 *
 * The preference is canonically in `chrome.storage.sync` so it follows the user
 * between machines. That store is asynchronous, though, and an extension page
 * cannot run an inline script to beat first paint — the default MV3 policy is
 * `script-src 'self'`. So the choice is mirrored into `localStorage`, which is
 * synchronous and per-profile, and read from there at import time. Sync remains
 * the authority; the mirror only exists to stop an explicit light choice from
 * flashing dark (or the reverse) on a machine whose OS disagrees.
 */

import { THEME_MIRROR_KEY } from '../shared/constants.js';
import { DEFAULTS, load, resolve, save } from '../features/settings/index.js';
import type { Result } from '../shared/result.js';
import type { ThemePreference } from '../shared/types.js';

export const DEFAULT_THEME: ThemePreference = DEFAULTS.theme;

/**
 * Narrow untrusted input — storage outlives the code that wrote it.
 *
 * Delegates to `resolve()` rather than keeping its own list of themes, because
 * `resolve` is the only validator: the field table already says what a theme may
 * be, and a second copy of that list here is a second thing to update. The
 * `localStorage` mirror is exactly the untrusted input this is for — it is
 * per-profile, synchronous, and written by whatever version last ran.
 */
export function asTheme(value: unknown): ThemePreference {
  return resolve({ theme: value }).theme;
}

/**
 * `system` deliberately removes the attribute rather than setting it: the token
 * file resolves an unstamped document through `prefers-color-scheme`, and a
 * stamped one always wins over it.
 *
 * `systemAs` is the one surface where "system" does not mean the OS.
 *
 * A DevTools panel inherits DevTools' own light/dark setting, which the user
 * chooses independently of the operating system — so a panel obeying
 * `prefers-color-scheme` sits inside a dark DevTools window wearing the light
 * palette, and the two halves of one window disagree. The panel passes
 * `chrome.devtools.panels.themeName` here, and `system` resolves against that
 * instead. Every other surface calls this with one argument and is unchanged.
 *
 * Note what this deliberately does *not* do: an explicit `light` or `dark`
 * still wins outright, on the panel as everywhere else. DevTools' theme is what
 * `system` means, not an override of what the user asked for — the setting is
 * the product's own and it is not a suggestion. See docs/CONTRACTS.md §3.5.
 */
export function applyTheme(theme: ThemePreference, systemAs?: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (theme !== 'system') root.setAttribute('data-theme', theme);
  else if (systemAs) root.setAttribute('data-theme', systemAs);
  else root.removeAttribute('data-theme');
}

function readMirror(): ThemePreference {
  try {
    return asTheme(localStorage.getItem(THEME_MIRROR_KEY));
  } catch {
    // Storage can be unavailable when the profile is locked down. Not worth
    // failing a page load over; the sync read a moment later will correct it.
    return DEFAULT_THEME;
  }
}

function writeMirror(theme: ThemePreference): void {
  try {
    localStorage.setItem(THEME_MIRROR_KEY, theme);
  } catch {
    // Same: the mirror is an optimisation, never the source of truth.
  }
}

/** The stored preference, and the mirror brought back into line with it. */
export async function loadTheme(): Promise<ThemePreference> {
  const theme = (await load()).theme;
  writeMirror(theme);
  return theme;
}

export async function saveTheme(theme: ThemePreference): Promise<Result<void>> {
  // Mirror first: it is what the next page load reads before sync answers.
  writeMirror(theme);
  applyTheme(theme);
  // `save()` removes the key when the choice is the default, so a user who
  // picks "System" leaves nothing behind — see the sparseness rule in
  // `features/settings/index.ts`.
  return save({ theme });
}

/**
 * Apply the theme as early as the page can, then reconcile.
 *
 * Call at the top of every entry point, before anything renders. Also watches
 * sync, so changing the setting in one tab repaints the popup and the viewer
 * without either of them being reopened.
 */
export function initTheme(): void {
  applyTheme(readMirror());

  void loadTheme().then(applyTheme);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !('theme' in changes)) return;
    const next = asTheme(changes.theme?.newValue);
    writeMirror(next);
    applyTheme(next);
  });
}
