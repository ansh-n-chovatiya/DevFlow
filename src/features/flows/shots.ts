/**
 * The live recording's screenshots, one storage key each.
 *
 * `recordedSteps` is a single key that every capture rewrites whole: the worker
 * reads the array, appends one step, and writes all of it back. With the images
 * inline that array *is* the recording's weight — a screenshot is ~335 KB of
 * base64, and an annotated step keeps two of them — so the cost of recording
 * step N was the cost of rewriting steps 1…N.
 *
 * Measured against real screenshot sizes, on the annotated path that most steps
 * take:
 *
 * | step | per capture | key holds | written so far |
 * | ---- | ----------- | --------- | -------------- |
 * |   30 |     24 ms   |    19 MB  |        0.3 GB  |
 * |  100 |     68 ms   |    64 MB  |        3.2 GB  |
 * |  200 |    136 ms   |   128 MB  |       12.5 GB  |
 * |  500 |             |   320 MB  |                |
 *
 * The 500-step row has no timing because the measurement did not finish. That
 * is the real limit: `MAX_STEPS` is 500, and long before it the service worker
 * is holding a third of a gigabyte in memory — twice over, since the read and
 * the write are both live at once — which is how an MV3 worker gets killed
 * mid-recording and takes the queued step with it.
 *
 * So the images live beside the array instead of in it. A capture now writes one
 * small step and one image, and the array stays proportional to the *number* of
 * steps rather than to their weight. Everything above collapses to a constant.
 *
 * The shape is a detail of the live recording only. An archived flow keeps its
 * images inline in `savedFlow_<id>`, exactly as before — that is written once,
 * not once per step, and a flow whose images were scattered across keys would
 * be a flow that could be half-deleted.
 */

import { stepKey } from '../../core/flow/index.js';
import { getLocal, getLocalKeys, removeLocal } from '../../chrome/storage.js';
import { ok, type Result } from '../../shared/result.js';
import type { Step } from '../../shared/types.js';

/**
 * Prefix for a per-step image key.
 *
 * Distinct from `savedFlow_` on purpose — "delete all flows" sweeps the local
 * area by prefix, and an image key that looked like a flow key would be counted
 * as a flow and reported in the total.
 */
export const SHOT_PREFIX = 'shot_';

/** Where one step's images are filed. */
export function shotKey(step: Pick<Step, 'timestamp' | 'type'>): string {
  return `${SHOT_PREFIX}${stepKey(step)}`;
}

/**
 * One step's images, as stored.
 *
 * Short field names because this is written once per capture and never read by
 * a human: `o` is the un-annotated original, kept only when annotating actually
 * changed the image, and resolved by readers as `?? s` exactly as the inline
 * form was.
 */
export interface Shot {
  s: string | null;
  o: string | null;
}

function isShot(value: unknown): value is Shot {
  return typeof value === 'object' && value !== null && 's' in value;
}

/**
 * The storage patch that files one step's images, or `null` when it has none.
 *
 * Returned rather than written so the caller can put it in the *same*
 * `storage.set` as the step it belongs to. Two writes would mean a window in
 * which a step exists with no image, or an image exists with no step — and the
 * capture path is interrupted by a worker shutdown often enough for that window
 * to be reached.
 */
export function shotPatch(
  step: Pick<Step, 'timestamp' | 'type'>,
  screenshot: string | null,
  original: string | null,
): Record<string, Shot> | null {
  if (!screenshot && !original) return null;
  return { [shotKey(step)]: { s: screenshot, o: original } };
}

/** A step with its images removed, for storing in the array. */
export function withoutImages(step: Step): Step {
  const next = { ...step };
  delete next.screenshot;
  delete next.screenshotOriginal;
  return next;
}

/**
 * Put the images back on the steps that have them.
 *
 * A step whose key holds nothing comes back with `screenshot: null`, which is
 * what a capture that failed has always looked like — so a reader cannot tell
 * the difference between an image that was never taken and one this function
 * could not find, and neither can be mistaken for an image that is still
 * loading. There is no third state to represent.
 */
