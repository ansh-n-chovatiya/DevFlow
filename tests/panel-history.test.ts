/**
 * Recent, and the two things about it that are not obvious.
 *
 * The first is the key. Deduplicating by *name* is the obvious choice and is
 * wrong on exactly the pages this feature is for: a production build hands back
 * `t` and `e` for half the components on the page, so a name key would fold
 * unrelated entries into one and the drawer would quietly hold three rows where
 * twelve were located.
 *
 * The second is what survives a bad read. This key outlives the code that wrote
 * it, so an entry whose shape has moved on has to be dropped rather than handed
 * to the card — and a storage area that will not answer at all must cost the
 * Recent list and nothing else, because the panel's job is picking components.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { pos0, pos1 } from '../src/core/react/positions.js';
import type { ComponentSource } from '../src/shared/types.js';
import {
  entryKey,
  isEntry,
  loadHistory,
  MAX_ENTRIES,
  mergeEntry,
  readEntries,
  RECENT_KEY,
  saveHistory,
  type HistoryEntry,
} from '../src/ui/locator/history.js';
import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';

let chromeFake: SyncFake | null = null;

afterEach(() => {
  chromeFake?.restore();
  chromeFake = null;
});

function source(over: Partial<ComponentSource> = {}): ComponentSource {
  return { name: 'CartSummary', status: 'resolved', source: 'src/Cart.tsx', line: pos1(9), ...over };
}

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return { component: 'CartSummary', label: 'src/Cart.tsx:9', source: source(), at: 1, ...over };
}

describe('entryKey', () => {
  it('keys on the position, not the name — minified builds reuse names', () => {
    const first = source({ name: 't', source: 'src/Cart.tsx' });
    const second = source({ name: 't', source: 'src/Header.tsx' });

    expect(entryKey(first)).not.toBe(entryKey(second));
  });

  it('prefers the original file, so two bundles of one deploy agree', () => {
    const viaMain = source({
      compiled: { url: 'https://x.test/main.js', line: pos0(1), column: pos0(10) },
    });
    const viaVendor = source({
      compiled: { url: 'https://x.test/vendor.js', line: pos0(4), column: pos0(2) },
    });

    expect(entryKey(viaMain)).toBe(entryKey(viaVendor));
  });

  it('falls back to the name when nothing at all was found', () => {
    // Repeated failures to locate one component are one row, not twelve.
    const missing = source({ status: 'not-found', source: undefined });
    expect(entryKey(missing)).toBe('n:CartSummary');
  });
});

describe('mergeEntry', () => {
  it('moves a re-located component up rather than listing it twice', () => {
    const first = entry({ at: 1 });
    const other = entry({ component: 'Header', source: source({ source: 'src/Header.tsx' }), at: 2 });
    const again = entry({ at: 3, label: 'src/Cart.tsx:9' });

    const list = mergeEntry(mergeEntry([first], other), again);

    expect(list).toHaveLength(2);
    expect(list[0].at).toBe(3);
    expect(list[1].component).toBe('Header');
  });

  it('caps the list, dropping the oldest', () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      list = mergeEntry(list, entry({ at: i, source: source({ source: `src/${i}.tsx` }) }));
    }

    expect(list).toHaveLength(MAX_ENTRIES);
    expect(list[0].at).toBe(MAX_ENTRIES + 4);
  });
});

describe('readEntries', () => {
  it('drops anything that is no longer an entry', () => {
    const stored = [entry(), { component: 'Header' }, null, 'nope', { ...entry(), source: 7 }];
    expect(readEntries(stored)).toHaveLength(1);
  });

  it('treats a value that is not a list as an empty one', () => {
    expect(readEntries({ nope: true })).toEqual([]);
    expect(readEntries(undefined)).toEqual([]);
  });

  it('accepts an unresolved answer, which is a real thing to have located', () => {
    expect(isEntry(entry({ source: source({ status: 'not-found', source: undefined }) }))).toBe(true);
  });
});

describe('storage', () => {
  it('round-trips through the local area under its own key', async () => {
    chromeFake = installChromeSync();

    await saveHistory([entry()]);
    expect(Object.keys(chromeFake.local())).toEqual([RECENT_KEY]);

    expect(await loadHistory()).toEqual([entry()]);
  });

  it('answers with an empty list when there is nothing stored', async () => {
    chromeFake = installChromeSync();
    expect(await loadHistory()).toEqual([]);
  });

  it('costs the Recent list and nothing else when storage will not answer', async () => {
    chromeFake = installChromeSync();
    chromeFake.seedLocal({ [RECENT_KEY]: 'not a list at all' });

    await expect(loadHistory()).resolves.toEqual([]);
  });
});
