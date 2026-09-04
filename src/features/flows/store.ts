/**
 * The flow store — the only place saved flows are read and written.
 *
 * The old viewer did this inline in six places, and two of them disagreed: an
 * edit made while viewing a saved flow re-rendered but was never written back
 * (audit F7), and deleting a flow cleared the index before the steps, so a
 * failure halfway left an orphaned `savedFlow_<id>` key that nothing could ever
 * reach or delete. Both orders are fixed here, once.
 *
 * Every function returns a `Result`. Storage has a 10 MB ceiling and saving a
 * flow is the single largest write the extension makes, so a full area is a
 * normal outcome to report — not an exception to swallow.
 */

import { countByType, countFailures, flowHost, renumber, stepKey } from '../../core/flow/index.js';
import { deleteRemoteFlow } from '../mcp/remote.js';
import { buildFlowReact, pruneComponents } from '../../core/react/attribution.js';
import { buildFlowFrameworks } from '../../core/locate/flow-frameworks.js';
import type { Framework } from '../../core/locate/adapter.js';
import { getLocal, removeLocal, setLocal } from '../../chrome/storage.js';
import { sendToWorker } from '../../shared/messages.js';
import { err, ok, type Result } from '../../shared/result.js';
import { flowError } from '../../shared/errors.js';
import {
  savedFlowKey,
  savedFlowFrameworksKey,
  savedFlowReactKey,
  savedFlowStateKey,
  savedFlowRendersKey,
  type FlowMeta,
  type FlowComponents,
  type FlowReact,
  type FlowState,
  type FlowRenders,
  type Overrides,
  type Step,
} from '../../shared/types.js';
import { readRecordingStamp } from '../settings/recording.js';
import { makeThumbnail, thumbnailSource, type ThumbnailSize } from './thumbnail.js';
import { load as loadSettings } from '../settings/index.js';
import type { Settings } from '../settings/fields.js';
import { resolve } from '../settings/resolve.js';

/** The three `thumbnails.*` settings, as the drawing function wants them. */
function thumbnailSize(settings: Settings): ThumbnailSize {
  return {
    width: settings['thumbnails.width'],
    height: settings['thumbnails.height'],
    quality: settings['thumbnails.quality'],
  };
}
import { dehydrate, hydrate } from './shots.js';

/** A flow and its steps, whether it is the live recording or an archived one. */
export interface Flow {
  /** `null` is the recording in progress, which has no id until it is saved. */
  id: string | null;
  name: string;
  steps: Step[];
  meta: FlowMeta | null;
  /** Absent when the flow was not recorded on a React page. */
  react: FlowReact | null;
  /**
   * The other adapters' tables, keyed by framework and empty when none applied.
   *
   * Empty rather than null, unlike `react`: a page that was not Vue and a flow
   * archived before these existed read the same way, and the caller spreads
   * this object either way.
   */
  frameworks: Partial<Record<Framework, FlowComponents>>;
  /**
   * What the recording could see of the app's state, including when the answer
   * is "nothing, and here is why". `null` only for a flow archived before state
   * capture existed, which says nothing about state either way.
   */
  state: FlowState | null;
  /**
   * What the recording could see of the app's renders, including when the
   * answer is "nothing, and here is why". `null` only for a flow archived
   * before render sampling existed — which is a different answer from "nothing
   * re-rendered", and the reason this is not simply absent.
   */
  renders: FlowRenders | null;
}

/** The name the unsaved recording is shown under until it is given one. */
export const CURRENT_FLOW_NAME = 'Current recording';

// ── The index ────────────────────────────────────────────────────────────────

export async function listFlows(): Promise<Result<FlowMeta[]>> {
  const stored = await getLocal('savedFlowsMeta');
  if (!stored.ok) return stored;

  const meta = stored.value.savedFlowsMeta;
  // Newest first: the flow someone wants is almost always the last one recorded.
  return ok(Array.isArray(meta) ? [...meta].sort((a, b) => b.createdAt - a.createdAt) : []);
}