export async function hydrate(steps: Step[]): Promise<Step[]> {
  if (steps.length === 0) return steps;

  const keys = steps.map(shotKey);
  const stored = await getLocal(keys);
  if (!stored.ok) return steps.map((step) => ({ ...step, screenshot: null }));

  return steps.map((step) => {
    const shot = stored.value[shotKey(step)];
    if (!isShot(shot)) return { ...step, screenshot: step.screenshot ?? null };
    return { ...step, screenshot: shot.s, screenshotOriginal: shot.o };
  });
}

/**
 * The tail of a recording, hydrated — for the popup's thumbnail strip.
 *
 * The popup shows the last few images and a count of the rest, so hydrating the
 * whole recording to draw three pictures would reintroduce the cost this module
 * exists to remove, in the one surface that opens on every click of the toolbar
 * icon.
 */
export async function hydrateTail(steps: Step[], count: number): Promise<Step[]> {
  if (steps.length <= count) return hydrate(steps);

  const head = steps.slice(0, steps.length - count);
  const tail = await hydrate(steps.slice(steps.length - count));
  return [...head, ...tail];
}

/**
 * Split hydrated steps back into an array to store and the images to store with
 * it, and name the image keys that no step claims any more.
 *
 * The third value is what keeps a deletion from leaking: the viewer drops a step
 * and writes the rest back, and without this its 335 KB would sit in local
 * storage under a key nothing will ever ask for again. `sweep` covers the
 * recording being cleared wholesale; this covers it being edited.
 */
export function dehydrate(
  steps: Step[],
  previous: Step[] = [],
): { steps: Step[]; shots: Record<string, Shot>; orphans: string[] } {
  const shots: Record<string, Shot> = {};

  for (const step of steps) {
    const patch = shotPatch(step, step.screenshot ?? null, step.screenshotOriginal ?? null);
    if (patch) Object.assign(shots, patch);
  }

  /*
   * Orphans are read off `previous`, not off storage.
   *
   * The obvious implementation asks the local area which `shot_` keys exist and
   * subtracts the ones still claimed — and `storage.local.get(null)` returns
   * every key's *value*, so that question costs every archived flow and every
   * screenshot in it, on a path that runs whenever the viewer saves an edit.
   * The caller already knows what the array held a moment ago, which answers it
   * exactly and for free.
   */
  const live = new Set(steps.map(shotKey));
  const orphans = previous
    .map(shotKey)
    .filter((key) => !live.has(key));

  return { steps: steps.map(withoutImages), shots, orphans };
}

/**
 * Delete every live-recording image.
 *
 * The paths that call this are the ones where the steps are about to be gone —
 * Discard, Start (which clears the previous recording), the worker's
 * `CLEAR_STEPS` — so it must run *before* the array is emptied on the fallback
 * below. Asking the array which images to delete after emptying it is how the
 * images survive it.
 */
export async function sweep(): Promise<Result<void>> {
  /*
   * By prefix where the browser can list keys without reading them, which also
   * collects anything a crashed capture left behind — a step whose image was
   * written and whose array write never landed has a key nothing names.
   */
  const listed = await getLocalKeys();
  if (listed.ok && listed.value !== null) {
    const keys = listed.value.filter((key) => key.startsWith(SHOT_PREFIX));
    return keys.length ? removeLocal(keys) : ok();
  }

  /*
   * Before Chrome 130 there is no way to list keys without also reading them,
   * and reading them means reading every archived flow. So the images are
   * derived from the steps that name them instead: cheap, because the array no
   * longer carries the images, and complete for every case except the crash
   * above — which leaks one screenshot, not a recording.
   */
  const stored = await getLocal('recordedSteps');
  if (!stored.ok) return stored;

  const steps = Array.isArray(stored.value.recordedSteps) ? stored.value.recordedSteps : [];
  const keys = steps.map(shotKey);
  return keys.length ? removeLocal(keys) : ok();
}
