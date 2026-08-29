/**
 * Viewer controller: owns the state, routes between the two views, and is the
 * only place either of them talks to storage.
 *
 * The file it replaces was 1,496 lines holding the whole flow-management product
 * — save, load, delete, edit, annotate, export, transmit — with no seam between
 * UI and Chrome APIs. What is left here is a router and a state object; every
 * decision it used to make inline now lives in a pure module with tests.
 */

import { bytesInUse, getLocal } from '../../chrome/storage.js';
import { load as loadSettings } from '../../features/settings/index.js';
import { flowHost } from '../../core/flow/index.js';
import { editorTemplate } from '../../core/react/editor.js';
import {
  CURRENT_FLOW_NAME,
  listFlows,
  readCurrent,
  readCurrentReact,
  readFlow,
  saveAsFlow,
  updateFlowSteps,
  writeCurrent,
} from '../../features/flows/store.js';
import { withoutImages } from '../../features/flows/shots.js';
import { ok, type Result } from '../../shared/result.js';
import type { RecordingState, Step } from '../../shared/types.js';
import { formatDateTime } from '../format.js';
import { hydrateIcons } from '../icons.js';
import { initTheme } from '../theme.js';
import { readRecordingStamp } from '../../features/settings/recording.js';
import { showToast } from '../toast.js';
import type { App, ViewerState } from './app.js';
import { askName } from './dialogs.js';
import { mountLibrary, showLibrary } from './library.js';
import { mountReview, showReview } from './review.js';
import { parseRoute, routeHash, sameRoute, type Route } from './route.js';

initTheme();
hydrateIcons();

const state: ViewerState = {
  route: parseRoute(location.hash),
  flows: null,
  current: null,
  usedBytes: null,
  query: '',
  sort: 'recent',
  flow: null,
  missing: false,
  filter: 'all',
  activeIndex: null,
  undo: [],
  editor: null,
};

const app: App = {
  state,
  navigate,
  paint,
  reload,
  commit,
};

const library = mountLibrary(app, () => void saveCurrent());
const review = mountReview(app, () => void saveCurrent());

// ── Painting ─────────────────────────────────────────────────────────────────

function paint(): void {
  const onLibrary = state.route.view === 'library';

  showLibrary(onLibrary);
  showReview(!onLibrary);

  if (onLibrary) library.paint();
  else review.paint();
}

// ── Routing ──────────────────────────────────────────────────────────────────

function navigate(route: Route): void {
  if (sameRoute(route, state.route)) return;

  location.hash = routeHash(route);
  // `hashchange` does the rest, so a click and a Back button take one path.
}

window.addEventListener('hashchange', () => {
  const next = parseRoute(location.hash);
  if (sameRoute(next, state.route)) return;

  state.route = next;
  // Leaving a flow clears what only made sense inside it. The undo stack in
  // particular: offering to restore a step into a flow you are no longer
  // looking at is a promise the screen cannot show you being kept.
  state.flow = null;
  state.missing = false;
  state.filter = 'all';
  state.activeIndex = null;
  state.undo = [];

  paint();
  void reload();
  window.scrollTo({ top: 0 });
});

// ── Reading ──────────────────────────────────────────────────────────────────

async function readRecordingState(): Promise<RecordingState> {
  const stored = await getLocal(['recordingActive', 'recordingPaused']);
  if (!stored.ok) return 'idle';

  return stored.value.recordingActive
    ? stored.value.recordingPaused
      ? 'paused'
      : 'recording'
    : 'idle';
}

