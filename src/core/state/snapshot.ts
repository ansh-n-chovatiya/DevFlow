/**
 * A bounded, JSON-safe copy of a live value read out of an app's store.
 *
 * ## Sorted keys, then the cut
 *
 * Every snapshot exists to be diffed against another one, so the property that
 * matters more than fidelity is that **the same value snapshots to the same
 * structure twice**. The one place that is easy to lose is the width cut. Taking
 * the first `maxKeys` keys in insertion order makes the surviving subset a
 * function of the store's mutation history: an app that deletes `zebra` and puts
 * it back has reordered its own object, and a 41-key store then snapshots to a
 * different 40 keys before and after a step that touched neither. The diff of
 * those two is a page of adds and removes for changes the app never made — and
 * it is indistinguishable from real ones, which is the failure that matters.
 *
 * So keys are sorted lexicographically *before* `maxKeys` is applied. The subset
 * is then chosen by name alone, is stable across mutation, and the diff of two
 * bounded snapshots names only what actually moved. Arrays are cut at
 * `maxEntries` from the front, where order is the app's own and already stable.
 *
 * ## The cap bit rides beside the value
 *
 * `NetworkCall` carries `requestBodyTruncated` next to `requestBody` rather than
 * appending an ellipsis inside it, because a marker inside a value is a value —
 * it gets diffed, re-truncated and read back as content. The same rule holds
 * here: a capped string is cut at `stringCap` with nothing appended, and the
 * fact that something was cut travels as `bounded` on the result. `bounded` is
 * snapshot-wide because that is the finest granularity a single copy can carry:
 * per-node flags would have to live inside the value, which is the thing this
 * rule forbids. A reader that sees `bounded` knows only that some subtree reads
 * as unchanged whether or not it changed — which is exactly the claim a state
 * diff must never make silently.
 *
 * The sentinels below are strings an app would not plausibly store, so a reader
 * can tell "DevFlow could not represent this" from "the app's value was that".
 *
 * ## Secrets are masked here, not later
 *
 * A store holds whatever the app put in it, and on a real app that includes the
 * session token and the user's address. Nothing downstream can tell a secret
 * from a string once it is inside the value, so `secretKey` is consulted at the
 * only moment the *name* is still in hand. As in `src/core/redact/index.ts`, the
 * key survives and only the value is replaced, and the property is masked before
 * it is read — a secret is never walked, never costs depth or width, and its
 * getter is never called.
 *
 * Masking does not set `bounded`, and that distinction is the subtle one.
 * `bounded` means *a value may have changed without this snapshot showing it*;
 * a masked value is not that. The same key masks to the same string every time,
 * so two snapshots of a store whose token was rotated diff as unchanged — which
 * is the honest answer, because the token is not what the reader is being shown.
 * Routing masking through the truncation path would flag every step of every
 * app that stores a password field as incomplete, and `bounded` would stop
 * meaning anything.
 *
 * Pure — no DOM, no Chrome, no clock. Nothing here reads a global; the only
 * things touched are the value handed in and the budget.
 */

/** What one snapshot may cost. Callers pass the `STATE_*` constants. */
export interface SnapshotBudget {
  /** Levels below the root that are walked. Deeper values become `'[depth]'`. */
  maxDepth: number;
  /** Keys kept from one object, taken after sorting. */
  maxKeys: number;
  /** Entries kept from one array, `Map` or `Set`. */
  maxEntries: number;
  /** Characters kept from one string. */
  stringCap: number;
  /**
   * Property names whose value is a credential or personal data.
   * The key is kept, the value is replaced. Optional: omitted means mask nothing.
   */
  secretKey?: (key: string) => boolean;
}

export interface SnapshotResult {
  /** JSON-safe: null | boolean | number | string | array | plain object. Nothing else. */
  value: unknown;
  /** A depth, width, or string cap bit somewhere in the value. */
  bounded: boolean;
}

const DEPTH = '[depth]';
const CIRCULAR = '[circular]';
const FUNCTION = '[function]';
const SYMBOL = '[symbol]';
const DOM = '[dom]';
const PROMISE = '[promise]';
const UNREADABLE = '[unreadable]';

