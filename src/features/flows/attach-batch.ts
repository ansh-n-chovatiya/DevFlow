/**
 * Merging what arrives after a step into one write instead of one each.
 *
 * `captureAndSave` writes a step the moment it happens; a DOM delta, a DOM
 * mutation summary, a state-store delta, a render sample and an accessibility
 * finding all arrive later, on their own settle timers, describing what that
 * same interaction *did*. Each used to be its own `getLocal` + `setLocal`
 * against the whole `recordedSteps` array — up to five extra full-array round
 * trips for one step, on top of the step's own write, growing with the
 * recording's length since `chrome.storage` has no partial-write API.
 *
 * The five are queued here instead: each pushes a patch closure rather than
 * touching storage itself, and whichever one lands first in a burst arms a
 * single flush that reads once, replays every queued patch against one
 * in-memory snapshot, and writes once. `captureAndSave` is deliberately left
 * out of the batch — see `seal()` below for why merging it in would cost more
 * than it saves.
 */

import { stepKey } from '../../core/flow/index.js';
import type { Result } from '../../shared/result.js';
import type {
  DomChange,
  FlowRenders,
  LocalStorageShape,
  StateStoreRef,
  Step,
  StepA11yFinding,
  StepRender,
  StepStateDelta,
} from '../../shared/types.js';

/**
 * One flush's working copy: whatever `recordedSteps`, `stateStores` and
 * `flowRenders` held when the batch started, mutated in place by each queued
 * patch, and written back only where something in it actually changed —
 * exactly the three conditions the un-batched functions each checked
 * individually before writing.
 */
export interface AttachBatchState {
  recordedSteps: Step[];
  stateStores: StateStoreRef[];
  flowRenders: FlowRenders | undefined;
  recordedStepsDirty: boolean;
  stateStoresDirty: boolean;
  flowRendersDirty: boolean;
}

export type AttachOp = (state: AttachBatchState) => void;

/**
 * Attach a DOM text delta to the step it belongs to.
 *
 * `watchDomDelta` in the content script only sends this when the text
 * actually changed, so unlike the others there is nothing to check here — a
 * step that cannot be found is the only reason not to write.
 */
export function applyDomDelta(state: AttachBatchState, key: string, before: string, after: string): void {
  const index = state.recordedSteps.findIndex((step) => stepKey(step) === key);
  if (index === -1) return;

  state.recordedSteps[index] = { ...state.recordedSteps[index], domDelta: { before, after } };
  state.recordedStepsDirty = true;
}

/** Attach what the document did to the step it belongs to. */
export function applyDomChanges(
  state: AttachBatchState,
  key: string,
  changes: DomChange[],
  capped: true | undefined,
  more: number | undefined,
): void {
  const index = state.recordedSteps.findIndex((step) => stepKey(step) === key);
  if (index === -1) return;
  if (!changes.length && !capped) return;

  state.recordedSteps[index] = {
    ...state.recordedSteps[index],
    domChanges: { changes, ...(capped ? { capped } : {}), ...(more ? { more } : {}) },
  };
  state.recordedStepsDirty = true;
}

/**
 * Attach a state-store delta to its step, and merge the stores it named into
 * the recording-wide table.
 *
 * The two are independent, exactly as the un-batched version kept them: a
 * store discovered by a step that no longer exists in the array is still
 * worth recording, so `stateStores` can end up dirty while `recordedSteps`
 * does not.
 */
export function applyStateDelta(
  state: AttachBatchState,
  key: string,
  deltas: StepStateDelta[],
  stores: StateStoreRef[] | undefined,
): void {
  if (stores?.length) {
    // Replaced rather than appended when the id is already known: a store's
    // subscriber list grows as the user visits more of the app, and the later
    // description is the more complete one.
    state.stateStores = [
      ...state.stateStores.filter((store) => !stores.some((next) => next.id === store.id)),
      ...stores,
    ];
    state.stateStoresDirty = true;
  }

  if (deltas.length) {
    const index = state.recordedSteps.findIndex((step) => stepKey(step) === key);
    if (index !== -1) {
      state.recordedSteps[index] = { ...state.recordedSteps[index], state: deltas };
      state.recordedStepsDirty = true;
    }
  }
}

/**
 * Merge what re-rendered into the step it belongs to, and fold `capped`/`note`
 * into the recording-wide `flowRenders`.
 *
 * `flowRenders` is written on every call, sticky across the whole batch: a
 * second `applyRenders` in the same flush sees the first one's result as
 * `known`, so `capped`/`note` accumulate the same way three separate writes
 * would have produced them.
 */
export function applyRenders(
  state: AttachBatchState,
  key: string,
  renders: StepRender[],
  capped: boolean | undefined,
  note: string | undefined,
): void {
  const known = state.flowRenders;
  state.flowRenders = {
    read: true,
    ...(capped || known?.capped ? { capped: true } : {}),
    ...(note ?? known?.note ? { note: note ?? known?.note } : {}),
  };
  state.flowRendersDirty = true;

  if (renders.length) {
    const index = state.recordedSteps.findIndex((step) => stepKey(step) === key);
    if (index !== -1) {
      state.recordedSteps[index] = { ...state.recordedSteps[index], renders };
      state.recordedStepsDirty = true;
    }
  }
}

