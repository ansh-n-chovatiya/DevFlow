/**
 * Settings: storage in, resolved values out.
 *
 * Three rules hold here and in every phase built on top of this file.
 *
 * **Storage holds sparse overrides only, never the resolved object.** The
 * `chrome.storage.sync` area *is* the overrides: one flat dotted key per setting
 * somebody changed, and nothing at all for the rest. Storing the full resolved
 * settings would freeze today's defaults into every installation forever — a
 * better default in a later version would never reach anyone who had opened the
 * Settings screen once — and that mistake is invisible until the day you try to
 * change one. `save()` therefore *removes* a key that is set back to its default
 * rather than writing the default into storage.
 *
 * **`resolve()` is the only validator.** The form validates for a good message;
 * `resolve` validates because storage can hold anything — a value synced from a
 * newer version, a hand-edited profile, a corrupted write, a key this build has
 * never heard of. It is pure, total and clamped: it returns a usable `Settings`
 * for every possible input, including `null` and `undefined`.
 *
 * **Unknown keys are never dropped.** Nothing here rewrites the sync area
 * wholesale, so a key from a newer version survives being read, resolved and
 * written around. `passthrough()` is how a later phase's export gets hold of
 * them; `resolve()` returns only keys this build knows, because a value it
 * cannot clamp is a value it must not hand to the recorder.
 *
 * The three rules are stated here because this is the file everything imports,
 * but the first two are *implemented* in `resolve.ts` — the pure half, split out
 * so the MCP server can import the one validator instead of writing a second.
 * That file explains why; this one re-exports it so no call site had to move.
 *
 * **There is a third layer, and it is read here.** `chrome.storage.managed` is
 * how an administrator pushes an editor and a project root across an
 * organisation. The recorder never had that story; the half of this product that
 * finds a component's source always did, and a merge that dropped it would have
 * broken every one of those deployments without anything going red. So
 * `DEFAULTS ← user ← managed` is the order, managed winning, and the reading
 * happens in this file because `resolve()` may not touch storage — see the note
 * on purity above, which is the same rule for the same reason.
 */

import { getSync, setSync } from '../../chrome/storage.js';
import { flowError } from '../../shared/errors.js';
import { err, ok, type Result } from '../../shared/result.js';
import {
  fieldFor,
  isSettingKey,
  type Field,
  type Overrides,
  type SettingKey,
  type Settings,
} from './fields.js';
import { LEGACY_KEY, legacyOverrides } from './migrate.js';
import { isModified, resolve, resolveField } from './resolve.js';

export {
  isModified,
  modifiedOverrides,
  passthrough,
  resolve,
  resolveField,
} from './resolve.js';

export {
  CONCEPTS,
  conceptInfo,
  consequenceApplies,
  DEFAULTS,
  FIELDS,
  fieldFor,
  fieldsInGroup,
  GROUPS,
  groupInfo,
  HIDDEN_CATEGORIES,
  HIDDEN_KEY_PREFIX,
  hiddenKeyFor,
  isMachineKey,
  isSettingKey,
  MACHINE,
  MACHINE_KEYS,
  machineOverrides,
  WIRED,
  type Concept,
  type ConceptInfo,
  type ConsequenceWhen,
  type Consumer,
  type Field,
  type Group,
  type GroupInfo,
  type MachineKey,
  type MachineSettings,
  type Overrides,
  type SettingKey,
  type Settings,
  type Tier,
} from './fields.js';

export { legacyOverrides, LEGACY_KEY } from './migrate.js';


// ── storage ──────────────────────────────────────────────────────────────────

/**
 * The sync area is the overrides object.
 *
 * Nothing else lives in `chrome.storage.sync` — flows and screenshots are local
 * — so reading the whole area and reading "the settings file" are the same
 * operation, and a key nothing here recognises is simply left where it is.
 */
export async function loadOverrides(): Promise<Overrides> {
  const stored = await getSync({});
  return stored.ok ? (stored.value) : {};
}

/**
 * Storage plus `resolve`. Falls back to defaults when storage cannot be read.
 *
 * Both areas, in one round trip. Reading only `sync` here would have made the
 * policy layer a thing each surface had to remember to ask for, and a surface
 * that forgot would show an administrator's editor on the Settings screen and
 * use the user's own everywhere else.
 */
