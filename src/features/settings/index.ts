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
import { isModified, resolve, resolveField } from './resolve.js';

export {
  isModified,
  modifiedOverrides,
  passthrough,
  resolve,
  resolveField,
} from './resolve.js';

export {
  consequenceApplies,
  DEFAULTS,
  FIELDS,
  fieldFor,
  fieldsInGroup,
  GROUPS,
  groupInfo,
  isMachineKey,
  isSettingKey,
  MACHINE,
  MACHINE_KEYS,
  machineOverrides,
  WIRED,
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

/** Storage plus `resolve`. Falls back to defaults when storage cannot be read. */
export async function load(): Promise<Settings> {
  return resolve(await loadOverrides());
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
      return err(flowError('STORAGE_WRITE', `FlowSnap: no such setting: ${key}`));
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
 * not recognise may be a setting from a newer FlowSnap that synced onto this
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
    if (area !== 'sync') return;
    if (!Object.keys(changes).some(isSettingKey)) return;
    void load().then(fn);
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