/** The same mask `src/core/redact/index.ts` writes, so one string means one thing. */
const MASK = '[redacted]';

/** A caller's predicate is a caller's code, and one that throws masks nothing. */
function isSecret(key: string, budget: SnapshotBudget): boolean {
  if (!budget.secretKey) return false;
  try {
    return budget.secretKey(key) === true;
  } catch {
    return false;
  }
}

/**
 * Read one property without letting a throwing getter take the snapshot down.
 *
 * A store built on a proxy, a lazily-hydrated model or a revoked object throws
 * on access, and losing a whole step's state to one hostile key would be a worse
 * answer than naming that key unreadable.
 */
function readProp(host: object, key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: (host as Record<string, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

/** A probe used only to classify — a throw means "not that kind of object". */
function probe(host: object, key: string): unknown {
  const read = readProp(host, key);
  return read.ok ? read.value : undefined;
}

/** `-0` collapses to `0` and non-finite numbers to `null`, as JSON has neither. */
function normaliseNumber(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : n;
}

function capString(raw: string, cap: number, mark: () => void): string {
  const limit = cap > 0 ? cap : 0;
  if (raw.length <= limit) return raw;
  mark();
  return raw.slice(0, limit);
}

function walk(
  raw: unknown,
  budget: SnapshotBudget,
  depth: number,
  ancestors: object[],
  mark: () => void,
): unknown {
  if (depth > budget.maxDepth) {
    mark();
    return DEPTH;
  }

  switch (typeof raw) {
    case 'undefined':
      // Only reachable at the root or inside an array; an `undefined` property
      // is dropped by the caller before it gets here.
      return null;
    case 'boolean':
      return raw;
    case 'number':
      return normaliseNumber(raw);
    case 'string':
      return capString(raw, budget.stringCap, mark);
    case 'bigint':
      // Decimal, not a Number: a bigint is in a store because it did not fit.
      return raw.toString();
    case 'symbol':
      return SYMBOL;
    case 'function':
      return FUNCTION;
  }

  if (raw === null) return null;
  const obj = raw as object;

  /*
   * The ancestor path, not a set of everything seen. A store that hands the same
   * config object to four slices is a DAG, not a cycle, and reporting three of
   * those four as `'[circular]'` would delete real state and make the snapshot
   * depend on key order to boot.
   */
  if (ancestors.includes(obj)) {
    mark();
    return CIRCULAR;
  }

  if (Array.isArray(obj)) return walkArray(obj, budget, depth, ancestors, mark);

  /*
   * The brand tag rather than `instanceof`: values arrive from a page, and a
   * `Date` constructed in an iframe is not `Date`. The tag reflects the internal
   * slot, which is what the branches below actually depend on.
   */
  const tag = Object.prototype.toString.call(obj);

  if (tag === '[object Date]') {
    try {
      return Date.prototype.toISOString.call(obj as Date);
    } catch {
      // An invalid Date has no ISO form; `JSON.stringify` writes null for it too.
      return null;
    }
  }
  if (tag === '[object RegExp]') {
    return capString(RegExp.prototype.toString.call(obj as RegExp), budget.stringCap, mark);
  }
  if (tag === '[object Error]') {
    const name = probe(obj, 'name');
    const message = probe(obj, 'message');
    return {
      name: capString(typeof name === 'string' ? name : 'Error', budget.stringCap, mark),
      message: capString(typeof message === 'string' ? message : '', budget.stringCap, mark),
    };
  }
  if (tag === '[object Map]') return walkPairs(obj, budget, depth, ancestors, mark);
  if (tag === '[object Set]') return walkSet(obj, budget, depth, ancestors, mark);

  // A DOM node in a store is common, enormous, and worth nothing to a reader of
  // a diff — the element the step touched is recorded properly elsewhere.
  if (typeof probe(obj, 'nodeType') === 'number') return DOM;

  // A thenable's *settled* value is not readable without waiting, and a snapshot
  // does not get to wait.
  if (typeof probe(obj, 'then') === 'function') return PROMISE;

  return walkObject(obj, budget, depth, ancestors, mark);
}

function walkArray(
  items: unknown[],
  budget: SnapshotBudget,
  depth: number,
  ancestors: object[],
  mark: () => void,
): unknown[] {
  let length = items.length;
  if (length > budget.maxEntries) {
    mark();
    length = budget.maxEntries > 0 ? budget.maxEntries : 0;
  }

  ancestors.push(items);
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const read = readProp(items, String(i));
    if (!read.ok) {
      mark();
      out.push(UNREADABLE);
      continue;
    }
    out.push(walk(read.value, budget, depth + 1, ancestors, mark));
  }
  ancestors.pop();
  return out;
}

/**
 * `Map` as `{ '[Map]': [[k, v], …] }`.
 *
 * The wrapper is presentation, not nesting: entries are walked at the map's own
 * depth + 1, so a `Map` costs the same depth budget as the object an app would
 * have used instead.
 */
function walkPairs(
  obj: object,
  budget: SnapshotBudget,
  depth: number,
  ancestors: object[],
  mark: () => void,
): unknown {
  let entries: [unknown, unknown][];
  try {
    entries = [...(obj as Map<unknown, unknown>).entries()];
  } catch {
    mark();
    return UNREADABLE;
  }

  let length = entries.length;
  if (length > budget.maxEntries) {
    mark();
    length = budget.maxEntries > 0 ? budget.maxEntries : 0;
  }

  ancestors.push(obj);
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const [key, value] = entries[i];
    out.push([
      walk(key, budget, depth + 1, ancestors, mark),
      walk(value, budget, depth + 1, ancestors, mark),
    ]);
  }
  ancestors.pop();
  return { '[Map]': out };
}

