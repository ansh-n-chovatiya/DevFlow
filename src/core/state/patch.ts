/**
 * The difference between two snapshots, as an RFC 6902 patch that applies.
 *
 * ## Applying is the specification
 *
 * `applyPatch(before, diff(before, after).ops)` deep-equals `after`, for every
 * shape and at every budget. Everything below follows from that one sentence,
 * including the two places it is easy to lose:
 *
 * **Removes run highest index first.** RFC 6902 operations are applied in order
 * against a document that each of them has already changed, so `remove /list/1`
 * renumbers everything after it. Emitting the removes for a shrunken array in
 * ascending order deletes the right *count* of elements and the wrong ones, and
 * the patch still applies cleanly — nothing errors, the array is simply not the
 * app's array any more.
 *
 * **The budget is spent by collapsing, never by dropping.** A patch with
 * operations sliced off the end is not a smaller patch; it is a wrong one, and
 * it reconstructs a state the app never held with nothing saying so. Over
 * budget, the deepest operations are re-cut at their parent — one `replace`
 * carrying that parent's whole after-value — and the cut repeats a level
 * shallower until the patch fits, ending, if it must, at a single `replace` of
 * the document. Fewer operations, coarser, still exact. `collapsed` is what that
 * cost in detail.
 *
 * ## Pointers
 *
 * Paths are RFC 6901: `~` escapes as `~0` and `/` as `~1`, in that order in both
 * directions, or a key named `a~1b` round-trips as `a/b`. Stores contain keys
 * named after URLs and query cache keys, so this is a live concern rather than a
 * spec formality; the empty pointer addresses the whole document.
 *
 * Pure — no DOM, no Chrome, no clock.
 */

import type { PatchOp } from '../../shared/types.js';

export interface PatchBudget {
  /** Operations one patch may carry. Callers pass `STATE_MAX_PATCH_OPS`. */
  maxOps: number;
}

export interface PatchResult {
  ops: PatchOp[];
  /** Finer operations folded into a coarser `replace` to fit `maxOps`. */
  collapsed: number;
}

/**
 * An operation while it is still being reasoned about, holding its path as
 * segments. Collapsing is a question about a path's parent, and asking that of
 * an encoded pointer means decoding it again on every round.
 */
interface Change {
  op: 'add' | 'remove' | 'replace';
  segs: string[];
  value?: unknown;
}

/** Escape one segment. `~` first: doing `/` first would re-escape the `~1`. */
function encodeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Unescape one segment. `~1` first, mirroring `encodeSegment`. */
function decodeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function toPointer(segs: readonly string[]): string {
  return segs.map((segment) => `/${encodeSegment(segment)}`).join('');
}

export function fromPointer(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer.split('/').slice(1).map(decodeSegment);
}

type Kind = 'array' | 'object' | 'scalar';

function kindOf(value: unknown): Kind {
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'object';
  return 'scalar';
}

/** `Object.is`, except that `+0` and `-0` are the same number for a reader. */
function sameScalar(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
}

function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * A segment read as an array index, or `-1`.
 *
 * `Number('')` is `0` and `Number(' 1')` is `1`, so a key named `''` on an
 * object that happens to be an array would address element zero. RFC 6901 says
 * an index is digits, and only digits.
 */
