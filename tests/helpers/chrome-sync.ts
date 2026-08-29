/**
 * A `chrome.storage.sync` stand-in, faithful in the two ways that matter here.
 *
 * The settings mechanism's central claim is about *storage*, not about
 * resolution: that the area holds a sparse set of overrides and nothing else,
 * and that a key nobody touched is genuinely absent rather than present and
 * equal to the default. That claim cannot be tested against a mock that returns
 * a fixed object — it has to be tested against something that remembers what was
 * written, answers `get(null)` with exactly that, and honours `remove`.
 *
 * The callback style is deliberate: `chrome/storage.ts` wraps callbacks and
 * checks `chrome.runtime.lastError`, and a promise-shaped fake would let a bug
 * in that wrapper through.
 */

interface Change {
  oldValue?: unknown;
  newValue?: unknown;
}

type Listener = (changes: Record<string, Change>, area: string) => void;

export interface SyncFake {
  /** Everything currently stored, which is the overrides object itself. */
  area(): Record<string, unknown>;
  /** Seed storage without going through the mechanism, as a synced profile would. */
  seed(items: Record<string, unknown>): void;
  /** Make the next read fail, the way a locked-down profile does. */
  failReads(message?: string): void;
  /**
   * The `local` area, which holds flows rather than settings.
   *
   * Present because the Settings *screen* reads both — the recording banner and
   * the storage figures come from `local`, the settings from `sync` — and a page
   * test that could only see one of them would be testing half the screen.
   */
  local(): Record<string, unknown>;
  seedLocal(items: Record<string, unknown>): void;
  restore(): void;
}

/** Installs a fake `chrome` global and returns the handle to inspect it. */
export function installChromeSync(seed: Record<string, unknown> = {}): SyncFake {
  let store: Record<string, unknown> = { ...seed };
  let readError: string | null = null;
  const listeners = new Set<Listener>();

  function notify(changes: Record<string, Change>): void {
    for (const listener of [...listeners]) listener(changes, 'sync');
  }

  const sync = {
    get(keys: unknown, callback: (items: Record<string, unknown>) => void): void {
      if (readError !== null) {
        runtime.lastError = { message: readError };
        callback({});
        runtime.lastError = undefined;
        return;
      }
      if (keys === null || keys === undefined) {
        callback({ ...store });
        return;
      }
      // The mechanism only ever reads the whole area; the narrow forms are here
      // so a future caller that uses one is not silently answered with nothing.
      const wanted = Array.isArray(keys)
        ? (keys as string[])
        : typeof keys === 'string'
          ? [keys]
          : Object.keys(keys);
      const out: Record<string, unknown> = {};
      if (typeof keys === 'object' && keys !== null && !Array.isArray(keys)) {
        Object.assign(out, keys);
      }
      for (const key of wanted) if (key in store) out[key] = store[key];
      callback(out);
    },

    set(items: Record<string, unknown>, callback: () => void): void {
      const changes: Record<string, Change> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: store[key], newValue: value };
      }
      store = { ...store, ...items };
      callback();
      notify(changes);
    },

    remove(keys: string | string[], callback: () => void): void {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, Change> = {};
      for (const key of list) {
        if (!(key in store)) continue;
        changes[key] = { oldValue: store[key] };
        delete store[key];
      }
      callback();
      if (Object.keys(changes).length > 0) notify(changes);
    },
  };

  /** The same shape again, over a separate store, for the `local` area. */
  let localStore: Record<string, unknown> = {};

  const localArea = {
    get(keys: unknown, callback: (items: Record<string, unknown>) => void): void {
      if (keys === null || keys === undefined) {
        callback({ ...localStore });
        return;
      }
      // The `local` callers only ever pass an array or a single key; an object
      // of defaults is a `sync` shape and would silently read as its keys here.
      const wanted = Array.isArray(keys) ? (keys as string[]) : typeof keys === 'string' ? [keys] : [];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (key in localStore) out[key] = localStore[key];
      callback(out);
    },
    set(items: Record<string, unknown>, callback: () => void): void {
      const changes: Record<string, Change> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: localStore[key], newValue: value };
      }
      localStore = { ...localStore, ...items };
      callback();
      for (const listener of [...listeners]) listener(changes, 'local');
    },
    remove(keys: string | string[], callback: () => void): void {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, Change> = {};
      for (const key of list) {
        if (!(key in localStore)) continue;
        changes[key] = { oldValue: localStore[key] };
        delete localStore[key];
      }
      callback();
      if (Object.keys(changes).length > 0) {
        for (const listener of [...listeners]) listener(changes, 'local');
      }
    },
    getBytesInUse(_keys: unknown, callback: (bytes: number) => void): void {
      callback(JSON.stringify(localStore).length);
    },
  };

  const runtime: {
    lastError?: { message: string };
    getManifest: () => { version: string };
    getURL: (path: string) => string;
  } = {
    getManifest: () => ({ version: '0.0.0-test' }),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  };

  const previous = (globalThis as { chrome?: unknown }).chrome;

  (globalThis as { chrome?: unknown }).chrome = {
    runtime,
    storage: {
      sync,
      local: localArea,
      onChanged: {
        addListener: (fn: Listener) => listeners.add(fn),
        removeListener: (fn: Listener) => listeners.delete(fn),
      },
    },
  };

  return {
    area: () => ({ ...store }),
    seed: (items) => {
      store = { ...store, ...items };
    },
    failReads: (message = 'storage unavailable') => {
      readError = message;
    },
    local: () => ({ ...localStore }),
    seedLocal: (items) => {
      localStore = { ...localStore, ...items };
    },
    restore: () => {
      (globalThis as { chrome?: unknown }).chrome = previous;
    },
  };
}