/**
 * Attach accessibility findings to the step they belong to.
 *
 * The caller is expected to have already dropped the case of no findings and
 * no note, the way the un-batched version did before it ever read storage.
 */
export function applyA11y(
  state: AttachBatchState,
  key: string,
  findings: StepA11yFinding[],
  note: string | undefined,
): void {
  const index = state.recordedSteps.findIndex((step) => stepKey(step) === key);
  if (index === -1) return;

  state.recordedSteps[index] = {
    ...state.recordedSteps[index],
    a11y: { findings, ...(note ? { note } : {}) },
  };
  state.recordedStepsDirty = true;
}

/**
 * Collects patches between flushes and tells the caller exactly once per
 * batch when to schedule the flush that will run them.
 */
export interface AttachBatch {
  /**
   * Queue a patch. Returns `true` the first time since the last flush or
   * `seal()` — the caller arms one flush on that signal alone, so a burst of
   * pushes schedules exactly one.
   */
  push(op: AttachOp): boolean;
  /** Take and clear whatever is queued, for the flush that is about to run it. */
  take(): AttachOp[];
  /**
   * Clear whatever is queued without running it, so patches queued after this
   * point start a fresh batch instead of joining one whose flush was already
   * scheduled earlier.
   *
   * `captureAndSave` calls this before queuing its own write. Without it, a
   * capture for step B arriving while step A's patches are still batched (but
   * not yet flushed) would have its own write scheduled *after* a flush that
   * was armed *before* B existed — and any of B's own patches that land in
   * the same window would be swept into that earlier flush and silently no-op
   * against a step not yet in the array. Sealing forces B's patches to wait
   * for a batch armed after B's write is queued.
   *
   * `captureAndSave` is not folded into the batch itself because its write
   * must not wait on the batch's patches: those arrive on independent,
   * feature-gated settle timers that may never fire, and the step needs to
   * exist immediately — the popup's step count and the live viewer depend on
   * it, and nothing else could name a step that was never written.
   */
  seal(): void;
}

export function createAttachBatch(): AttachBatch {
  let ops: AttachOp[] = [];
  let armed = false;

  return {
    push(op) {
      const first = !armed;
      armed = true;
      ops.push(op);
      return first;
    },
    take() {
      const taken = ops;
      ops = [];
      armed = false;
      return taken;
    },
    seal() {
      ops = [];
      armed = false;
    },
  };
}

/** What `runAttachFlush` needs to read — the same shape `getLocal` answers with. */
export type LocalRead = (
  keys: string[],
) => Promise<Result<Partial<LocalStorageShape> & Record<string, unknown>>>;

/** What `runAttachFlush` writes with — the same shape `setLocal` takes. */
export type LocalWrite = (
  items: Partial<LocalStorageShape> | Record<string, unknown>,
) => Promise<Result<void>>;

/**
 * One flush: reads the three keys a batch can touch, replays every queued
 * patch against them, and writes back only the keys something actually
 * changed — one read and, at most, one write, for however many patches were
 * queued.
 *
 * Takes `getLocal`/`setLocal` as parameters rather than importing
 * `chrome/storage.ts` directly, so the round-trip count this buys can be
 * asserted against a counting fake instead of only inferred from
 * `AttachBatch`'s push/take contract — and so this module, like the rest of
 * `core/` and most of `features/`, has no direct `chrome.*` dependency of its
 * own. `background/index.ts` calls this with the real `getLocal`/`setLocal`.
 *
 * Returns `null` when nothing was written (no patches, the recording had
 * already stopped, or none of them changed anything) — the caller only has an
 * error to report when this is an actual failed `Result`.
 */
export async function runAttachFlush(
  ops: AttachOp[],
  getLocal: LocalRead,
  setLocal: LocalWrite,
): Promise<Result<void> | null> {
  if (ops.length === 0) return null;

  const stored = await getLocal(['recordedSteps', 'recordingActive', 'stateStores', 'flowRenders']);
  if (!stored.ok || !stored.value.recordingActive) return null;

  const state: AttachBatchState = {
    recordedSteps: stored.value.recordedSteps ?? [],
    stateStores: stored.value.stateStores ?? [],
    flowRenders: stored.value.flowRenders ?? undefined,
    recordedStepsDirty: false,
    stateStoresDirty: false,
    flowRendersDirty: false,
  };

  for (const op of ops) op(state);
  if (!state.recordedStepsDirty && !state.stateStoresDirty && !state.flowRendersDirty) return null;

  return setLocal({
    ...(state.recordedStepsDirty ? { recordedSteps: state.recordedSteps } : {}),
    ...(state.stateStoresDirty ? { stateStores: state.stateStores } : {}),
    ...(state.flowRendersDirty ? { flowRenders: state.flowRenders } : {}),
  });
}