export async function load(): Promise<Settings> {
  const [overrides, managed] = await Promise.all([loadOverrides(), loadManaged()]);
  return resolve(overrides, managed);
}

/**
 * Write a patch, keeping storage sparse.
 *
 * A value equal to the shipped default is *removed* rather than written, so the
 * area only ever holds what somebody actually changed. Keys outside the patch
 * are untouched, which is what keeps a key from a newer version alive across a
 * save made by an older one.
 */
export async function save(patch: Partial<Settings>): Promise<Result<void>> {
  const writes: Record<string, unknown> = {};
  const removes: string[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (!isSettingKey(key)) {
      return err(flowError('STORAGE_WRITE', `DevFlow: no such setting: ${key}`));
    }
    const field = fieldFor(key) as Field;
    const resolved = resolveField(field, value);
    if (isModified(key, resolved)) writes[key] = resolved;
    else removes.push(key);
  }

  if (removes.length > 0) {
    const cleared = await removeSync(removes);
    if (!cleared.ok) return cleared;
  }
  return Object.keys(writes).length > 0 ? setSync(writes) : ok();
}

/**
 * Make the sync area hold exactly `next` — the import, and the Undo that takes
 * it back.
 *
 * `save()` is a patch and cannot express this: a settings file is a *whole*
 * configuration, and a key the file does not carry has to go back to its
 * default rather than keep whatever this machine happened to have. Otherwise
 * "send me your settings file" hands somebody a configuration that is theirs
 * plus whatever of yours they had already changed, which is nobody's.
 *
 * Two rules it keeps that a naive `clear()` + `set()` would not:
 *
 * **Sparse.** A key in `next` whose value equals the shipped default is
 * *removed*, not written — the same rule `save()` follows, for the same reason.
 * Importing a file that pins all seventy-three values at their defaults leaves an
 * empty area, so a later release's better default still reaches the user.
 *
 * **`keepUnknown` for an import, and not for an Undo.** A key this build does
 * not recognise may be a setting from a newer DevFlow that synced onto this
 * machine, and an import from a colleague running an older build must not
 * delete it — that is the silent-deletion failure with the file and the store
 * swapped round. So an import merges the unknown half and replaces the known
 * half. An Undo passes the previous area verbatim and wants it back exactly,
 * including the absence of a key the import had added.
 */
export async function replaceOverrides(
  next: Overrides,
  options: { readonly keepUnknown?: boolean } = {},
): Promise<Result<void>> {
  const current = await loadOverrides();

  const writes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    const field = fieldFor(key);
    if (!field) {
      writes[key] = value;
      continue;
    }
    const resolved = resolveField(field, value);
    if (isModified(key as SettingKey, resolved)) writes[key] = resolved;
  }

  const removes = Object.keys(current).filter(
    (key) =>
      !Object.hasOwn(writes, key) && (isSettingKey(key) || options.keepUnknown !== true),
  );

  if (removes.length > 0) {
    const cleared = await removeSync(removes);
    if (!cleared.ok) return cleared;
  }
  return Object.keys(writes).length > 0 ? setSync(writes) : ok();
}

function removeSync(keys: string[]): Promise<Result<void>> {
  return new Promise((resolve_) => {
    chrome.storage.sync.remove(keys, () => {
      const lastError = chrome.runtime.lastError;
      resolve_(lastError ? err(flowError('STORAGE_WRITE', lastError.message)) : ok());
    });
  });
}

/**
 * Call `fn` whenever any setting changes, in any surface. Returns an unsubscribe.
 *
 * Deliberately coarse: it re-reads and hands over the whole resolved object
 * rather than a diff. A caller that wanted one field would still have to resolve
 * the rest to know what it was allowed to do with it, and settings change at
 * human speed.
 */
