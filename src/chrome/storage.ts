/**
 * The only place `chrome.storage` is called.
 *
 * Every read and write checks `chrome.runtime.lastError` and turns it into a
 * `Result`. Storage has a 10 MB ceiling and no `unlimitedStorage` permission, so
 * a full area is a normal condition to handle, not an exceptional one — before
 * this, `set()` failed silently at the limit and the UI carried on as if the
 * step had been saved.
 */

import { flowError, isQuotaMessage } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';
import type { LocalStorageShape, SyncStorageShape } from '../shared/types.js';

/**
 * Reads never fail loudly enough to block the UI, but they are still reported.
 *
 * The `try` is for the area itself being absent rather than the read failing:
 * `chrome.storage.sync` is not there in every context this code runs in, and a
 * throw from `area.get` escapes the promise as a rejection — which is not the
 * `Result` every caller here is written against. `load()` documents that it
 * falls back to the defaults when storage cannot be read, and before this it
 * did so only for the failures Chrome reports politely.
 */
function read<T>(area: chrome.storage.StorageArea, keys: string | string[] | null): Promise<Result<T>> {
  return new Promise((resolve) => {
    try {
      area.get(keys, (items) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve(err(flowError('STORAGE_READ', lastError.message)));
          return;
        }
        resolve(ok(items as T));
      });
    } catch (error) {
      resolve(err(flowError('STORAGE_READ', error instanceof Error ? error.message : error)));
    }
  });
}

function write(
  area: chrome.storage.StorageArea,
  items: Record<string, unknown>,
): Promise<Result<void>> {
  return new Promise((resolve) => {
    area.set(items, () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve(err(flowError(isQuotaMessage(lastError.message) ? 'STORAGE_QUOTA' : 'STORAGE_WRITE', lastError.message)));
        return;
      }
      resolve(ok());
    });
  });
}

export function getLocal(
  keys: string | string[],
): Promise<Result<Partial<LocalStorageShape> & Record<string, unknown>>> {
  return read(chrome.storage.local, keys);
}

/**
 * Every key in the local area, whatever it is called.
 *
 * Only "Delete all flows" needs this, and it needs it precisely because the
 * index can be incomplete: a save whose index write failed leaves a
 * `savedFlow_<id>` key that `savedFlowsMeta` never named. Ids are minted from
 * the clock so they never repeat, which means nothing will ever overwrite it —
 * a key nothing can name is a key nothing can free, and sweeping the whole area
 * is the only way to find one.
 *
 * It reads the flows themselves as well as their names, so it belongs on a
 * button the user pressed, never on a refresh.
 */
export function getAllLocal(): Promise<Result<Record<string, unknown>>> {
  return read(chrome.storage.local, null);
}

/**
 * The names of every key in the local area, without reading a byte of what they
 * hold.
 *
 * `getAllLocal` is the only other way to learn what exists, and it reads the
 * values too — every archived flow, every screenshot in it. Anything that wants
 * to *find* keys rather than read them (the screenshot sweep) would pay
 * hundreds of megabytes for a list of strings.
 *
 * `getKeys` landed in Chrome 130 and the extension supports 116, so `null` is a
 * real answer meaning "this browser cannot do it cheaply" — distinct from `[]`,
 * which means the area is empty. Callers that get `null` fall back to whatever
 * they can derive; they must not read the world instead.
 */
export function getLocalKeys(): Promise<Result<string[] | null>> {
  const area = chrome.storage.local as chrome.storage.LocalStorageArea & {
    getKeys?: (callback: (keys: string[]) => void) => void;
  };
  if (typeof area.getKeys !== 'function') return Promise.resolve(ok(null));

  return new Promise((resolve) => {
    area.getKeys((keys) => {
      const lastError = chrome.runtime.lastError;
      resolve(lastError ? err(flowError('STORAGE_READ', lastError.message)) : ok(keys));
    });
  });
}

export function setLocal(
  items: Partial<LocalStorageShape> | Record<string, unknown>,
): Promise<Result<void>> {
  return write(chrome.storage.local, items);
}

export function removeLocal(keys: string | string[]): Promise<Result<void>> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => {
      const lastError = chrome.runtime.lastError;
      resolve(lastError ? err(flowError('STORAGE_WRITE', lastError.message)) : ok());
    });
  });
}

export function getSync<T extends Partial<SyncStorageShape>>(defaults: T): Promise<Result<T>> {
  return read(chrome.storage.sync, null).then((result) => {
    if (!result.ok) return result;
    return ok({ ...defaults, ...(result.value as Partial<T>) });
  });
}

export function setSync(items: Partial<SyncStorageShape>): Promise<Result<void>> {
  return write(chrome.storage.sync, items);
}

/**
 * Bytes currently used by the local area, across every key. `null` when Chrome
 * would not say.
 *
 * It used to answer `0` for a failure, on the grounds that it only fed a budget
 * guard. It does not: the viewer footer and the Settings page both print this
 * figure, and `0 B stored` under a library of eight flows is not a missing
 * guard, it is a lie that reads as "plenty of room". `null` is the honest
 * answer, and every display already has somewhere to put "we don't know" —
 * the footer hides, Settings says so. A caller that genuinely wants a number to
 * compare against a budget can coerce it at its own call site, where "unknown
 * counts as zero" is a decision somebody made rather than one hidden in here.
 */
export function bytesInUse(): Promise<number | null> {
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(null, (bytes) => {
      resolve(chrome.runtime.lastError ? null : bytes);
    });
  });
}
