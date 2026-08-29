/**
 * Recent — the panel's memory of what has already been located.
 *
 * The problem it solves is small and constant: a pick destroys the one before
 * it. You locate a component, follow it into your editor, come back to compare
 * it with the thing next to it, and the answer you had is gone. So the last
 * dozen are kept, and going back to one costs a click rather than another pick.
 *
 * ## What an entry holds, and why it is a `ComponentSource`
 *
 * The whole of it. `ComponentSource` is what the shared result card renders
 * (`ui/components/result-card.ts`), so restoring an entry is handing the card
 * the same object it was handed the first time — not a summary of it that has to
 * be re-resolved, and not a second shape meaning the same thing. The trees are
 * deliberately *not* stored: they describe the pick that is currently on the
 * page, and a chain of components from a document that has since navigated is a
 * list of rows that highlight nothing.
 *
 * ## Where it is stored
 *
 * `chrome.storage.local`, under one key of its own. It is not in
 * `LocalStorageShape` because that type describes the recording — the steps, the
 * screenshots, the component table a flow ships — and this is a panel
 * convenience with no place in any of it. The upstream key was namespaced to the
 * other product and does not come across (CONTRACTS §4.5).
 *
 * Failure is swallowed at both ends, on purpose. A full storage area or a
 * profile that refuses to write should cost the Recent list and nothing else:
 * the panel's job is picking components, and it must still do that when this
 * cannot be saved.
 */

import { getLocal, setLocal } from '../../chrome/storage.js';
import type { ComponentSource } from '../../shared/types.js';

/** One located component, as the drawer lists it and the card re-renders it. */
export interface HistoryEntry {
  /** The component's name, as React knew it. */
  component: string;
  /** The path shown beside the name — `pathText`, or a sentence when there is none. */
  label: string;
  /** Everything the card needs, unchanged from when it was first rendered. */
  source: ComponentSource;
  /** When it was located, so the newest is unambiguous after a reload. */
  at: number;
}

/**
 * Twelve. Long enough to cover an afternoon of moving between a handful of
 * components, short enough that the drawer is a list somebody can read rather
 * than one they have to search.
 */
export const MAX_ENTRIES = 12;

export const RECENT_KEY = 'devflow.recentComponents';

/**
 * What makes two entries the same component.
 *
 * The *position*, not the name. A minified build hands back `t` for half the
 * components on the page, so keying by name would collapse unrelated entries
 * into one; and the same component located twice from two different rows of the
 * tree is genuinely one entry, which keying by anything finer would miss.
 *
 * The original file wins over the compiled position when there is one, because
 * two bundles of the same deploy hold the same file at different offsets.
 */
export function entryKey(source: ComponentSource): string {
  if (source.source) return `o:${source.source}:${source.line ?? 0}:${source.column ?? 0}`;
  if (source.compiled) {
    return `c:${source.compiled.url}:${source.compiled.line}:${source.compiled.column}`;
  }
  // Nothing was found at all. There is no position to key on, so the name is
  // all there is — which correctly collapses repeated failures to locate the
  // same component into one row rather than filling the drawer with them.
  return `n:${source.name}`;
}

/**
 * The list with one entry brought to the front.
 *
 * Pure, and the only place the ordering rule lives: newest first, one row per
 * component, capped. Re-locating something already in the list moves it up
 * rather than duplicating it — the second answer is the current one, and two
 * rows for one component is the list starting to lie about how much is in it.
 */
export function mergeEntry(
  entries: readonly HistoryEntry[],
  entry: HistoryEntry,
): HistoryEntry[] {
  const key = entryKey(entry.source);
  return [entry, ...entries.filter((existing) => entryKey(existing.source) !== key)].slice(
    0,
    MAX_ENTRIES,
  );
}

/**
 * Whether a stored value is still an entry.
 *
 * Storage outlives the code that wrote it, and this key survives an upgrade. An
 * entry whose shape has moved on is dropped rather than rendered: the drawer is
 * a convenience, and half of one is worse than none.
 */
export function isEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<HistoryEntry>;

  return (
    typeof entry.component === 'string' &&
    typeof entry.label === 'string' &&
    typeof entry.at === 'number' &&
    !!entry.source &&
    typeof entry.source === 'object' &&
    typeof entry.source.name === 'string' &&
    typeof entry.source.status === 'string'
  );
}

/** Everything stored that still reads as an entry, newest first. */
export function readEntries(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isEntry).slice(0, MAX_ENTRIES);
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  const stored = await getLocal(RECENT_KEY);
  return stored.ok ? readEntries(stored.value[RECENT_KEY]) : [];
}

/** Persists the list. The result is deliberately not surfaced — see the header. */
export async function saveHistory(entries: readonly HistoryEntry[]): Promise<void> {
  await setLocal({ [RECENT_KEY]: entries });
}
