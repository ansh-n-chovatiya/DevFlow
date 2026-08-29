/**
 * An import that is waiting for a recording to finish.
 *
 * The last rule falls out of the freeze: **import during a recording is refused**,
 * because settings are frozen for the duration of a recording and applying a
 * file mid-flow would produce exactly the half-and-half recording the freeze forbids —
 * ten steps under one body cap, ten under another, and nothing in the flow
 * saying so. The dialog offers *Apply when this recording stops* instead.
 *
 * That offer has to be kept by something that is still running when the
 * recording stops, and the Settings page is not: the ordinary shape of this is
 * that somebody opens Settings, imports, is told to wait, closes the tab, and
 * presses Stop in the popup twenty minutes later. So the file is parked in
 * `chrome.storage.local` and the **service worker** applies it, off the
 * `recordingActive` transition it already listens to. The page only shows that
 * it is parked, and offers to take the offer back.
 *
 * The parked object is the *plan's* overrides — already resolved, clamped and
 * made sparse by `planImport` — so what lands twenty minutes later is exactly
 * what the diff the user confirmed said it would be. Re-deriving it at apply
 * time from the file's raw text would let a value the user never saw through,
 * which is the one thing the confirmation step exists to prevent.
 */

import { getLocal, removeLocal, setLocal } from '../../chrome/storage.js';
import { ok, type Result } from '../../shared/result.js';
import { replaceOverrides } from './index.js';
import type { Overrides } from './fields.js';

/** The local-storage key the parked import lives under. */
export const PENDING_SETTINGS_KEY = 'pendingSettings';

/** A confirmed import, held until the current recording stops. */
export interface PendingImport {
  /** Exactly what `replaceOverrides` will be given. */
  readonly overrides: Overrides;
  /** How many settings the confirmed diff said would change. For the banner. */
  readonly changes: number;
}

function isPending(value: unknown): value is PendingImport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const held = value as Record<string, unknown>;
  return (
    typeof held.overrides === 'object' &&
    held.overrides !== null &&
    !Array.isArray(held.overrides) &&
    typeof held.changes === 'number'
  );
}

/** The parked import, or `null`. Anything malformed reads as nothing parked. */
export async function readPending(): Promise<PendingImport | null> {
  const stored = await getLocal([PENDING_SETTINGS_KEY]);
  if (!stored.ok) return null;
  const held = stored.value[PENDING_SETTINGS_KEY];
  return isPending(held) ? held : null;
}

export function writePending(pending: PendingImport): Promise<Result<void>> {
  return setLocal({ [PENDING_SETTINGS_KEY]: pending });
}

export function clearPending(): Promise<Result<void>> {
  return removeLocal(PENDING_SETTINGS_KEY);
}

/**
 * Apply the parked import, if there is one. Returns what it applied.
 *
 * Cleared **before** the write rather than after: a failed `chrome.storage.sync`
 * write that left the key in place would be retried on the next recording that
 * stopped, and the recording after that, forever — a settings file the user
 * confirmed once quietly reapplying itself every time they finished recording is
 * a far worse failure than one import that did not land and said so.
 *
 * `keepUnknown`, like every other import: a key from a newer FlowSnap that
 * synced onto this machine did not come from this file and is not this file's
 * to delete.
 */
export async function applyPending(): Promise<Result<PendingImport | null>> {
  const pending = await readPending();
  if (!pending) return ok(null);

  await clearPending();

  const written = await replaceOverrides(pending.overrides, { keepUnknown: true });
  return written.ok ? ok(pending) : written;
}