function arrayIndex(segment: string): number {
  return /^(?:0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : -1;
}

function build(before: unknown, after: unknown, segs: string[], out: Change[]): void {
  const kindBefore = kindOf(before);
  const kindAfter = kindOf(after);

  // An object that became an array is not a set of key edits, and describing it
  // as one produces a longer patch that reads as a smaller change.
  if (kindBefore !== kindAfter) {
    out.push({ op: 'replace', segs, value: after });
    return;
  }

  if (kindBefore === 'scalar') {
    if (!sameScalar(before, after)) out.push({ op: 'replace', segs, value: after });
    return;
  }

  if (kindBefore === 'array') {
    const from = before as unknown[];
    const to = after as unknown[];
    const shared = Math.min(from.length, to.length);

    for (let i = 0; i < shared; i += 1) build(from[i], to[i], [...segs, String(i)], out);
    for (let i = shared; i < to.length; i += 1) {
      out.push({ op: 'add', segs: [...segs, '-'], value: to[i] });
    }
    // Descending. See the header: ascending removes take the wrong elements.
    for (let i = from.length - 1; i >= shared; i -= 1) {
      out.push({ op: 'remove', segs: [...segs, String(i)] });
    }
    return;
  }

  const from = before as Record<string, unknown>;
  const to = after as Record<string, unknown>;
  // Sorted, so that two runs over the same pair of snapshots produce byte-equal
  // patches and a stored flow does not churn on a re-diff.
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();

  for (const key of keys) {
    const path = [...segs, key];
    if (has(from, key) && has(to, key)) build(from[key], to[key], path, out);
    else if (has(to, key)) out.push({ op: 'add', segs: path, value: to[key] });
    else out.push({ op: 'remove', segs: path });
  }
}

/** Resolve a segment path against a document, distinguishing absent from `undefined`. */
function resolve(doc: unknown, segs: readonly string[]): { found: boolean; value?: unknown } {
  let current = doc;
  for (const segment of segs) {
    if (Array.isArray(current)) {
      const index = arrayIndex(segment);
      if (index < 0 || index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === 'object' && has(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return { found: false };
  }
  return { found: true, value: current };
}

/** The one operation that says everything the operations under `segs` said. */
function coarsen(segs: string[], before: unknown, after: unknown): Change {
  const inAfter = resolve(after, segs);
  if (!inAfter.found) return { op: 'remove', segs };
  const inBefore = resolve(before, segs);
  if (!inBefore.found) return { op: 'add', segs, value: inAfter.value };
  return { op: 'replace', segs, value: inAfter.value };
}

/**
 * Fold the deepest operations into their parents until the patch fits.
 *
 * Order is preserved rather than re-sorted: a coarse `replace` of an array
 * element and a `remove` further along the same array only compose correctly in
 * the order `build` emitted them.
 */
function collapse(changes: Change[], before: unknown, after: unknown, maxOps: number): Change[] {
  let current = changes;

  while (current.length > maxOps) {
    let deepest = 0;
    for (const change of current) deepest = Math.max(deepest, change.segs.length);

    // Nothing shallower than the whole document exists.
    if (deepest <= 1) return [coarsen([], before, after)];

    /*
     * Deduplicate the folded operations — a whole array's worth of them collapse
     * onto one parent — but never the kept ones: several `add` operations on one
     * array all share the pointer `/list/-`, and treating those as duplicates
     * would drop appends. A kept operation standing exactly where a fold landed
     * is subsumed by it, since the fold carries that parent's whole after-value.
     */
    const folds = new Set<string>();
    for (const change of current) {
      if (change.segs.length === deepest) folds.add(toPointer(change.segs.slice(0, deepest - 1)));
    }

    const next: Change[] = [];
    const emitted = new Set<string>();
    for (const change of current) {
      const pointer = toPointer(change.segs);
      if (change.segs.length !== deepest) {
        if (!folds.has(pointer)) next.push(change);
        continue;
      }
      const segs = change.segs.slice(0, deepest - 1);
      const parent = toPointer(segs);
      if (emitted.has(parent)) continue;
      emitted.add(parent);
      next.push(coarsen(segs, before, after));
    }
    current = next;
  }

  return current;
}

function toOp(change: Change): PatchOp {
  // `value` is absent for `remove` and only for `remove`, so a reader can tell a
  // removal from a set-to-undefined without consulting the op name twice.
  return change.op === 'remove'
    ? { op: 'remove', path: toPointer(change.segs) }
    : { op: change.op, path: toPointer(change.segs), value: change.value };
}

/**
 * The patch from `before` to `after`, within `maxOps` operations.
 *
 * Only `add`, `remove` and `replace` are generated — see `PatchOp`.
 */
export function diff(before: unknown, after: unknown, budget: PatchBudget): PatchResult {
  const changes: Change[] = [];
  build(before, after, [], changes);

  // A budget below one op cannot describe any change at all; one whole-document
  // replace is the floor, and it is still exact.
  const maxOps = budget.maxOps >= 1 ? budget.maxOps : 1;
  const fitted = changes.length > maxOps ? collapse(changes, before, after, maxOps) : changes;

  return { ops: fitted.map(toOp), collapsed: changes.length - fitted.length };
}

/** Structural copy of a JSON-safe value, so applying never writes into `before`. */
function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = clone(item);
    }
    return out;
  }
  return value;
}

const MISSING = Symbol('missing');

function parentOf(doc: unknown, segs: readonly string[]): unknown {
  let current = doc;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const segment = segs[i];
    if (Array.isArray(current)) {
      const index = arrayIndex(segment);
      if (index < 0 || index >= current.length) return MISSING;
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === 'object' && has(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return MISSING;
  }
  return current === null || typeof current !== 'object' ? MISSING : current;
}

/**
 * Apply a patch to a snapshot, returning a new document.
 *
 * An operation naming a path that is not there is skipped rather than thrown:
 * this runs in a viewer rendering a flow recorded by some other build, and a
 * stale operation should cost that operation, not the step.
 */
export function applyPatch(before: unknown, ops: readonly PatchOp[]): unknown {
  let doc = clone(before);

  for (const op of ops) {
    const segs = fromPointer(op.path);

    if (segs.length === 0) {
      doc = op.op === 'remove' ? undefined : clone(op.value);
      continue;
    }

    const parent = parentOf(doc, segs);
    if (parent === MISSING) continue;
    const last = segs[segs.length - 1];

    if (Array.isArray(parent)) {
      if (op.op === 'add') {
        if (last === '-') parent.push(clone(op.value));
        else {
          const index = arrayIndex(last);
          if (index >= 0 && index <= parent.length) parent.splice(index, 0, clone(op.value));
        }
        continue;
      }
      const index = arrayIndex(last);
      if (index < 0 || index >= parent.length) continue;
      if (op.op === 'remove') parent.splice(index, 1);
      else parent[index] = clone(op.value);
      continue;
    }

    const host = parent as Record<string, unknown>;
    if (op.op === 'remove') delete host[last];
    else host[last] = clone(op.value);
  }

  return doc;
}