function writeIndex(flows: FlowMeta[]): Promise<Result<void>> {
  return setLocal({ savedFlowsMeta: flows });
}

/** Serialises index writes, so no two of them can be based on the same read. */
let indexQueue: Promise<unknown> = Promise.resolve();

/**
 * Apply a change to `savedFlowsMeta` — one at a time, against a fresh copy.
 *
 * The index is a single key rewritten whole, and the paths that rewrite it are
 * long. `updateFlowSteps` lists the index, reads the React table, writes a
 * megabyte of steps, then decodes and re-encodes a full-page JPEG for the
 * thumbnail before it finally writes the index back — hundreds of milliseconds
 * in which a rename can read the same snapshot, write its own copy, and be
 * silently reverted by the stale one the first call has been holding all along.
 * Every mutation here used to be that unguarded read-modify-write.
 *
 * So the caller no longer supplies a list, it supplies a change: a function of
 * whatever the index holds at the moment the write is made. The queue is what
 * guarantees nothing lands between that read and that write.
 */
function mutateIndex(mutate: (flows: FlowMeta[]) => FlowMeta[]): Promise<Result<void>> {
  const run = indexQueue.then(async (): Promise<Result<void>> => {
    const flows = await listFlows();
    if (!flows.ok) return flows;

    return writeIndex(mutate(flows.value));
  });

  // The chain must survive a rejection, or one failed write blocks every index
  // change for the life of the page.
  indexQueue = run.catch(() => undefined);
  return run;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * The recording in progress.
 *
 * The worker is asked first because it holds steps that may not have been
 * flushed yet, but it may also be asleep — in which case storage is the truth,
 * exactly as it was before.
 */
export async function readCurrent(): Promise<Result<Step[]>> {
  const live = await sendToWorker({ type: 'GET_STEPS' });
  // Hydrated either way: the worker answers out of the same storage, so its
  // steps carry no images either, and a caller that had to know which of the two
  // it got would be a caller that eventually forgets.
  if (live?.steps.length) return ok(await hydrate(live.steps));

  const stored = await getLocal('recordedSteps');
  if (!stored.ok) return stored;

  const steps = stored.value.recordedSteps;
  return ok(Array.isArray(steps) ? await hydrate(steps) : []);
}

/**
 * Write the live recording back, merging into what is stored rather than
 * replacing it.
 *
 * `recordedSteps` has two writers. This is one; the other is the worker's
 * capture queue, which reads the array and then spends hundreds of milliseconds
 * screenshotting and annotating before it writes its own copy back. Sending the
 * viewer's whole in-memory array over the top of that loses whichever write
 * landed first — the annotation the user just saved, or the step they just
 * clicked (and with it the badge count) — and neither loss says anything on
 * screen, because the toast has already claimed success.
 *
 * So the edit is re-applied to whatever storage holds *now*:
 *
 *  - a stored step the edit also has takes the edited version;
 *  - a stored step the edit has never seen is a capture that arrived while the
 *    user was typing, and is kept;
 *  - a stored step that `base` had and the edit no longer does was deleted by
 *    the user, and is dropped;
 *  - an edited step storage no longer has was deleted from somewhere else —
 *    Discard, another viewer tab — and is *not* written back. Storage is the
 *    truth about what still exists; resurrecting a discarded recording because
 *    a stale tab still had it on screen is not a merge, it is an undo nobody
 *    asked for.
 *
 * `base` is the array the edit was derived from. Left out, it defaults to the
 * edit itself, which reads as "this changes steps, it does not remove any" —
 * the safe direction, since the cost of getting it wrong is a step that stays
 * rather than a step that vanishes.
 *
 * Returns the merged array, because that — not what the caller passed — is what
 * storage now holds and what the screen should be showing.
 */
export async function writeCurrent(steps: Step[], base: Step[] = steps): Promise<Result<Step[]>> {
  const stored = await getLocal('recordedSteps');
  if (!stored.ok) return stored;

  const current = Array.isArray(stored.value.recordedSteps) ? stored.value.recordedSteps : [];

  const storedKeys = new Set(current.map(stepKey));
  const baseKeys = new Set(base.map(stepKey));
  const editedKeys = new Set(steps.map(stepKey));

  const kept = steps.filter((step) => storedKeys.has(stepKey(step)) || !baseKeys.has(stepKey(step)));
  // The worker only ever appends, so anything it added since the edit began
  // belongs after everything the viewer was looking at.
  const appended = current.filter((step) => {
    const key = stepKey(step);
    return !editedKeys.has(key) && !baseKeys.has(key);
  });

  const merged = renumber([...kept, ...appended]);

  /*
   * `kept` came from the viewer and carries images; `appended` came from storage
   * and does not. `dehydrate` reads both the same way — a step with no image
   * contributes no shot — so the merge does not have to know which half a step
   * came from, and a step the worker added between the read and the write keeps
   * the image the worker filed for it.
   */
  const { steps: lean, shots, orphans } = dehydrate(merged, current);

  const written = await setLocal({ recordedSteps: lean, ...shots });
  if (!written.ok) return written;

  // After the write, never before: an image deleted first is an image lost if
  // the write that was meant to drop its step then fails.
  if (orphans.length) await removeLocal(orphans);

  return ok(merged);
}

/**
 * The live recording's React components, pruned to the steps given.
 *
 * The resolver writes `reactComponents` continuously while a recording runs, so
 * this is a snapshot of an answer that is still being filled in — which is
 * exactly why it is read at the moment it is needed rather than held anywhere.
 * A read that fails costs the flow its component table and nothing else.
 */
export async function readCurrentReact(steps: Step[]): Promise<FlowReact | null> {
  const stored = await getLocal(['reactComponents', 'reactMeta']);
  if (!stored.ok) return null;

  return buildFlowReact(steps, stored.value.reactMeta ?? null, stored.value.reactComponents ?? {}) ?? null;
}

/**
 * The live recording's non-React frameworks, pruned to the steps given.
 *
 * Read at the moment it is needed for `readCurrentReact`'s reason, and empty
 * rather than null when there is nothing: a page with no Vue has no `vue` key,
 * and the caller spreads this object either way, so an empty one is the same
 * statement with no branch at the call site.
 */
export async function readCurrentFrameworks(
  steps: Step[],
): Promise<Partial<Record<Framework, FlowComponents>>> {
  const stored = await getLocal(['frameworkComponents', 'frameworkMeta']);
  if (!stored.ok) return {};

  return buildFlowFrameworks(
    steps,
    stored.value.frameworkMeta ?? null,
    stored.value.frameworkComponents ?? {},
  );
}

/**
 * The live recording's state stores, and what to say when there are none.
 *
 * Read at the moment it is needed for `readCurrentReact`'s reason. The
 * difference is the answer when there is nothing: React returns `null` and the
 * flow simply has no `react`, because a page with no React is a page with no
 * React. State has three nothings — capture was off, capture ran and the page
 * had no store DevFlow could read, and capture ran and nothing changed — and
 * they are not the same fact. `read` and `note` are what keep them apart, and
 * `FlowState` is returned even when `stores` is empty precisely so the reader
 * is told which one it was.
 */
export async function readCurrentState(): Promise<FlowState | null> {
  const stored = await getLocal(['stateStores', 'recordingSettings']);
  if (!stored.ok) return null;

  const settings = resolve(stored.value.recordingSettings ?? {});
  if (!settings['recording.state']) {
    return {
      read: false,
      stores: [],
      note: 'State was not recorded — “Record the app’s state” was off for this recording.',
    };
  }

  const stores = stored.value.stateStores ?? [];
  return {
    read: true,
    stores,
    ...(stores.length
      ? {}
      : {
          note: 'No store was read. DevFlow reads state through React contexts, so a page with no React, or one whose store is held in a module rather than a provider, has none to read.',
        }),
  };
}

/**
 * What the recording could and could not see of the app's renders.
 *
 * `readCurrentState`'s shape and its reasoning: the switch is read from the
 * settings *frozen for this recording*, not from live settings, so a flow
 * recorded with sampling off still says so after the user turns it back on.
 *
 * The difference from state is which half of the answer comes from where.
 * Whether sampling ran is a settings question and is answered here; whether it
 * was cut short is something only the walk knows, so `capped` and the note are
 * carried on `flowRenders` by `attachRenders` and read back off it. A recording
 * where sampling ran and nothing was ever cut has neither, which is the plain
 * "it looked, and it saw everything it looked at" answer.
 */
export async function readCurrentRenders(): Promise<FlowRenders | null> {
  const stored = await getLocal(['flowRenders', 'recordingSettings']);
  if (!stored.ok) return null;

  const settings = resolve(stored.value.recordingSettings ?? {});
  if (!settings['recording.renders']) {
    return {
      read: false,
      note: 'Which components re-rendered was not recorded — “Record which components re-rendered” was off for this recording.',
    };
  }

  const seen = stored.value.flowRenders ?? null;
  return {
    read: true,
    ...(seen?.capped ? { capped: true } : {}),
    ...(seen?.note ? { note: seen.note } : {}),
  };
}

/**
 * What storage actually holds for an id, with the two ways a flow can be absent
 * kept apart.
 *
 * Collapsing them into one `null` is what made a half-deleted flow permanent.
 * `deleteFlow` removes the steps first, so an index write that fails leaves a
 * row that is listed but has no steps to open — and the retry was then refused
 * by a guard that read `no flow <id>` out of the very state the first attempt
 * had created. The recovery path was blocked by the condition it existed to
 * recover from.
 */
interface FlowRecord {
  /** `null` when the index has never heard of this id. */
  meta: FlowMeta | null;
  /** `null` when the index lists the flow but its steps key is gone. */
  steps: Step[] | null;
  react: FlowReact | null;
  /** Empty rather than null: absent and "none found" are the same statement. */
  frameworks: Partial<Record<Framework, FlowComponents>>;
  state: FlowState | null;
  renders: FlowRenders | null;
}

async function readFlowRecord(id: string): Promise<Result<FlowRecord>> {
  const flows = await listFlows();
  if (!flows.ok) return flows;

  const meta = flows.value.find((flow) => flow.id === id) ?? null;
  if (!meta) {
    return ok({ meta: null, steps: null, react: null, frameworks: {}, state: null, renders: null });
  }

  const key = savedFlowKey(id);
  const reactKey = savedFlowReactKey(id);
  const frameworksKey = savedFlowFrameworksKey(id);
  const stateKey = savedFlowStateKey(id);
  const rendersKey = savedFlowRendersKey(id);
  const stored = await getLocal([key, reactKey, frameworksKey, stateKey, rendersKey]);
  if (!stored.ok) return stored;

  const steps = stored.value[key];
  // Flows archived before components were captured have no such key at all.
  const react = (stored.value[reactKey] as FlowReact | undefined) ?? null;
  const frameworks =
    (stored.value[frameworksKey] as Partial<Record<Framework, FlowComponents>> | undefined) ?? {};
  // Nor before state was. Null reads as "this recording says nothing about
  // state", which is exactly what a flow from that build does say.
  const state = (stored.value[stateKey] as FlowState | undefined) ?? null;
  // Nor before renders were sampled, and null says so rather than claiming the
  // recording looked and found nothing.
  const renders = (stored.value[rendersKey] as FlowRenders | undefined) ?? null;

  return ok({
    meta,
    frameworks,
    steps: Array.isArray(steps) ? (steps as Step[]) : null,
    react,
    state,
    renders,
  });
}

/**
 * One saved flow. `null` means the id names nothing openable — either it is not
 * in the index, or it is listed but its steps are gone. The viewer shows both as
 * a missing flow rather than as an empty one; `deleteFlow` is the one caller
 * that has to tell them apart, and it reads the record directly.
 */
export async function readFlow(id: string): Promise<Result<Flow | null>> {
  const record = await readFlowRecord(id);
  if (!record.ok) return record;

  const { meta, steps, react, frameworks, state, renders } = record.value;
  if (!meta || !steps) return ok(null);

  return ok({ id, name: meta.name, steps, meta, react, frameworks, state, renders });
}

// ── Describing ───────────────────────────────────────────────────────────────

/**
 * Everything the library shows about a flow without opening it.
 *
 * Derived here, at write time, because the alternative is deriving it at read
 * time for every flow in the list — which means loading every flow's steps, and
 * an index whose entries cost as much as the things they index is not an index.
 */
export async function describeFlow(
  id: string,
  name: string,
  steps: Step[],
  createdAt: number,
  /**
   * Reuse an existing thumbnail instead of redrawing one. Editing a note is a
   * write, and decoding and re-encoding a full-page screenshot every time
   * somebody leaves a textarea is work with nothing to show for it.
   */
  thumbnail?: string | null,
  /**
   * The settings the recording was frozen at — the stamp.
   *
   * Passed in rather than read here, because the two callers mean different
   * things by it: archiving stamps the recording that has just finished, and
   * editing a saved flow must carry forward the stamp that flow already has.
   * Reading the live snapshot in both places would relabel a month-old flow
   * with the settings of whatever was recorded most recently, which is the one
   * thing a stamp must never do.
   */
  settings?: Overrides,
): Promise<FlowMeta> {
  return {
    id,
    name,
    createdAt,
    stepCount: steps.length,
    host: flowHost(steps),
    bytes: approximateBytes(steps),
    thumbnail:
      thumbnail === undefined
        ? // Live, and read per save: a thumbnail is drawn when a flow is
          // archived, not while it is being recorded, so it is not part of what
          // the recording was made under.
          await makeThumbnail(steps, thumbnailSize(await loadSettings()))
        : thumbnail,
    counts: countByType(steps),
    errorCount: countFailures(steps),
    // Absent when the recording used the defaults, which is what a reader
    // should see: nothing to say rather than an empty object.
    ...(settings && Object.keys(settings).length ? { settings } : {}),
  };
}

/**
 * Roughly what this flow costs in storage.
 *
 * `JSON.stringify().length` counts UTF-16 code units, not the UTF-8 bytes Chrome
 * charges against the quota. For a flow it is close enough to be useful: the
 * overwhelming majority of the payload is base64 screenshot data, which is ASCII
 * and so counts one for one. It is shown as a size, never used as a guard.
 */
export function approximateBytes(steps: Step[]): number {
  try {
    return JSON.stringify(steps).length;
  } catch {
    return 0;
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * Archive the recording in progress under a name.
 *
 * Archiving is the moment a flow stops changing, so it is also the moment its
 * component table is frozen: one last resolve pass while the recorded pages may
 * still be open and their bundles still cached, then a snapshot. The pass is
 * asked to be final; the worker refuses that if a recording is still running,
 * because writing pending components off as skipped would then be a lie.
 */
export async function saveAsFlow(name: string, steps: Step[]): Promise<Result<FlowMeta>> {
  if (steps.length === 0) return err(flowError('STORAGE_WRITE', 'nothing to save'));

  const id = `flow_${Date.now()}`;
  const numbered = renumber(steps);
  // The recording's own snapshot, read before anything else can start a new
  // one. It is still in local storage: stopping a recording does not clear it,
  // precisely so archiving — which happens afterwards, from the review tab —
  // can still say what the flow was made under.
  const meta = await describeFlow(
    id,
    name,
    numbered,
    Date.now(),
    undefined,
    await readRecordingStamp(),
  );

  await sendToWorker({ type: 'RESOLVE_COMPONENTS', final: true });
  const react = await readCurrentReact(numbered);
  const frameworks = await readCurrentFrameworks(numbered);
  const state = await readCurrentState();
  const renders = await readCurrentRenders();

  // Steps first: if the index went first and the steps failed, the library would
  // list a flow that cannot be opened.
  const written = await setLocal({
    [savedFlowKey(id)]: numbered,
    ...(react ? { [savedFlowReactKey(id)]: react } : {}),
    ...(Object.keys(frameworks).length ? { [savedFlowFrameworksKey(id)]: frameworks } : {}),
    ...(state ? { [savedFlowStateKey(id)]: state } : {}),
    ...(renders ? { [savedFlowRendersKey(id)]: renders } : {}),
  });
  if (!written.ok) return written;

  const indexed = await mutateIndex((flows) => [meta, ...flows]);
  if (!indexed.ok) {
    /*
     * Take the steps back before reporting the failure.
     *
     * Left behind, that key is megabytes of a 10 MB budget that nothing can
     * reach: it is not in the index, so the library never lists it and no row
     * can delete it; the id is `flow_<ms>` and never recurs, so no later save
     * overwrites it. The user is told "there is no room", and the space is
     * occupied by a key nothing can name — which is the failure they were
     * already having, made permanent.
     */
    await removeLocal([
      savedFlowKey(id),
      savedFlowReactKey(id),
      savedFlowFrameworksKey(id),
      savedFlowStateKey(id),
      savedFlowRendersKey(id),
    ]);
    return indexed;
  }

  return ok(meta);
}

/**
 * Persist an edit to a saved flow.
 *
 * The old viewer re-rendered these and dropped them on the floor: deleting a
 * step or writing a note while viewing a saved flow looked like it worked until
 * the flow was reopened.
 */
export async function updateFlowSteps(id: string, steps: Step[]): Promise<Result<void>> {
  const flows = await listFlows();
  if (!flows.ok) return flows;

  const existing = flows.value.find((flow) => flow.id === id);
  if (!existing) return err(flowError('STORAGE_WRITE', `no flow ${id}`));

  const numbered = renumber(steps);

  /*
   * Deleting a step has to drop the components only that step reached, or the
   * flow keeps shipping source paths for code nothing in it points at any more.
   * Pruning against the surviving steps is idempotent, so an edit that changed
   * nothing structural rewrites the same table.
   */
  // The steps are read alongside the React table because the thumbnail decision
  // below needs the picture this edit is replacing, not just its step count.
  const stored = await getLocal([savedFlowKey(id), savedFlowReactKey(id)]);
  const react = stored.ok ? (stored.value[savedFlowReactKey(id)] as FlowReact | undefined) : undefined;
  const previous = stored.ok && Array.isArray(stored.value[savedFlowKey(id)])
    ? (stored.value[savedFlowKey(id)] as Step[])
    : null;

  const written = await setLocal({
    [savedFlowKey(id)]: numbered,
    ...(react ? { [savedFlowReactKey(id)]: { ...react, components: pruneComponents(numbered, react.components) } } : {}),
  });
  if (!written.ok) return written;

  /*
   * Redraw the thumbnail when the picture it is made of changed — which the
   * step count alone does not tell you.
   *
   * The thumbnail is the first step that has a screenshot, and annotating that
   * step, or importing an image over it, changes that image while leaving the
   * count exactly where it was. Keyed on the count, a flow annotated on step 1
   * showed its un-annotated original for the rest of its life; and a flow
   * recorded with no screenshots saved with `thumbnail: null`, so importing an
   * image onto every step still handed `existing.thumbnail ?? null` straight
   * back and the blank placeholder became permanent.
   *
   * A read that failed counts as changed: redrawing a thumbnail costs one JPEG
   * decode, and showing the wrong picture costs the user their trust in the row.
   */
  const structural =
    existing.stepCount !== numbered.length ||
    previous === null ||
    thumbnailSource(previous) !== thumbnailSource(numbered);

  const meta = await describeFlow(
    id,
    existing.name,
    numbered,
    existing.createdAt,
    structural ? undefined : (existing.thumbnail ?? null),
    // Carried forward, never re-read: an edit does not change what the flow was
    // recorded under. A flow archived before stamps existed keeps none, which
    // reads correctly as "the defaults of the build that made it".
    existing.settings,
  );

  // The name comes from the fresh entry, not from the snapshot this call opened
  // with: a rename that landed while the thumbnail was being drawn is somebody's
  // deliberate edit, and writing `existing.name` over it would revert it.
  return mutateIndex((current) =>
    current.map((flow) => (flow.id === id ? { ...meta, name: flow.name } : flow)),
  );
}

export function renameFlow(id: string, name: string): Promise<Result<void>> {
  return mutateIndex((flows) => flows.map((flow) => (flow.id === id ? { ...flow, name } : flow)));
}

/**
 * Delete a flow, and hand back what it took so it can be put back.
 *
 * The index entry is removed *after* the steps: a failure between the two leaves
 * a flow that is listed and openable, which is recoverable. The other order
 * leaves bytes in a 10 MB store that nothing can name.
 *
 * "Recoverable" only holds if the retry is allowed to run, and it was not: this
 * guard used to ask `readFlow`, which answered `null` for a flow whose steps
 * were already gone, and refused the delete as `no flow <id>`. The row was
 * listed, unopenable, and undeletable — a ghost. So the question asked here is
 * "is this id in the index?", which is the only thing a delete needs to know,
 * and steps that are already absent are simply a removal that has nothing left
 * to do rather than an error.
 */
export async function deleteFlow(id: string): Promise<Result<DeletedFlow>> {
  const record = await readFlowRecord(id);
  if (!record.ok) return record;

  const { meta, steps, react } = record.value;
  if (!meta) return err(flowError('STORAGE_WRITE', `no flow ${id}`));

  if (steps !== null) {
    const removed = await removeLocal([
      savedFlowKey(id),
      savedFlowReactKey(id),
      savedFlowFrameworksKey(id),
      savedFlowStateKey(id),
      savedFlowRendersKey(id),
    ]);
    if (!removed.ok) return removed;
  }

  const indexed = await mutateIndex((flows) => flows.filter((entry) => entry.id !== id));
  if (!indexed.ok) return indexed;

  /*
   * And on the server, where a sent flow also lives.
   *
   * Not awaited for permission and never allowed to fail the delete: the MCP
   * server is usually not running, and refusing to remove a flow locally
   * because nothing answered on loopback would be the wrong way round.
   *
   * Done now rather than after the undo window, because the reason someone
   * deletes a recording in a hurry is that they have just noticed what it
   * captured. The undo restores the local copy; the server's is gone until the
   * flow is sent again, which is the right way for that trade to fall.
   */
  void deleteRemoteFlow(id).catch(() => {
    // Belt and braces: nothing downstream of a local delete may reject.
  });

  // `steps: []` is the ghost case, and the caller reads it as "there is nothing
  // here to offer an undo for".
  return ok({ meta, steps: steps ?? [], react });
}

/** Everything a delete took, which is everything an undo has to put back. */
export interface DeletedFlow {
  meta: FlowMeta;
  steps: Step[];
  react: FlowReact | null;
}

/** Put a deleted flow back, for the undo on the toast. */
export async function restoreFlow(
  meta: FlowMeta,
  steps: Step[],
  react: FlowReact | null = null,
): Promise<Result<void>> {
  const written = await setLocal({
    [savedFlowKey(meta.id)]: steps,
    ...(react ? { [savedFlowReactKey(meta.id)]: react } : {}),
  });
  if (!written.ok) return written;

  return mutateIndex((flows) => [meta, ...flows.filter((entry) => entry.id !== meta.id)]);
}