async function reload(): Promise<void> {
  const [steps, recording] = await Promise.all([readCurrent(), readRecordingState()]);

  if (steps.ok) {
    state.current = { steps: steps.value, recording };
  } else {
    // Reported, and left as `null` — the "still loading" state.
    //
    // Coercing the failure to `[]` was worse than silent: an empty array is
    // indistinguishable from "nothing was recorded", so a read that failed hid
    // the current-flow card and printed "Nothing saved yet" over a twenty-step
    // recording that is sitting safely in storage. The flow below toasts its
    // own read errors; this one has no more right to swallow its own.
    showToast({ message: steps.error.message, tone: 'danger' });
  }

  if (state.route.view === 'library') {
    const [flows, used] = await Promise.all([listFlows(), bytesInUse()]);

    state.flows = flows.ok ? flows.value : [];
    state.usedBytes = used;
    if (!flows.ok) showToast({ message: flows.error.message, tone: 'danger' });

    paint();
    return;
  }

  if (state.route.id === null) {
    // The read above failed, so there is nothing honest to put on screen. The
    // review screen's own loading state is truer than an empty recording.
    if (!state.current) {
      paint();
      return;
    }

    state.flow = {
      id: null,
      name: CURRENT_FLOW_NAME,
      steps: state.current.steps,
      createdAt: state.current.steps[0]?.timestamp ?? null,
      // Re-read on every reload rather than held: the resolver writes to this
      // key while the recording runs, so a cached copy would go stale on screen.
      react: await readCurrentReact(state.current.steps),
      // Re-read alongside the component table, and for the same reason: the
      // recording may still be running, and the export and send paths both need
      // the stamp the *worker* is capturing under rather than one this tab
      // happened to read when it opened.
      settings: await readRecordingStamp(),
    };
    state.missing = false;
    paint();
    return;
  }

  const flow = await readFlow(state.route.id);
  if (!flow.ok) {
    state.missing = true;
    showToast({ message: flow.error.message, tone: 'danger' });
  } else if (!flow.value) {
    state.missing = true;
  } else {
    state.flow = {
      id: flow.value.id,
      name: flow.value.name,
      steps: flow.value.steps,
      createdAt: flow.value.meta?.createdAt ?? null,
      react: flow.value.react,
      settings: flow.value.meta?.settings ?? null,
    };
    state.missing = false;
  }

  paint();
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * What storage held for each watched key right after we last wrote it, so our
 * own change does not come back as an external one.
 *
 * `storage.onChanged` fires for every write including ours, and reacting to it
 * would rebuild the step list under the user on every note they finish typing.
 * That much has always been true. What was wrong was the test: a 500 ms clock,
 * which suppressed *every* local change in the window and not merely ours.
 *
 *  - Finish typing a note, then press Stop within half a second, and the
 *    `recordingActive: false` that Stop writes was swallowed along with it. No
 *    further write ever came, so the viewer sat on `status: 'recording'` and
 *    library.ts kept Save disabled — the recording could not be archived
 *    without reloading the tab by hand.
 *  - Same window, press Discard, and the `recordedSteps: []` was swallowed too.
 *    The viewer still held the five steps, and the user's next edit wrote them
 *    back: a recording deleted under "This cannot be undone" came back.
 *
 * And the marker was set *before* the write, so a write slower than the window
 * outlived its own guard and repainted anyway.
 *
 * So: match on content, never on the clock, and only for the keys we actually
 * wrote. A change somebody else made never matches, whatever its timing.
 */
const selfWrites = new Map<string, string>();

/**
 * The write currently in flight, if any.
 *
 * A change event can arrive before its own `set` callback has run, and judging
 * it against a marker that has not been recorded yet would repaint under the
 * user — the very thing this machinery exists to avoid. So a change that fires
 * mid-write waits for the write to settle and is judged then.
 */
let inFlight: Promise<void> | null = null;

/**
 * A fingerprint of a stored value, used for "is this change ours?" and nothing
 * else.
 *
 * Not `JSON.stringify`: a stored value can run to megabytes, and serialising
 * all of it on every capture the worker makes would cost far more than the
 * repaint it saves. Long strings are folded down to their length and their
 * first few characters — enough that an annotated screenshot differs from the
 * one it replaced, which is the comparison that matters.
 *
 * Two different values can collide only if every one of those matches, and a
 * collision costs a repaint that was not needed. The failure that matters is
 * the other one — treating somebody else's change as ours — and it needs an
 * exact match to happen at all.
 */
function fingerprint(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 64 ? `${value.length}#${value.slice(0, 64)}` : value;
  }
  if (Array.isArray(value)) return `[${value.map(fingerprint).join('|')}]`;
  if (value === null || typeof value !== 'object') return String(value);

  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${key}=${fingerprint(entry)}`)
    .sort()
    .join(',');
}

/** Record what our write left behind, so its change event can be recognised. */
function markSelfWrite(key: string, value: unknown): void {
  selfWrites.set(key, fingerprint(value));
}

/**
 * The same, for `recordedSteps` — fingerprinted as *stored*, not as returned.
 *
 * `writeCurrent` hands back the steps carrying their screenshots, because that
 * is what the screen should be showing; what it puts in the key is the same
 * array with the images stripped out to `shot_` keys of their own. Marking the
 * returned form recorded a fingerprint that the change event could never match,
 * so the viewer read every one of its own writes as somebody else's and
 * repainted — rebuilding the step list under a textarea the user had just left,
 * which is the exact failure the markers above exist to prevent.
 *
 * `withoutImages` is the transform `dehydrate` applies on the way in, so this
 * reproduces what landed rather than guessing at it.
 */
function markSelfWriteSteps(steps: Step[]): void {
  markSelfWrite('recordedSteps', steps.map(withoutImages));
}

/**
 * The same, for a key whose written value the viewer never sees.
 *
 * `updateFlowSteps` rewrites the index as well as the steps, and derives the
 * entry itself, so the only way to know what it wrote is to read it back.
 * `recordedSteps` is deliberately *not* marked this way: the worker can append
 * a capture between our write and that read, and fingerprinting its value would
 * make its change look like ours and leave the new step off the screen.
 */
async function markSelfWriteFromStorage(key: string): Promise<void> {
  const stored = await getLocal(key);
  if (stored.ok) markSelfWrite(key, stored.value[key]);
}

/** Write the open flow's steps back to wherever they came from. */
async function commit(steps: Step[]): Promise<void> {
  const { flow } = state;
  if (!flow) return;

  const running = writeFlow(flow.id, steps);
  const settled = running.then(
    () => undefined,
    () => undefined,
  );
  inFlight = settled;

  const written = await running;
  if (inFlight === settled) inFlight = null;

  if (!written.ok) {
    // The write failed, so the screen is now showing something that is not
    // stored. Re-reading is the only honest response.
    showToast({ message: written.error.message, tone: 'danger' });
    await reload();
    return;
  }

  // `written.value` is the merged array, not the one we passed: a capture that
  // landed while the user was typing is in storage now, so it belongs on screen
  // too. For a saved flow there is nothing to merge and nothing to update.
  if (flow.id === null && written.value && state.current) {
    const merged = written.value;
    // Repainted only when the merge actually brought something back. Doing it
    // on every write would rebuild the list under a textarea the user has just
    // left, which is the whole reason review.ts has a `repaint: false` path.
    const changed = fingerprint(merged) !== fingerprint(steps);

    state.current.steps = merged;
    flow.steps = merged;
    if (changed) paint();
  }
}

/**
 * The write behind `commit`, plus the marker that lets the change event it
 * produces be recognised as ours.
 *
 * The live recording goes through `writeCurrent`'s merge rather than a plain
 * overwrite, with the pre-edit array as the base — see store.ts for why one tab
 * writing its whole in-memory copy loses the worker's captures, and vice versa.
 */
async function writeFlow(id: string | null, steps: Step[]): Promise<Result<Step[] | null>> {
  if (id !== null) {
    const written = await updateFlowSteps(id, steps);
    await markSelfWriteFromStorage('savedFlowsMeta');
    return written.ok ? ok(null) : written;
  }

  const written = await writeCurrent(steps, state.current?.steps ?? steps);
  if (written.ok) markSelfWriteSteps(written.value);
  return written;
}

async function saveCurrent(): Promise<void> {
  const steps = state.current?.steps ?? [];
  if (steps.length === 0) {
    showToast({ message: 'There is nothing to save yet.' });
    return;
  }

  const name = await askName({
    title: 'Save this recording',
    label: 'Flow name',
    value: suggestName(steps),
    confirmLabel: 'Save flow',
  });
  if (!name) return;

  const saved = await saveAsFlow(name, steps);
  if (!saved.ok) {
    showToast({ message: saved.error.message, tone: 'danger' });
    return;
  }

  /*
   * Archived means no longer current.
   *
   * Leaving the steps in `recordedSteps` left the library showing an "Unsaved"
   * card with a live Save button directly above the row it had just created, so
   * pressing it again — which is a reasonable thing to do when the card still
   * says the recording is unsaved — wrote a second flow, with a new id and a
   * second full copy of every screenshot. Three copies of one recording inside
   * a 10 MB budget is how a library fills up.
   *
   * The base is the array that was archived, so a step the worker captured
   * while the save was in flight survives instead of being cleared along with
   * the ones that are now safely in the library.
   */
  const cleared = await writeCurrent([], steps);
  if (cleared.ok) markSelfWriteSteps(cleared.value);
  else showToast({ message: cleared.error.message, tone: 'danger' });

  await reload();
  showToast({
    message: `Saved “${name}” to the library.`,
    tone: 'success',
  });
}

/**
 * What to call a recording, before the user renames it.
 *
 * The page's own title first: "ChatGPT" says what the flow is about in a way
 * that "chatgpt.com — 3 steps" does not, and the row underneath already prints
 * the step count, the host and the size. A name that repeats the line below it
 * is a name doing no work.
 */
function suggestName(steps: Step[]): string {
  const title = steps.find((step) => step.title?.trim())?.title?.trim();
  if (title) return title.slice(0, 80);

  const host = flowHost(steps);
  return host || `Recording — ${formatDateTime(Date.now())}`;
}

// ── The editor link ──────────────────────────────────────────────────────────

/**
 * Reads the two settings that decide whether a source path is clickable.
 *
 * Both have to be present: a root with no usable template has nowhere to send
 * the file, and a template with no root has no absolute path to send. Either
 * one missing leaves `state.editor` null, which is the view model's signal to
 * show the path and no button.
 */
async function readEditorSettings(): Promise<void> {
  const { projectRoot, editor, customEditorTemplate } = await loadSettings();
  const template = editorTemplate(editor, customEditorTemplate);

  state.editor = projectRoot && template ? { projectRoot, template } : null;
}

/** Settings live in another tab, so what is on screen has to follow them. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (!['projectRoot', 'editor', 'customEditorTemplate'].some((key) => key in changes)) return;

  void readEditorSettings().then(paint);
});

// ── Live updates ─────────────────────────────────────────────────────────────

const WATCHED_KEYS = ['recordedSteps', 'recordingActive', 'recordingPaused', 'savedFlowsMeta'];

function applyChanges(changes: Record<string, chrome.storage.StorageChange>): void {
  // Ours, or somebody else's? A change whose new value is exactly what we last
  // wrote is the echo of our own write and is already on screen. Everything
  // else — Stop, Discard, a capture from the tab being recorded — is news.
  const external = WATCHED_KEYS.filter(
    (key) => key in changes && fingerprint(changes[key].newValue) !== selfWrites.get(key),
  );
  if (external.length === 0) return;

  // A recording running in another tab changes the flow under our feet. Only
  // the library and the live flow follow it; a saved flow being reviewed is not
  // affected by what the recorder is doing.
  const reviewingSaved = state.route.view === 'review' && state.route.id !== null;
  if (reviewingSaved && !external.includes('savedFlowsMeta')) return;

  void reload();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!WATCHED_KEYS.some((key) => key in changes)) return;

  // Chrome can deliver the event before the `set` that caused it has called
  // back, so a change that arrives mid-write is judged once the write has
  // recorded what it wrote. Waiting is invisible: an external change reloads a
  // moment later, and our own echo is dropped rather than repainting.
  if (inFlight) void inFlight.then(() => applyChanges(changes));
  else applyChanges(changes);
});

// ── Start ────────────────────────────────────────────────────────────────────

// The route decides which view is on screen before anything is read, so the
// right skeleton is showing while it loads rather than the wrong one.
paint();
void reload();
void readEditorSettings().then(paint);