export function subscribe(fn: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    // `managed` as well as `sync`: a policy can be revised while a surface is
    // open, and a screen that only watched the user's own half would keep
    // showing a value the administrator has since replaced.
    if (area !== 'sync' && area !== 'managed') return;
    if (!Object.keys(changes).some((key) => isSettingKey(key) || key === LEGACY_KEY)) return;
    void load().then(fn);
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ── The managed layer ────────────────────────────────────────────────────────

/**
 * Read an area and keep only what this build recognises as a setting.
 *
 * `chrome.storage.managed` is absent outside an enterprise deployment and
 * throws rather than answering empty in some Chrome builds, so the failure is
 * swallowed: no policy is the ordinary case, not an error condition.
 */
async function readManagedArea(): Promise<Record<string, unknown>> {
  try {
    const stored = await chrome.storage.managed.get(null);
    return stored ?? {};
  } catch {
    return {};
  }
}

/**
 * The administrator's overrides, in this build's shape.
 *
 * Two shapes are accepted, and both have to be, for the same reason the
 * migration exists. A policy written against this build pushes flat dotted keys.
 * A policy written against the sibling extension — the ones already deployed,
 * in files nobody is going to edit because a browser extension merged — pushes
 * one blob under `LEGACY_KEY`.
 *
 * The blob half cannot be migrated away the way the user's own is: `managed` is
 * read-only to the extension, so there is nothing here that could rewrite it.
 * An organisation moves to flat keys by editing its policy, on its own schedule,
 * and until it does the old file keeps working. Flat keys win where both are
 * present, because that is the file the administrator wrote most recently.
 */
export async function loadManaged(): Promise<Overrides> {
  const area = await readManagedArea();

  const out: Record<string, unknown> = { ...legacyOverrides(area[LEGACY_KEY]) };
  for (const key of Object.keys(area)) if (isSettingKey(key)) out[key] = area[key];
  return out;
}

/**
 * The settings an administrator has fixed — what the UI shows as locked.
 *
 * A set of keys rather than the values, because that is the whole of what the
 * screen needs: the value is already in the resolved settings, and what the row
 * is missing is *why* it will not accept a keystroke. A control that silently
 * refuses to change is the shape of a bug; a control that says who decided is a
 * policy.
 */
export async function managedKeys(): Promise<ReadonlySet<SettingKey>> {
  const managed = await loadManaged();
  return new Set(Object.keys(managed).filter(isSettingKey));
}

// ── The one-time migration ───────────────────────────────────────────────────

/**
 * Bring a profile forward from the sibling extension's storage shape, once.
 *
 * Idempotent, and idempotent in the way that matters: a second run must not
 * undo a change made *after* the first one. That is not a marker flag — a flag
 * in `local` is per-device, so a second machine syncing the same profile would
 * migrate again with the flag unset, and a flag in `sync` would be a key the
 * settings file has to learn to ignore. It is the two rules below instead.
 *
 * **A key already in the sync area is never overwritten.** If the user has since
 * changed their project root, the sync area holds their answer and the blob's
 * is stale by definition; the blob is the older document, and the older document
 * does not get to win.
 *
 * **The blob is removed when the mapping has landed.** That is what makes the
 * ordinary second run a no-op rather than a decision, and it is what the banned
 * list means by "then it is gone" — after this, the prefix exists nowhere in a
 * migrated profile. Removal last: a removal that succeeded before the write
 * would lose the values outright if the write then failed, and the reverse
 * order costs only a repeat of an operation that is already safe to repeat.
 *
 * Returns the keys it wrote, so a caller can say what happened. An empty array
 * means there was nothing to bring forward — which is the answer on every run
 * but the first, and on every profile that never had the other extension.
 */
export async function migrateLegacySettings(): Promise<readonly SettingKey[]> {
  const stored = await getSync({});
  if (!stored.ok) return [];

  const area = stored.value as Record<string, unknown>;
  if (!Object.hasOwn(area, LEGACY_KEY)) return [];

  const mapped = legacyOverrides(area[LEGACY_KEY]);
  const writes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mapped)) {
    if (!Object.hasOwn(area, key)) writes[key] = value;
  }

  if (Object.keys(writes).length > 0) {
    const written = await setSync(writes);
    // The blob stays where it is. Next run reads it again and writes whatever is
    // still missing, which is exactly the retry this wants.
    if (!written.ok) return [];
  }

  await removeSync([LEGACY_KEY]);
  return Object.keys(writes) as SettingKey[];
}
