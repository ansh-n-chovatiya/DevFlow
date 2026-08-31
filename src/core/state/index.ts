/**
 * Reading an app's state as something that can be stored and diffed.
 *
 * Three steps, in order, and each is useless without the one before it:
 * `snapshot` turns a live value into a bounded JSON-safe copy that is stable
 * across mutation, `diff` turns two of those copies into a patch that applies,
 * and `storeKeys` / `touchedKeys` name what a reader sees first. The impure half
 * — which stores exist, when to sample them, what the clock says — belongs to
 * `features/`; nothing here reads a global.
 */

export type { SnapshotBudget, SnapshotResult } from './snapshot.js';
export { snapshot } from './snapshot.js';
export type { PatchBudget, PatchResult } from './patch.js';
export { applyPatch, diff, fromPointer, toPointer } from './patch.js';
export { storeKeys, touchedKeys } from './keys.js';