/** `Set` as `{ '[Set]': [ … ] }`, on the same terms as `Map`. */
function walkSet(
  obj: object,
  budget: SnapshotBudget,
  depth: number,
  ancestors: object[],
  mark: () => void,
): unknown {
  let items: unknown[];
  try {
    items = [...(obj as Set<unknown>).values()];
  } catch {
    mark();
    return UNREADABLE;
  }

  let length = items.length;
  if (length > budget.maxEntries) {
    mark();
    length = budget.maxEntries > 0 ? budget.maxEntries : 0;
  }

  ancestors.push(obj);
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    out.push(walk(items[i], budget, depth + 1, ancestors, mark));
  }
  ancestors.pop();
  return { '[Set]': out };
}

function walkObject(
  obj: object,
  budget: SnapshotBudget,
  depth: number,
  ancestors: object[],
  mark: () => void,
): unknown {
  let keys: string[];
  try {
    keys = Object.keys(obj);
  } catch {
    mark();
    return UNREADABLE;
  }

  // Sort first, cut second. See the header: the reverse makes the surviving
  // subset a function of the app's mutation history.
  keys.sort();
  if (keys.length > budget.maxKeys) {
    mark();
    keys = keys.slice(0, budget.maxKeys > 0 ? budget.maxKeys : 0);
  }

  ancestors.push(obj);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    // Before the read, so the value is neither walked nor even fetched. Array
    // elements and `Map` entries never reach here: they have no property name,
    // and a predicate over positions would be a guess.
    if (isSecret(key, budget)) {
      out[key] = MASK;
      continue;
    }
    const read = readProp(obj, key);
    if (!read.ok) {
      mark();
      out[key] = UNREADABLE;
      continue;
    }
    // Dropped, not nulled — what `JSON.stringify` does, and what a diff needs:
    // an omitted key is absent on both sides and produces no operation, while a
    // null would be a value the app never held.
    if (read.value === undefined) continue;
    out[key] = walk(read.value, budget, depth + 1, ancestors, mark);
  }
  ancestors.pop();
  return out;
}

/**
 * Copy an arbitrary live value into something JSON-safe, deterministic and
 * bounded by `budget`.
 *
 * Class instances are walked as plain objects — apps put models in stores, and
 * their own enumerable fields are the state. Only the shapes above, whose
 * contents are not reachable as properties at all, are special-cased.
 */
export function snapshot(raw: unknown, budget: SnapshotBudget): SnapshotResult {
  let bounded = false;
  const value = walk(raw, budget, 0, [], () => {
    bounded = true;
  });
  return { value, bounded };
}
