/**
 * The slice names a store has, and the ones a step moved.
 *
 * These are what the graph and the step summary are drawn from: `cart, session`
 * is a step description a reader can scan, where the patch itself is forty
 * pointers they will not read. Both answers are derived rather than recorded,
 * because a name list stored beside a patch is a second copy of the same fact
 * and drifts from it the first time either is re-cut.
 *
 * Pure — no DOM, no Chrome, no clock.
 */

import type { PatchOp } from '../../shared/types.js';
import { fromPointer } from './patch.js';

/**
 * Top-level key names of one store's snapshot — the slice names, for the graph.
 *
 * Empty for anything that is not a plain object, arrays included: an array's
 * top-level keys are `0, 1, 2`, which name nothing a reader recognises, and a
 * store whose root is a scalar has no slices to list.
 */
export function storeKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

/**
 * The top-level keys a patch touched, deduplicated, in sorted order.
 *
 * An operation at the empty pointer replaced the whole store and so names no
 * key here. It could only name every key by reading them off the after-document,
 * which `touchedKeys` does not have — and a list of slice names guessed from a
 * pointer that does not mention them would be indistinguishable from one that
 * was observed. A caller that wants those names has the snapshot and can ask
 * `storeKeys` for them.
 */
export function touchedKeys(ops: readonly PatchOp[]): string[] {
  const keys = new Set<string>();
  for (const op of ops) {
    const [first] = fromPointer(op.path);
    if (first !== undefined) keys.add(first);
  }
  return [...keys].sort();
}
