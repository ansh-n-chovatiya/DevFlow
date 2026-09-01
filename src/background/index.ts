/**
 * MV3 service worker: screenshot capture, step persistence, badge, MCP export,
 * and everything the two locate surfaces cannot do from where they stand.
 *
 * Every Chrome call goes through `src/chrome/`, so failures arrive as values.
 * The worker's job is to decide what a failure means for the recording — most
 * of the time "save the step without an image and tell the user why".
 *
 * The second half of that job came from react-source-locator, and is the reason
 * locating is reachable from either door. A DevTools panel cannot read a
 * cross-origin bundle and has no scripting relationship with the page at all;
 * a popup has none either beyond this worker. So the worker fetches on their
 * behalf and relays their pick messages to the tab's content script, and both
 * surfaces send the same messages to get the same work done.
 */

import { annotateScreenshot } from './annotator.js';
import { getLocal, setLocal } from '../chrome/storage.js';
import {
  load as loadSettings,
  migrateLegacySettings,
} from '../features/settings/index.js';
import {
  loadRecordingSettings,
  readRecordingStamp,
  renderedOverrides,
  snapshotForRecording,
} from '../features/settings/recording.js';
import { applyPending } from '../features/settings/pending.js';
import { isMachineKey } from '../features/settings/fields.js';
import { deliverMachineSettings } from '../features/mcp/machine.js';
import type { RecordingSettings } from '../features/settings/fields.js';
import { shotPatch, sweep as sweepShots, withoutImages } from '../features/flows/shots.js';
import { captureVisibleTab, sendToTab } from '../chrome/tabs.js';
import { fetchText } from '../chrome/fetch.js';
import { openPopup, paintAction as paint } from '../chrome/action.js';
import type { Result } from '../shared/result.js';
import type {
  ComponentSourceResponse,
  ContentRequest,
  FetchContentResponse,
  OpenEditorResponse,
  WorkerRequest,
} from '../shared/messages.js';
import { isEditorScheme } from '../core/react/editor.js';
import {
  BADGE_COLOR,
  BADGE_PAUSED_COLOR,
  BADGE_WAITING_COLOR,
} from '../shared/constants.js';
import { flowError, type FlowError } from '../shared/errors.js';
import type {
  BoundingBox,
  DomChange,
  DraftStep,
  FlowRenders,
  PickResult,
  RecordingState,
  StateStoreRef,
  Step,
  StepRender,
  StepStateDelta,
} from '../shared/types.js';
import type { CapturedComponent } from '../shared/messages.js';
import { stripReactRef } from '../core/react/attribution.js';
import { flowHost, mergeTrailing, stepKey, type Pending } from '../core/flow/index.js';
import { mergeComponents } from '../core/react/table.js';
import { mergeScripts } from '../features/react/inventory.js';
import { clearResolverCaches, resolvePending } from '../features/react/resolver.js';
import { ingestComponentPick } from '../features/arkg/ingest.js';
import { buildPayload, pruneSteps } from '../features/mcp/send.js';
import { sendDefaults } from '../features/export/defaults.js';
import { readCurrentReact, readCurrentRenders, readCurrentState } from '../features/flows/store.js';
import { prepare } from '../features/recording/preflight.js';
import { renumber } from '../core/flow/index.js';

/** Serialises captures so concurrent clicks never clobber each other's write. */
let captureQueue: Promise<void> = Promise.resolve();

/**
 * Screenshots taken on pointerdown, waiting for the click that follows.
 * Keyed by tab, because two tabs can be mid-interaction at once.
 */
const precaptures = new Map<number, { dataUrl: string; at: number }>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The toolbar tooltip when there is nothing to say. Kept identical to the
 * manifest's `default_title`, which is what Chrome shows until the first
 * `setTitle` of a browser session.
 */
const IDLE_TITLE = 'DevFlow — record a flow';

/**
 * The other two badge colours.
 *
 * `BADGE_COLOR` is the red of a live recording and is Tier 3 for the reason
 * stated where it is declared: a recording nobody noticed starting is the most
 * expensive thing this extension can do. Pause and stop are the other two things
 * the toolbar has to be able to say, and saying them in the same red is how the
 * toolbar came to mean "something happened here at some point". These are the
 * `--warn` and `--fg-muted` of the light theme, so the toolbar agrees with the
 * on-page indicator rather than inventing a third palette.
 */

function stepsLabel(count: number): string {
  return count === 1 ? '1 step' : `${count} steps`;
}

/**
 * Say which of the three states the recorder is in, on the one surface that is
 * visible when the recorded tab is not.
 *
 * The count alone cannot do it: `23` on a stopped recording and `23` on a live
 * one were the same badge, so the toolbar answered "am I still recording?" with
 * the number of steps and nothing else. The number is still the most useful
 * thing to show — it is what the user is watching climb — so what carries the
 * state is the colour and the tooltip, and the tooltip names the host so a
 * recording running in another window is attributable without switching to it.
 */
function paintAction(state: RecordingState, count: number, host: string): void {
  const where = host ? ` on ${host}` : '';

  const title =
    state === 'recording'
      ? `Recording${where} · ${stepsLabel(count)}`
      : state === 'paused'
        ? `Recording paused${where} · ${stepsLabel(count)}`
        : count === 0
          ? IDLE_TITLE
          : `${stepsLabel(count)} recorded${where} · not saved to the library`;

  paint({
    // `0` while recording, and nothing at all when idle with nothing waiting:
    // an empty badge is the only way to say "there is no flow here".
    text: state === 'idle' && count === 0 ? '' : String(count),
    color:
      state === 'recording'
        ? BADGE_COLOR
        : state === 'paused'
          ? BADGE_PAUSED_COLOR
          : BADGE_WAITING_COLOR,
    title,
  });
}

/**
 * Repaint the toolbar from storage.
 *
 * Driven from the storage change rather than from each of the six writes that
 * can alter it. Three of those writes are the popup's and the viewer's, not the
 * worker's — pausing, discarding, archiving — and every one of them used to
 * leave the badge saying whatever the last capture had said. One reconciler on
 * the keys the answer is made of is the only version a caller cannot forget.
 */
async function refreshAction(): Promise<void> {
  const stored = await getLocal(['recordingActive', 'recordingPaused', 'recordedSteps']);
  if (!stored.ok) return;

  const steps = stored.value.recordedSteps ?? [];
  const state: RecordingState = stored.value.recordingActive
    ? stored.value.recordingPaused
      ? 'paused'
      : 'recording'
    : 'idle';

  paintAction(state, steps.length, flowHost(steps));
}

/**
 * Record a failure where the UI can find it. The popup and the viewer both read
 * `lastError`, so a silent capture or storage failure becomes something the user
 * can actually see.
 */
async function reportError(error: FlowError): Promise<void> {
  console.warn(`DevFlow: ${error.code} — ${error.detail ?? error.message}`);
  await setLocal({ lastError: { ...error, at: Date.now() } });
}

/**
 * Take the pre-capture for a tab if one is fresh enough to still be true.
 *
 * `ttlMs` is the recording's frozen `screenshots.precaptureTtlMs`, passed in by
 * the one caller — which has the snapshot in hand anyway, and which is the only
 * place that knows *which* recording this frame belongs to.
 */
function claimPrecapture(tabId: number | undefined, ttlMs: number): string | null {
  if (tabId == null) return null;
  const held = precaptures.get(tabId);
  if (!held) return null;
  precaptures.delete(tabId);
  return Date.now() - held.at <= ttlMs ? held.dataUrl : null;
}

/** Capture, annotate and persist one step, enforcing the step limit. */
async function captureAndSave(
  step: DraftStep,
  elementBox: BoundingBox | null,
  dpr: number,
  sender: chrome.runtime.MessageSender,
  components?: CapturedComponent[],
  componentsPageUrl?: string,
  /** Where the page was scrolled when `elementBox` was measured. */
  measuredScroll?: { x: number; y: number },
): Promise<void> {
  /*
   * The settings this recording was frozen at, not the ones in force now.
   *
   * Settings are frozen for the duration of a recording, so a capture that
   * lands after the user has changed the quality still uses the quality the
   * flow's first step used — and the flow's stamp is true of every step in it.
   * Read here, per capture, rather than into a module-level constant: the
   * worker is killed and restarted at Chrome's discretion, and a value taken at
   * import would be the compiled-in default for every recording thereafter.
   *
   * Read *before* the pre-capture is claimed, because the claim now needs the
   * recording's own TTL. The claim is a map lookup either way; the only thing
   * the extra await can change is that a pointerdown arriving in the gap
   * replaces the held frame with a newer one of the same tab, which is the
   * better frame anyway.
   */
  const recording = await loadRecordingSettings();

  // A pre-capture is already the right frame — waiting would only let the page
  // navigate further away from the moment being described.
  //
  // Clicks only. The frame is taken on pointerdown for the click that follows,
  // and a pointerdown that never becomes one — a drag, a press released off the
  // element — leaves it in the map for its full TTL. Any step at all could
  // claim it, so a navigation or a debounced keystroke seconds later was filed
  // with a photograph of a moment it had nothing to do with.
  const preShot =
    step.type === 'click'
      ? claimPrecapture(sender.tab?.id, recording['screenshots.precaptureTtlMs'])
      : null;

  if (!preShot) await delay(recording['screenshots.settleDelayMs']);

  const stored = await getLocal([
    'recordedSteps',
    'recordingActive',
    'recordingTabId',
    'reactComponents',
    'reactNeedles',
  ]);
  if (!stored.ok) {
    await reportError(stored.error);
    return;
  }

  const maxSteps = recording['recording.maxSteps'];
  const recordedSteps = (stored.value.recordedSteps ?? []);
  const recordingActive = Boolean(stored.value.recordingActive);

  // Bail if recording stopped while this capture sat in the queue. Without this,
  // every queued capture sees length >= maxSteps and pushes its own duplicate
  // "limit reached" note.
  if (!recordingActive) return;

  if (recordedSteps.length >= maxSteps) {
    recordedSteps.push({
      type: 'note',
      url: step.url,
      timestamp: Date.now(),
      action: 'limit-reached',
      value: `Recording stopped at ${maxSteps} steps, DevFlow's safety limit. Every step up to here was saved.`,
      screenshot: null,
      stepNumber: recordedSteps.length + 1,
    });
    // Ending a recording and forgetting its tab are one write, here as
    // everywhere else — see `recordingTabId` in `shared/types.ts`.
    const written = await setLocal({
      recordingActive: false,
      recordingTabId: null,
      recordedSteps,
    });
    if (!written.ok) await reportError(written.error);
    return;
  }

  let dataUrl: string | null = preShot;

  /*
   * Why this step has no picture, in the flow rather than only in the log.
   *
   * Nothing in Tier 1 may make a recording silently worse. Screenshots
   * switched off, a capture Chrome refused and a tab that was not on screen all
   * produce the same missing image, and a reader who cannot tell them apart
   * reads every one of them as a page that rendered nothing. Whichever it was
   * travels with the step — see `screenshotOmitted` in `shared/types.ts`.
   */
  let omitted: string | null = null;

  // `captureVisibleTab` photographs the window's *visible* tab, whichever tab
  // asked. A step from a tab that is not on screen — a debounced input that
  // fires after the user switches away, a background tab acting on its own —
  // would be filed with a picture of a different page, which is worse than no
  // picture: it reads as evidence. The step keeps its selectors, timing and
  // network either way.
  const senderVisible = sender.tab?.active !== false;
  if (!dataUrl && !recording['screenshots.capture']) {
    omitted = 'Screenshots are switched off in DevFlow settings for this recording.';
  } else if (!dataUrl && !senderVisible) {
    omitted = 'The tab was not on screen when this step was captured, so no screenshot was taken.';
  } else if (!dataUrl) {
    const captured = await captureVisibleTab(
      sender.tab?.windowId,
      recording['screenshots.quality'],
      recording['screenshots.minIntervalMs'],
    );
    if (captured.ok) {
      dataUrl = captured.value;
    } else {
      // A step with no image still carries its selectors, timing and network —
      // losing the whole step because the screenshot failed would be worse.
      await reportError(captured.error);
      omitted = `The screenshot could not be taken (${captured.error.code}).`;
    }
  }

  /*
   * How far the page moved between measuring the box and taking the picture.
   *
   * Asked of the page only when there is a box to correct and a frame that
   * postdates it. A pre-capture is the opposite case — that frame was taken
   * *before* the measurement, so the box is already in its coordinate space and
   * a delta would move the highlight off the element rather than onto it.
   */
  let scrollDelta: { x: number; y: number } | undefined;
  if (dataUrl && !preShot && elementBox && measuredScroll && sender.tab?.id != null) {
    const now = await sendToTab<{ x: number; y: number }>(sender.tab.id, { type: 'GET_SCROLL' });
    if (now.ok && Number.isFinite(now.value?.x) && Number.isFinite(now.value?.y)) {
      scrollDelta = { x: now.value.x - measuredScroll.x, y: now.value.y - measuredScroll.y };
    }
  }

  // The stored box moves with the drawn one, so it stays in the capture's
  // coordinate space — which is what `core/flow/index.ts` documents it as, and
  // what the viewer re-draws from when it re-annotates a step.
  const capturedBox =
    elementBox && scrollDelta
      ? { ...elementBox, x: elementBox.x - scrollDelta.x, y: elementBox.y - scrollDelta.y }
      : elementBox;

  let screenshot: string | null = null;
  let screenshotOriginal: string | null = null;

  if (dataUrl) {
    screenshot = await annotateScreenshot(
      dataUrl,
      elementBox,
      dpr,
      recording['screenshots.quality'],
      recording['annotation.stroke'],
      scrollDelta,
    );
    // Only when annotating changed the image — otherwise the two are identical
    // and every capture rewrites both. Readers resolve null as `?? screenshot`.
    // Compared, not inferred from `elementBox`: the annotator also returns the
    // source unchanged when it cannot get a canvas.
    screenshotOriginal = screenshot === dataUrl ? null : dataUrl;
  }

  /*
   * The step goes in the array; its images go in a key of their own.
   *
   * Every capture rewrites `recordedSteps` whole, so anything left inline here
   * is paid for again on every step that follows it — see `features/flows/shots`
   * for what that cost measured. The two are written together below, in one
   * `set`, so there is no moment where one exists without the other.
   */
  const captured = {
    ...step,
    screenshotOriginal,
    highlightBox: capturedBox,
    dpr: dpr || 1,
    screenshot,
    // Absent when there is an image, so a flow full of ordinary steps carries
    // nothing extra and an older reader sees exactly what it saw before.
    ...(omitted ? { screenshotOmitted: omitted } : {}),
    stepNumber: recordedSteps.length + 1,
  } as Step;

  recordedSteps.push(withoutImages(captured));

  /*
   * Which tab this recording is happening in, learned from the tab producing it.
   *
   * `recordingTabId` exists so the flow review can arm the picker on the page
   * being recorded (`shared/types.ts`), and the worker is not where a recording
   * starts — the popup writes `recordingActive: true`. What the worker has is
   * better than a guess made at that moment anyway: the tab that sent this step.
   * The content script logs a navigation step the instant a recording starts, so
   * the id lands with the recording's own first write; and because a recording
   * follows the user across tabs, re-reading it from each step keeps it naming
   * the tab they are actually recording in rather than the one they began on.
   *
   * `senderVisible`, for the same reason the screenshot uses it: a debounced
   * input arriving from a tab the user has switched away from is a step in this
   * recording, but it is not the page they would be pointing at.
   *
   * Only when it changed. This batch is written once per step, and rewriting an
   * identical id forty times would wake every `storage.onChanged` listener in
   * the product for nothing.
   */
  const senderTabId = senderVisible ? (sender.tab?.id ?? null) : null;
  const tabPatch =
    senderTabId !== null && senderTabId !== (stored.value.recordingTabId ?? null)
      ? { recordingTabId: senderTabId }
      : {};

  const merged = components?.length
    ? mergeComponents(
        components,
        componentsPageUrl ?? step.url,
        stored.value.reactComponents ?? {},
        stored.value.reactNeedles ?? {},
        // Frozen: the cap decides what this *recording* collected, and a table
        // whose first half was gathered under one ceiling and second half under
        // another is a table nothing describes. The `__capped__` row already
        // says the number it stopped at.
        recording['react.maxComponentsPerFlow'],
      )
    : null;

  const written = await setLocal({
    recordedSteps,
    ...tabPatch,
    ...(shotPatch(captured, screenshot, screenshotOriginal) ?? {}),
    // Only when something actually changed: a flow that clicks one button forty
    // times would otherwise rewrite an identical table forty times.
    ...(merged?.changed ? { reactComponents: merged.table, reactNeedles: merged.needles } : {}),
  });
  if (!written.ok) {
    await reportError(written.error);
    return;
  }

  if (merged?.changed) scheduleResolve();
}

/**
 * Attach a DOM delta to the step it belongs to.
 *
 * Arrives a few hundred milliseconds after the step, because it is a fact about
 * what the interaction *did* rather than what it was — and the step is written
 * immediately so the screenshot is not delayed waiting for it.
 *
 * Queued behind the capture queue, not run alongside it: both rewrite
 * `recordedSteps`, and two writers on one key is how an update gets lost. It is
 * cheap now that the array carries no images.
 */
async function attachDomDelta(key: string, before: string, after: string): Promise<void> {
  const stored = await getLocal(['recordedSteps', 'recordingActive']);
  if (!stored.ok || !stored.value.recordingActive) return;

  const recordedSteps = stored.value.recordedSteps ?? [];
  const index = recordedSteps.findIndex((step) => stepKey(step) === key);
  // The step may have been deleted in the review tab while the page was still
  // settling, or the recording cleared. Nothing to attach it to is not an error.
  if (index === -1) return;

  recordedSteps[index] = { ...recordedSteps[index], domDelta: { before, after } };

  const written = await setLocal({ recordedSteps });
  if (!written.ok) await reportError(written.error);
}

/**
 * Attach what the document did to the step it belongs to.
 *
 * `attachDomDelta`'s twin, one field over and for the same reasons: it arrives
 * after the step because it is a fact about what the interaction *did*, and it
 * is queued behind the capture queue because that queue owns `recordedSteps`.
 *
 * Written even when `changes` is empty, provided the observer was cut. An empty
 * list under `capped` is the one thing this feature must be able to say and the
 * one thing a "nothing to attach" shortcut would delete: it is the difference
 * between a step where nothing happened and one where nobody was still looking.
 */
async function attachDomChanges(
  key: string,
  changes: DomChange[],
  capped?: true,
  more?: number,
): Promise<void> {
  const stored = await getLocal(['recordedSteps', 'recordingActive']);
  if (!stored.ok || !stored.value.recordingActive) return;

  const recordedSteps = stored.value.recordedSteps ?? [];
  const index = recordedSteps.findIndex((step) => stepKey(step) === key);
  if (index === -1) return;
  if (!changes.length && !capped) return;

  recordedSteps[index] = {
    ...recordedSteps[index],
    domChanges: { changes, ...(capped ? { capped } : {}), ...(more ? { more } : {}) },
  };

  const written = await setLocal({ recordedSteps });
  if (!written.ok) await reportError(written.error);
}

/**
 * Merge a settled state sample into the step it belongs to.
 *
 * Behind the capture queue for `attachDomDelta`'s reason: that queue owns
 * `recordedSteps`, and the step this belongs to may still be in it.
 *
 * Two keys are written, not one. The deltas go on the step; the store
 * descriptions go on `stateStores`, which is a fact about the page rather than
 * about any step — a store forty steps touched is described once, and
 * `StepStateDelta.store` indexes it.
 */
async function attachStateDelta(
  key: string,
  deltas: StepStateDelta[],
  stores: StateStoreRef[] | undefined,
): Promise<void> {
  const stored = await getLocal(['recordedSteps', 'recordingActive', 'stateStores']);
  if (!stored.ok || !stored.value.recordingActive) return;

  const known = stored.value.stateStores ?? [];
  // Replaced rather than appended when the id is already known: a store's
  // subscriber list grows as the user visits more of the app, and the later
  // description is the more complete one.
  const merged = stores?.length
    ? [...known.filter((store) => !stores.some((next) => next.id === store.id)), ...stores]
    : known;

  const recordedSteps = stored.value.recordedSteps ?? [];
  const index = recordedSteps.findIndex((step) => stepKey(step) === key);
  // The step may have been deleted in the review tab while the app was still
  // settling, or the recording cleared. Nothing to attach it to is not an
  // error — but the stores it named are still what the page has, so they are
  // written whether or not the step survived.
  if (index !== -1 && deltas.length) {
    recordedSteps[index] = { ...recordedSteps[index], state: deltas };
  }

  const written = await setLocal({
    ...(index !== -1 && deltas.length ? { recordedSteps } : {}),
    ...(merged !== known ? { stateStores: merged } : {}),
  });
  if (!written.ok) await reportError(written.error);
}

/**
 * Merge what re-rendered into the step it belongs to.
 *
 * Behind the capture queue for `attachDomDelta`'s reason, and two keys again
 * for `attachStateDelta`'s: the list goes on the step, and what the *walk*
 * could not see goes on `flowRenders`, which is a fact about the recording
 * rather than about any step.
 *
 * `capped` is sticky. It is not "the last walk was cut" but "this recording was
 * cut somewhere", which is the only form of it a reader can act on: a flow that
 * reports two re-renders and does not say a walk was truncated is claiming
 * something it never checked.
 *
 * `flowRenders` is deliberately written even when the step is gone and the list
 * empty — the same rule the stores follow. What the recording could not see is
 * still true of the recording.
 */
async function attachRenders(
  key: string,
  renders: StepRender[],
  capped: boolean | undefined,
  note: string | undefined,
): Promise<void> {
  const stored = await getLocal(['recordedSteps', 'recordingActive', 'flowRenders']);
  if (!stored.ok || !stored.value.recordingActive) return;

  /*
   * `capped` is sticky and the note is kept once set: one step whose walk was
   * cut is enough to make "nothing re-rendered" a claim about the cap for every
   * step of the flow, and a reader has no way to ask which step it was.
   */
  const known = stored.value.flowRenders ?? undefined;
  const flowRenders: FlowRenders = {
    read: true,
    ...(capped || known?.capped ? { capped: true } : {}),
    ...(note ?? known?.note ? { note: note ?? known?.note } : {}),
  };

  const recordedSteps = stored.value.recordedSteps ?? [];
  const index = recordedSteps.findIndex((step) => stepKey(step) === key);
  if (index !== -1 && renders.length) {
    recordedSteps[index] = { ...recordedSteps[index], renders };
  }

  const written = await setLocal({
    ...(index !== -1 && renders.length ? { recordedSteps } : {}),
    flowRenders,
  });
  if (!written.ok) await reportError(written.error);
}

/**
 * End the recording once every capture already in flight has been written.
 *
 * A step is not saved when the user clicks — it is saved a few hundred
 * milliseconds later, after the paint wait, the settle delay and Chrome's
 * screenshot rate limit. `captureAndSave` drops any step that finds the
 * recording already over, so flipping the flag the moment Stop is pressed threw
 * away the last thing the user did, which on a bug report is the whole point of
 * the recording. Draining first also means the MCP auto-export — which fires on
 * this very storage change — sees the complete flow.
 */
async function finishRecording(): Promise<void> {
  // The queue can grow while it is being awaited: a step sent just before Stop
  // may still be arriving. Settle, re-check, and only stop when nothing was
  // added while waiting.
  let drained: Promise<void>;
  do {
    drained = captureQueue;
    await drained;
  } while (drained !== captureQueue);

  await flushTrailing(await loadRecordingSettings());

  const written = await setLocal({
    recordingActive: false,
    recordingPaused: false,
    recordingStartedAt: null,
    // In the batch that ends the recording, not after it. A separate write
    // would leave an instant in which nothing is recording and storage still
    // names a tab as the one being recorded, which is the whole of what
    // `recordingTabId` promises not to do.
    recordingTabId: null,
  });
  if (!written.ok) await reportError(written.error);

  // The reconciler on the change above would repaint anyway. Awaited here as
  // well because Stop is the one moment the toolbar was wrong for as long as the
  // browser stayed open: the badge kept the red and the count of a recording
  // that had ended, and no other path came back to correct it.
  await refreshAction();
}

/**
 * Forget the tab a recording was happening in, if storage still names one.
 *
 * Read before write, and silent when there is nothing to forget. This runs from
 * a `storage.onChanged` listener among other places, and an unconditional `set`
 * would echo through every listener in the product on every recording that ends
 * — including this one, which would then read `null` and write `null` again.
 */
async function clearRecordingTab(): Promise<void> {
  const stored = await getLocal('recordingTabId');
  if (!stored.ok || stored.value.recordingTabId == null) return;

  const written = await setLocal({ recordingTabId: null });
  if (!written.ok) await reportError(written.error);
}

/**
 * Whether a tab is still open.
 *
 * `chrome.tabs.get` rejects for a tab that is gone, and the callback form makes
 * that a `lastError` to read rather than a rejection to catch — which is the
 * only reason this is not `chrome/tabs.ts`'s promise style: an unread
 * `lastError` logs on every call for a tab that has closed, which is the case
 * this exists to detect.
 */
function tabIsOpen(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, () => resolve(!chrome.runtime.lastError));
  });
}

/**
 * Make `recordingTabId` true again after the worker has been away.
 *
 * The guarantee the key makes is that it never names a tab nothing is
 * recording, and every path that *ends* a recording clears it in the same write.
 * What no write can cover is the worker not being alive to make one: Chrome
 * kills the service worker at its own discretion, and the browser itself can be
 * closed mid-recording. Both come back to storage that still names a tab, and
 * in the second case to a browser where every tab id has been reissued — so the
 * id could name a tab that exists and is a completely unrelated page.
 *
 * Two answers, because they are two different facts. `onStartup` is a new
 * browser session and therefore a new set of tab ids, so the stored one is
 * meaningless whatever it says. An ordinary worker wake keeps the id if the tab
 * is still open, because it is still the right answer; the recording's next
 * step re-establishes it either way.
 */
async function reconcileRecordingTab(): Promise<void> {
  const stored = await getLocal(['recordingActive', 'recordingTabId']);
  if (!stored.ok) return;

  const tabId = stored.value.recordingTabId;
  if (tabId == null) return;

  if (stored.value.recordingActive !== true) {
    await clearRecordingTab();
    return;
  }

  if (!(await tabIsOpen(tabId))) await clearRecordingTab();
}

/**
 * The failure that happened after the last click.
 *
 * Console and network activity is attached to the *next* step, because a step is
 * the thing it gets written onto. So anything the page produced after the user's
 * final interaction had nowhere to land, and stopping the recording threw it
 * away — which is exactly backwards, because the ordinary shape of a bug report
 * is *click the thing, watch it break, stop recording*. The README documented
 * this as a limitation users had to work around by clicking once more.
 *
 * Every tab is asked, not just the active one: a recording follows the user
 * across tabs, and the request that failed may have been issued by the one they
 * left. Tabs with no content script, or none listening, simply do not answer.
 *
 * The step is a `note`, and says what it is. It is not an interaction and must
 * not read as one — nobody clicked anything here.
 */
async function flushTrailing(recording: RecordingSettings): Promise<void> {
  // Refusable, and the setting says so: this is new behaviour, and a user who
  // does not want a synthesised step at the end of every recording turns it
  // off. Nothing is lost silently — the buffers are dropped with the page, and
  // the flow's stamp says the trailing step was not collected.
  if (!recording['recording.trailingStep']) return;

  const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) => {
    chrome.tabs.query({}, (found) => resolve(chrome.runtime.lastError ? [] : found));
  });

  const answers = await Promise.all(
    tabs.map(async (tab) =>
      tab.id === undefined ? null : (await sendToTab<Pending>(tab.id, { type: 'FLUSH_PENDING' })),
    ),
  );

  // The merge itself is pure and lives in `core/flow` — see `mergeTrailing`,
  // which is where the ordering rule is stated and tested.
  const trailing = mergeTrailing(answers.map((answer) => (answer?.ok ? answer.value : null)));
  if (!trailing) return;

  const stored = await getLocal('recordedSteps');
  if (!stored.ok) {
    await reportError(stored.error);
    return;
  }

  const recordedSteps = stored.value.recordedSteps ?? [];
  // Nothing to append to, and nothing this could mean: a recording with no steps
  // has no "after the last one".
  if (recordedSteps.length === 0 || recordedSteps.length >= recording['recording.maxSteps']) return;

  const last = recordedSteps[recordedSteps.length - 1];

  recordedSteps.push({
    type: 'note',
    url: trailing.url ?? last.url,
    timestamp: Date.now(),
    action: 'After the last step',
    value:
      'Console and network activity the page produced after the final interaction. ' +
      'No screenshot: nobody clicked anything here, and a picture of the page as it was ' +
      'left would read as evidence of a step that was never taken.',
    screenshot: null,
    stepNumber: recordedSteps.length + 1,
    ...(trailing.consoleLogs.length ? { consoleLogs: trailing.consoleLogs } : {}),
    ...(trailing.networkCalls.length ? { networkCalls: trailing.networkCalls } : {}),
  });

  const written = await setLocal({ recordedSteps });
  if (!written.ok) await reportError(written.error);
}

// ── React source resolution ──────────────────────────────────────────────────

/** Serialises passes, so two never write the component table at once. */
let resolveQueue: Promise<void> = Promise.resolve();
let resolveTimer: ReturnType<typeof setTimeout> | null = null;
/** Which `scheduleResolve` call owns the next timer — see the note there. */
let resolveScheduleToken = 0;

/**
 * Resolves whatever is pending, and writes back only what the resolver owns.
 *
 * `reactComponents` and `reactNeedles` are read and written here and nowhere
 * else that runs concurrently — `recordedSteps` is deliberately not touched,
 * because the capture queue rewrites it wholesale and two writers on one key
 * lose each other's updates.
 */
async function runResolve(requestedFinal: boolean): Promise<void> {
  const stored = await getLocal([
    'reactComponents',
    'reactNeedles',
    'reactScripts',
    'recordingActive',
  ]);
  if (!stored.ok) return;

  /*
   * A final pass writes off whatever is still pending as `skipped` — "the flow
   * finished before this could be looked up". While a recording is live that is
   * simply untrue, and the caller cannot always know: sending from the review
   * tab looks the same whether or not the tab behind it is still capturing. The
   * state lives here, so the rule is enforced here rather than at four callers.
   */
  const final = requestedFinal && !stored.value.recordingActive;

  const needles = stored.value.reactNeedles ?? {};
  const components = stored.value.reactComponents ?? {};
  if (Object.keys(needles).length === 0 && !final) return;

  // A failed read leaves resolution on, matching the setting's own default: a
  // storage hiccup should not quietly switch a feature off. `load()` guarantees
  // that — it resolves an unreadable area to the defaults.
  //
  // Live, not frozen, and the budget alongside it for the same reason: this
  // pass runs after the click and often after the recording has stopped, so
  // both "am I allowed to do this" and "for how long" are questions about now.
  const settings = await loadSettings();

  const result = await resolvePending({
    components,
    needles,
    scripts: stored.value.reactScripts ?? {},
    final,
    disabled: !settings.reactResolve,
    budgetMs: settings['react.maxResolveMsPerFlow'],
    // The five Tier 2 numbers, from the same live read as the budget. Built
    // here rather than inside the resolver so that module keeps knowing nothing
    // about the field table — it is driven directly by its own tests.
    limits: {
      concurrency: settings['react.resolveConcurrency'],
      cacheEntries: settings['react.bundleCacheEntries'],
      cacheBytes: settings['react.bundleCacheBytes'],
      resourceBytes: settings['react.maxResourceBytes'],
      mapBytes: settings['react.maxMapBytes'],
    },
  });

  if (!result.changed) return;

  const written = await setLocal({
    reactComponents: result.components,
    reactNeedles: result.needles,
  });
  if (!written.ok) await reportError(written.error);
}

function enqueueResolve(final: boolean): Promise<void> {
  resolveQueue = resolveQueue.then(() =>
    runResolve(final).catch((error: unknown) =>
      // A failed pass costs some components their path and nothing else; the
      // needles are still in storage and the next trigger retries them.
      console.warn('DevFlow: component resolution failed', error),
    ),
  );
  return resolveQueue;
}

/**
 * Throws away every React fact the live recording has collected.
 *
 * Both queues, in that order. The resolve queue owns `reactComponents` and
 * `reactNeedles`; the capture queue owns `recordedSteps`. Purging on either one
 * alone would leave the other free to write the data straight back — a resolve
 * pass that was already in flight finishing after the clear, or the click the
 * user made while reaching for the switch landing with its chain attached.
 *
 * The caches go too: they are keyed by component id, and a component whose
 * needle has just been deleted must not be answerable from memory.
 */
async function purgeReact(): Promise<void> {
  if (resolveTimer !== null) {
    clearTimeout(resolveTimer);
    resolveTimer = null;
  }

  const clear = async (): Promise<void> => {
    clearResolverCaches();

    const stored = await getLocal('recordedSteps');
    const steps = stored.ok ? (stored.value.recordedSteps ?? []) : [];
    // `renders` goes with the chain, not after it: every entry is keyed by a
    // component id, and an id whose table has just been deleted is a row that
    // answers nothing — the same reason `stripReactRef` exists at all.
    const stripped = steps.map((step) => {
      const next = stripReactRef(step);
      if (!next.renders) return next;
      const bare = { ...next };
      delete bare.renders;
      return bare;
    });

    const written = await setLocal({
      recordedSteps: stripped,
      reactComponents: {},
      stateStores: [],
      flowRenders: null,
      reactNeedles: {},
      reactScripts: {},
      reactMeta: null,
    });
    if (!written.ok) await reportError(written.error);
  };

  resolveQueue = resolveQueue.then(() => {
    captureQueue = captureQueue.then(() =>
      clear().catch((error: unknown) => console.warn('DevFlow: React purge failed', error)),
    );
    return captureQueue;
  });

  return resolveQueue;
}

/**
 * Resolution runs *during* recording, on idle, rather than only at the end.
 *
 * The page is still open, so its bundles are certain to be fetchable and warm
 * in the HTTP cache — after the tab closes, a private or cookie-gated bundle may
 * not be. It also means most components are already resolved by the time anyone
 * presses Stop.
 */
function scheduleResolve(): void {
  if (resolveTimer !== null) clearTimeout(resolveTimer);

  /*
   * The debounce is read per schedule, and that read is asynchronous.
   *
   * Live rather than frozen, like the resolution pass it schedules: this runs
   * after the click and often after the recording has stopped, so "how long
   * counts as quiet" is a question about now. It cannot be read into a
   * module-level value — the worker is killed and restarted at Chrome's
   * discretion, and the value taken at import would be the compiled-in default
   * for every recording after that.
   *
   * Which leaves an await between the debounce being restarted and the timer
   * existing, and two schedules can be inside it at once. The token is what
   * makes the last caller win: without it the earlier read would arm a second
   * timer that nothing clears, and a burst of clicks would resolve as many
   * times as it had settings reads.
   */
  const token = ++resolveScheduleToken;
  void loadSettings().then((settings) => {
    if (token !== resolveScheduleToken) return;
    resolveTimer = setTimeout(() => {
      resolveTimer = null;
      void enqueueResolve(false);
    }, settings['react.resolveDebounceMs']);
  });
}

// ── Opening a file in an editor ──────────────────────────────────────────────

/**
 * Launches an editor deep link on the user's behalf.
 *
 * The viewer cannot: an extension page is not allowed to navigate itself to a
 * custom scheme. The scheme is checked again here even though the viewer only
 * ever offers links that already passed — this is the side that actually opens
 * a tab, and a settings field that could produce `https://…` would otherwise be
 * a way to make the extension open any page it likes.
 */
async function openEditor(url: string): Promise<OpenEditorResponse> {
  if (!isEditorScheme(url)) return { ok: false, error: 'Not an editor link.' };

  // Live: opening a source link is something the user is doing now, and has
  // nothing to do with what any recording captured.
  const settings = await loadSettings();

  try {
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id !== undefined) closeWhenLaunched(tab.id, settings['ui.launcherTimeoutMs']);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Disposes of the blank launcher tab once it has done its job.
 *
 * Timing alone cannot decide this: while Chrome's "open this application?"
 * prompt is up, the tab looks exactly as it does when the launch has already
 * happened — so a fixed delay either dismisses the prompt before it can be
 * answered, or leaves blank tabs behind. Chrome losing focus means the editor
 * took over, which is the signal. The timeout only covers a launch that never
 * happened at all.
 */
function closeWhenLaunched(tabId: number, timeoutMs: number): void {
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    chrome.windows.onFocusChanged.removeListener(onFocusChanged);
    void chrome.tabs.remove(tabId).catch(() => {
      /* already closed by the user */
    });
  };

  const onFocusChanged = (windowId: number): void => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) close();
  };

  chrome.windows.onFocusChanged.addListener(onFocusChanged);
  const timer = setTimeout(close, timeoutMs);
}

// ── The DevTools panel, and the pick relay ───────────────────────────────────

/**
 * The name the DevTools page connects with, before `:<tabId>` is appended.
 *
 * Mirrored from `devtools/index.ts`, which explains why the tab id rides in the
 * name. The literal is repeated rather than shared because `src/shared/` was
 * frozen in Wave 0 and this constant did not exist then; `tests/devtools.test.ts`
 * asserts the two copies still agree, since a drift here fails silently — no
 * panel ever registers and every close leaks whatever the panel armed.
 */
const DEVTOOLS_PORT = 'devflow-devtools';

/**
 * Tabs a DevTools panel is currently inspecting.
 *
 * This is the whole of the worker's per-panel state, and it is emptied by the
 * port disconnect below. It exists so that a disconnect is attributable and
 * idempotent: only a tab this worker saw a panel open on gets its pick
 * cancelled, so a duplicate or late disconnect cannot reach across and cancel a
 * pick the popup armed afterwards.
 *
 * Rebuilt rather than persisted. The worker is killed at Chrome's discretion,
 * which takes the set and the ports with it — and the DevTools page reconnects
 * and re-announces itself, so the two come back together or not at all.
 */
const panelTabs = new Set<number>();

/**
 * Fetches script or source-map text for a surface that cannot fetch it itself.
 *
 * A DevTools panel is subject to CORS like any page; the worker holds
 * `<all_urls>` and is not. `WorkerProvider` does not come through here — it
 * already runs in the worker — so this exists for `DevtoolsProvider` alone.
 *
 * Goes through `chrome/fetch.ts` rather than calling `fetch` the way the
 * locator's worker did, which buys three things the locator's copy did not
 * have: the scheme check (a page chooses the URLs it loads, and `file:` or
 * `chrome-extension:` is not one this extension will read on its behalf), the
 * size ceiling, and failure as a `FlowError` like every other Chrome call here.
 */
async function fetchForPanel(url: string): Promise<FetchContentResponse> {
  /*
   * Live, and the same ceiling the recorder's resolver spends.
   *
   * `react.maxResourceBytes` was `MAX_RESOURCE_BYTES` in one repo and a setting
   * in the other, at the same value — §3.2 of the contracts is what stops it
   * being two numbers again. Read per call because the worker is restarted at
   * Chrome's discretion, and a value read at import would be the compiled-in
   * default for the rest of the profile's life.
   */
  const settings = await loadSettings();
  const read = await fetchText(url, settings['react.maxResourceBytes']);
  if (read.ok) return { ok: true, content: read.value };

  /*
   * The sentence, then the cause.
   *
   * `FlowError.message` is written for the person looking at the result — this
   * one ends up explaining why a component has no source file — and "HTTP 404"
   * on its own says nothing about what was being read or what it cost them.
   * `detail` is appended rather than substituted so the console still has the
   * raw reason.
   */
  const { message, detail } = read.error;
  return { ok: false, content: '', error: detail ? `${message} (${detail})` : message };
}

/**
 * Hands a UI surface's request to the tab's content script.
 *
 * The popup and the panel both send `START_PICK` and the rest with an explicit
 * `tabId`, because neither is a tab: `sender.tab` is undefined for everything
 * they send, so there is no "the tab this came from" to infer. The content
 * script is the far end (Package C) and pushes a control message to the agent.
 *
 * A tab that does not answer is not an error worth a `lastError` banner — it is
 * a tab that navigated to `chrome://`, or was open before the extension was
 * installed. The caller is told the request did not land and says so in its own
 * words; the console gets the code.
 */
async function relayToTab<T>(tabId: number, request: ContentRequest): Promise<Result<T>> {
  const answer = await sendToTab<T>(tabId, request);
  if (!answer.ok) {
    console.warn(`DevFlow: ${request.type} did not reach tab ${tabId} (${answer.error.code})`);
  }
  return answer;
}

/**
 * Cleans up after a panel that has gone away.
 *
 * The pick is the thing that outlives it. Picking is armed in the page, where
 * nothing can observe DevTools closing, so a panel closed mid-pick leaves the
 * agent's capture-phase listeners and its crosshair cursor on a page the user
 * now cannot click anything on. `PICK_TIMEOUT_MS` eventually releases it, but
 * two minutes of that is a bug report rather than a cleanup story.
 *
 * The agent itself is left exactly where it is. react-source-locator's worker
 * tore its agent out of the page here, because that agent existed only for the
 * panel and had been `eval`-ed in on demand. DevFlow's is a manifest content
 * script that is also the recorder — the tab still needs it, and there is
 * nothing to inject again if it were removed.
 *
 * Sent unconditionally for a tab that had a panel, rather than tracked
 * per-pick: cancelling a pick nobody armed is a no-op the agent already
 * handles, while missing one that was armed is the failure this exists for.
 */
function closePanel(tabId: number): void {
  if (!panelTabs.delete(tabId)) return;
  void relayToTab(tabId, { type: 'CANCEL_PICK' });
}

/*
 * The DevTools page holds this port open for its lifetime, so a disconnect
 * means DevTools was closed — or the tab went away, or the worker was killed.
 * It is the only signal there is: page context cannot observe any of them.
 *
 * The tab id rides in the port's name because a port from a DevTools page
 * carries no `sender.tab`, and correlating a disconnect with a separately-sent
 * `DEVTOOLS_OPENED` would be a race the moment two DevTools windows are open on
 * two tabs.
 */
chrome.runtime.onConnect.addListener((port) => {
  const [name, rawTabId] = port.name.split(':');
  if (name !== DEVTOOLS_PORT) return;

  const tabId = Number(rawTabId);
  if (!Number.isInteger(tabId)) return;

  panelTabs.add(tabId);
  port.onDisconnect.addListener(() => {
    // Read, or Chrome logs "Unchecked runtime.lastError" on every disconnect.
    void chrome.runtime.lastError;
    closePanel(tabId);
  });
});

// ── MCP auto-export ──────────────────────────────────────────────────────────

async function autoExportToMcp(steps: Step[]): Promise<void> {
  const settings = await loadSettings();
  if (!settings.mcpAutoSend) return;

  /*
   * The same stamp the Send dialog builds.
   *
   * This path exists precisely for the user who never presses Send, so it is
   * the path where an unexplained flow is *most* likely to be read: nobody was
   * in the loop when it was made. A flow that arrives here with no screenshots
   * and no stamp is the exact failure the stamp exists to prevent.
   */
  const stamp = { ...(await readRecordingStamp()), ...renderedOverrides(settings) };

  /*
   * The same four switches the Send dialog obeys, on the path where nobody is
   * there to check.
   *
   * This used to serialise `steps` raw — no `pruneSteps`, no `leanCalls`, no
   * component table pruning — so `export.sendImages`, `sendNetwork`, `sendLogs`
   * and `sendReact` meant nothing the moment auto-send was on. A user who had
   * deliberately switched network bodies off still shipped every un-redacted
   * request and response body, and every screenshot, on every recording. The
   * settings are the user's answer to "what may leave this browser"; a second
   * path that does not read them is not a second path, it is a hole.
   *
   * `sendFlow` is the shared implementation everywhere else, and cannot be used
   * here: it finishes by writing the prompt to `navigator.clipboard`, which a
   * service worker does not have, and it asks the worker to resolve components
   * over `chrome.runtime` — a message this context would be sending to itself.
   * The payload is the part worth sharing, and it is shared.
   */
  const include = sendDefaults(settings);
  const sending = pruneSteps(renumber(steps), include);
  const react = include.react ? await readCurrentReact(sending) : null;
  // Not behind an include switch. There is no `state` in `ExportOptions` and
  // adding one is `docs/CONTRACTS.md`'s to do; what is sent is bounded by
  // `recording.state`, which is the switch that decides whether it was ever
  // captured — and a `FlowState` with `read: false` is two dozen bytes.
  const state = await readCurrentState();
  // On the same terms, and gated on React for `pruneSteps`' reason: with the
  // component table gone, a render list names components nothing can resolve.
  const renders = include.react ? await readCurrentRenders() : null;

  const payload = JSON.stringify(
    buildPayload(
      `flow-${Date.now()}`,
      `Flow ${new Date().toLocaleString()}`,
      sending,
      Date.now(),
      react,
      include,
      stamp,
      state,
      renders,
    ),
  );

  /*
   * The same timeout the Send dialog uses, which this path did not have at all.
   *
   * Auto-send fires with nobody watching, at a `mcpServerUrl` that may be a
   * host that accepts the connection and never answers — and an unabandoned
   * `fetch` in a service worker holds the worker alive for as long as Chrome
   * lets it. Nothing reported a failure because nothing ever concluded there
   * had been one. Found while wiring `mcp.sendTimeoutMs`, which claimed to
   * govern "a send" and governed only one of the two.
   */
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), settings['mcp.sendTimeoutMs']);

  try {
    const res = await fetch(settings.mcpServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    await setLocal({ lastMcpFlowId: id });
  } catch (error) {
    await reportError(flowError('MCP_UNREACHABLE', error instanceof Error ? error.message : error));
  } finally {
    clearTimeout(timer);
  }
}

// ── The keyboard ─────────────────────────────────────────────────────────────

/**
 * Begin a recording without a popup to press.
 *
 * The same write the popup makes, for the same reasons — the settings snapshot
 * is read before it and batched with it so no capture can find a live recording
 * with no snapshot to describe it, and `lastMcpFlowId` is cleared so a Send from
 * the review tab cannot overwrite the previous recording on the MCP server.
 * `prepare` resolves the tab and injects the content script if the page predates
 * the extension, which is what makes the shortcut work on a tab that has been
 * open all morning.
 */
async function startRecording(): Promise<void> {
  const ready = await prepare();
  if (!ready.ok) {
    await reportError(ready.error);
    return;
  }

  // The previous recording's images are keyed independently of its steps, so
  // emptying the array does not free them.
  await sweepShots();

  const settings = await snapshotForRecording();

  const written = await setLocal({
    recordingActive: true,
    recordingPaused: false,
    recordedSteps: [],
    recordingStartedAt: Date.now(),
    recordingSettings: settings,
    lastError: null,
    lastMcpFlowId: '',
  });
  if (!written.ok) await reportError(written.error);
}

/**
 * The command, and the one thing it will not do.
 *
 * Start and Stop are the two most repeated gestures in the product and both were
 * mouse-only, which meant dismissing the popup before the page could be used —
 * the reason `beginRecording` closes its own window.
 *
 * A recording that has stopped and not been archived lives in `recordedSteps`
 * and nowhere else, and starting a new one deletes it. The popup asks before it
 * does that; a keystroke has nowhere to ask, so it does not start. It opens the
 * popup instead, where the question and both answers already are — and where
 * Chrome is too old to let an extension do that, it does nothing at all rather
 * than throwing away work. The badge and its tooltip are already saying there
 * are steps waiting, which is the state the user has to resolve either way.
 */
async function toggleRecording(): Promise<void> {
  const stored = await getLocal(['recordingActive', 'recordedSteps']);
  if (!stored.ok) {
    await reportError(stored.error);
    return;
  }

  if (stored.value.recordingActive) {
    await finishRecording();
    return;
  }

  if ((stored.value.recordedSteps ?? []).length > 0) {
    // Ask, exactly as the button does. Never start over the top of a recording
    // nobody saved — a keystroke that silently deleted one would be the single
    // path around the confirmation the popup grew for that very reason.
    await openPopup();
    return;
  }

  await startRecording();
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-recording') return;
  void toggleRecording();
});

// ── Wiring ───────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // Three keys make up what the toolbar says, and only one of them is written
  // exclusively by this worker. Pause is the popup's, and discarding and
  // archiving are the popup's and the viewer's.
  if (
    'recordingActive' in changes ||
    'recordingPaused' in changes ||
    'recordedSteps' in changes
  ) {
    void refreshAction();
  }

  if (!('recordingActive' in changes)) return;
  if (changes.recordingActive.newValue === true) return;

  /*
   * Whatever ended this recording, storage must stop naming a tab as the one
   * being recorded.
   *
   * The three paths the worker owns clear it in their own write, which is
   * better — there is no instant between the two facts. This is for the paths it
   * does not own: the popup writes `recordingActive: false` directly when Stop
   * cannot reach the worker, and again when a recording is discarded. Neither
   * knows about this key, and a fourth path added later would not either. A
   * reconciler on the one change every ending has in common is the only version
   * of this promise that a caller cannot forget to keep.
   */
  void clearRecordingTab();

  /*
   * An import made during a recording was parked rather than applied, and
   * this is the moment it was parked for.
   *
   * Before the clearing check, not after: a cleared recording is still a
   * recording that has ended, and the settings are no longer frozen either way.
   * Making the user press Stop *and* not press Clear to get the file they
   * already confirmed would be a promise kept only on one of two paths.
   */
  void applyPending().then(async (applied) => {
    if (!applied.ok) {
      void reportError(applied.error);
      return;
    }

    /*
     * A parked file can carry the three machine-wide settings, and storing them
     * is not delivering them — the port and the retention caps live in a Node
     * process this extension can only reach over HTTP. The Settings screen does
     * this itself when a row changes; an import applied *here*, minutes later
     * and with nobody on that screen, has no other path.
     *
     * Only when the file actually named one. A push for an import that touched
     * none of the three would overwrite a hand-edited `~/.devflow/config.json`
     * for nothing.
     */
    if (applied.value === null) return;
    if (!Object.keys(applied.value.overrides).some(isMachineKey)) return;

    const delivery = await deliverMachineSettings();
    // Not fatal, and not silent: the server is usually not running, and the
    // Settings screen offers the retry beside the row.
    if (!delivery.push.ok) void reportError(delivery.push.error);
  });

  // Clearing also sets recordingActive false, in the same batch as an empty
  // recordedSteps — that is a clear, not a finished recording.
  const isClearing =
    'recordedSteps' in changes &&
    Array.isArray(changes.recordedSteps.newValue) &&
    changes.recordedSteps.newValue.length === 0;
  if (isClearing) return;

  // The last chance while the page is still open and its bundles still cached.
  // Not `final`: the user may sit in the review tab for a minute and press Send,
  // which sweeps again, and calling anything skipped this early would be wrong.
  if (resolveTimer !== null) {
    clearTimeout(resolveTimer);
    resolveTimer = null;
  }
  void enqueueResolve(false);

  void getLocal('recordedSteps').then((stored) => {
    const steps = stored.ok ? ((stored.value.recordedSteps ?? [])) : [];
    if (steps.length) void autoExportToMcp(steps);
  });
});

/**
 * A tab that goes away cannot claim its pre-capture, and has no page left to
 * clean up.
 *
 * The panel record is dropped directly rather than through `closePanel`, which
 * would relay a `CANCEL_PICK` to a page that is not there to receive it. The
 * two events race — Chrome does not order a tab's removal against its DevTools
 * port disconnecting — and whichever arrives first makes the other a no-op,
 * because `closePanel` only acts on a tab still in the set.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  precaptures.delete(tabId);
  panelTabs.delete(tabId);
  /*
   * And it is no longer somewhere a pick can be armed.
   *
   * The recording itself continues — it follows the user across tabs, and
   * closing one of them does not end it — so this is not `finishRecording`. It
   * is the one way `recordingTabId` can go stale while everything else about
   * the recording stays true, and the flow review would otherwise offer a pick
   * that could only fail. The next step captured in another tab names that one.
   */
  void forgetRecordingTabIfClosed(tabId);
});

/** Clears `recordingTabId` only when the tab that went away is the one it names. */
async function forgetRecordingTabIfClosed(tabId: number): Promise<void> {
  const stored = await getLocal('recordingTabId');
  if (!stored.ok || stored.value.recordingTabId !== tabId) return;

  const written = await setLocal({ recordingTabId: null });
  if (!written.ok) await reportError(written.error);
}

chrome.runtime.onMessage.addListener((message: WorkerRequest, sender, sendResponse) => {
  if (!message?.type) return;

  switch (message.type) {
    case 'PRECAPTURE': {
      const tabId = sender.tab?.id;
      // Same reason as the capture in `captureAndSave`: the API photographs the
      // window's visible tab, so a frame requested by any other tab is a
      // picture of the wrong page waiting to be claimed as evidence.
      if (tabId == null || sender.tab?.active === false) {
        sendResponse({ ok: false });
        return true;
      }
      // The recording's frozen quality, and its screenshot switch: a
      // pre-capture is a screenshot taken early, so it obeys the same answer
      // the step's own capture would have. Spending a rate-limited capture on a
      // recording that will not use it is the one cost switching screenshots
      // off is for.
      void loadRecordingSettings().then((recording) => {
        if (!recording['screenshots.capture']) {
          sendResponse({ ok: false });
          return;
        }
        void captureVisibleTab(
          sender.tab?.windowId,
          recording['screenshots.quality'],
          recording['screenshots.minIntervalMs'],
        ).then(
          (captured) => {
            if (captured.ok) precaptures.set(tabId, { dataUrl: captured.value, at: Date.now() });
            // Respond either way: the page is holding its recording indicator
            // hidden until this resolves.
            sendResponse({ ok: captured.ok });
          },
        );
      });
      return true;
    }

    case 'STEP_DOM_DELTA': {
      // Behind the capture queue: it owns `recordedSteps`, and the step this
      // belongs to may still be in it.
      captureQueue = captureQueue.then(() =>
        attachDomDelta(message.key, message.before, message.after).catch((error: unknown) =>
          console.warn('DevFlow: DOM delta not attached', error),
        ),
      );
      sendResponse({ ok: true });
      return true;
    }

    case 'STEP_DOM_CHANGES': {
      // Behind the capture queue, for `STEP_DOM_DELTA`'s reason.
      captureQueue = captureQueue.then(() =>
        attachDomChanges(message.key, message.changes, message.capped, message.more).catch(
          (error: unknown) => console.warn('DevFlow: DOM changes not attached', error),
        ),
      );
      sendResponse({ ok: true });
      return true;
    }

    case 'STEP_STATE_DELTA': {
      // Behind the capture queue, for `STEP_DOM_DELTA`'s reason.
      captureQueue = captureQueue.then(() =>
        attachStateDelta(message.key, message.deltas, message.stores).catch((error: unknown) =>
          console.warn('DevFlow: state delta not attached', error),
        ),
      );
      sendResponse({ ok: true });
      return true;
    }

    case 'STEP_RENDERS': {
      // Behind the capture queue, for `STEP_DOM_DELTA`'s reason.
      captureQueue = captureQueue.then(() =>
        attachRenders(message.key, message.renders, message.capped, message.note).catch(
          (error: unknown) => console.warn('DevFlow: renders not attached', error),
        ),
      );
      sendResponse({ ok: true });
      return true;
    }

    case 'CAPTURE_AND_SAVE_STEP': {
      const { step, elementBox, dpr, components, componentsPageUrl, scroll } = message;
      // Enqueue so captures run one at a time. A rejected step is swallowed so
      // one failure cannot break the chain for later steps.
      captureQueue = captureQueue.then(() =>
        captureAndSave(step, elementBox, dpr, sender, components, componentsPageUrl, scroll).catch((error: unknown) =>
          console.error('DevFlow: captureAndSave rejected', error),
        ),
      );
      // Resolve immediately — the caller only needs to know the request landed,
      // and waiting for the queue would hold the page's indicator hidden for as
      // long as the backlog takes.
      sendResponse({ ok: true });
      return true;
    }

    case 'REACT_META': {
      // Written once per recording, and never merged with a later contradiction:
      // a flow that visits a React page and then a plain one was still recorded
      // against React, and saying otherwise would lose that.
      void getLocal('reactMeta').then((stored) => {
        if (stored.ok && stored.value.reactMeta?.detected) {
          sendResponse({ ok: true });
          return;
        }
        void setLocal({ reactMeta: message.meta }).then((written) =>
          sendResponse({ ok: written.ok }),
        );
      });
      return true;
    }

    case 'REACT_SCRIPTS': {
      // `sender.url` is Chrome's word for where the message came from; the
      // page's own claim is only the fallback for a frame that has none.
      const pageUrl = sender.url ?? message.pageUrl;
      // The inventory is a worker-side resource rather than part of a
      // recording, so the limit is read live — the same answer `enqueueResolve`
      // gives for the budgets it spends.
      void Promise.all([getLocal('reactScripts'), loadSettings()]).then(([stored, settings]) => {
        const merged = mergeScripts(
          stored.ok ? (stored.value.reactScripts ?? {}) : {},
          pageUrl,
          message.urls,
          settings['react.maxScriptsPerOrigin'],
        );
        if (!merged.changed) {
          sendResponse({ ok: true });
          return;
        }
        void setLocal({ reactScripts: merged.scripts }).then((written) => {
          // A chunk that has only just loaded may be the one a component nobody
          // could find lives in, so this is worth a pass of its own.
          if (written.ok) scheduleResolve();
          sendResponse({ ok: written.ok });
        });
      });
      return true;
    }

    case 'REACT_PURGE': {
      void purgeReact().then(() => sendResponse({ ok: true }));
      return true;
    }

    case 'RESOLVE_COMPONENTS': {
      if (resolveTimer !== null) {
        clearTimeout(resolveTimer);
        resolveTimer = null;
      }
      void enqueueResolve(message.final).then(() => sendResponse({ ok: true }));
      return true;
    }

    case 'ANNOTATE_SCREENSHOT': {
      const { screenshot, box, dpr } = message;
      /*
       * The live setting, not the recording's frozen one.
       *
       * This is the viewer re-drawing a highlight on a picture the user is
       * editing now, which is a thing being done now — the freeze is about what
       * a recording captured, and this is not capture. Loaded per message for
       * the same reason everything else here is.
       */
      loadSettings()
        .then((settings) =>
          annotateScreenshot(
            screenshot,
            box,
            dpr || 1,
            settings['screenshots.quality'],
            settings['annotation.stroke'],
          ),
        )
        .then((annotated) => sendResponse({ screenshot: annotated }))
        .catch(() => sendResponse({ screenshot: null }));
      return true;
    }

    case 'GET_STEPS': {
      void getLocal('recordedSteps').then((stored) => {
        sendResponse({ steps: stored.ok ? ((stored.value.recordedSteps ?? [])) : [] });
      });
      return true;
    }

    case 'FINISH_RECORDING': {
      void finishRecording()
        .catch((error: unknown) => console.error('DevFlow: finishRecording rejected', error))
        .then(() => sendResponse({ ok: true }));
      return true;
    }

    case 'CLEAR_STEPS': {
      clearResolverCaches();
      /*
       * Awaited, not fired alongside. On a Chrome that cannot list storage keys
       * `sweep` falls back to reading `recordedSteps` for the images to delete,
       * and the write below is what empties it — racing the two means the sweep
       * reads an empty array about half the time and leaves every screenshot of
       * the discarded recording behind, under keys nothing will name again.
       */
      void sweepShots()
        .then(() =>
          setLocal({
            recordedSteps: [],
            recordingActive: false,
            recordingPaused: false,
            recordingTabId: null,
            reactComponents: {},
            stateStores: [],
            flowRenders: null,
            reactNeedles: {},
            reactScripts: {},
            reactMeta: null,
          }),
        )
        .then((written) => {
          sendResponse({ ok: written.ok });
        });
      return true;
    }

    case 'OPEN_EDITOR': {
      void openEditor(message.url).then(sendResponse);
      return true;
    }

    case 'FETCH_CONTENT': {
      void fetchForPanel(message.url).then(sendResponse);
      return true;
    }

    case 'DEVTOOLS_OPENED': {
      /*
       * The panel telling the worker which tab it is looking at.
       *
       * Also sent on every reconnect, which is what repopulates this after the
       * worker has been killed and restarted underneath an open DevTools
       * window — see `connect()` in `devtools/index.ts`. Adding a tab that is
       * already there is the ordinary case, not a duplicate to guard against:
       * the set is what makes the close attributable, not a count of panels.
       */
      panelTabs.add(message.tabId);
      sendResponse({ ok: true });
      return true;
    }

    case 'START_PICK': {
      /*
       * The pick itself comes back through here, not an acknowledgement.
       *
       * The content script holds its `sendResponse` until the agent reports,
       * so this promise settles when the user clicks — or presses Escape, or
       * lets `PICK_TIMEOUT_MS` run out. The worker is a relay for the whole
       * round trip and not just the outbound half, which is what lets the panel
       * hold no scripting relationship with the page at all: one message out,
       * one gesture back, however long it takes.
       *
       * A tab that never answered is a `PickFailure`. To the surface that asked,
       * a page it cannot reach and a user who changed their mind are the same
       * outcome — nothing was picked — and the difference is a sentence.
       */
      void relayToTab<PickResult>(message.tabId, { type: 'START_PICK' }).then((answer) => {
        /*
         * Answer the panel first, then tell the graph.
         *
         * The order is the whole of it: `sendResponse` is what un-freezes the
         * surface the user is looking at, and `ingestComponentPick` reaches a
         * socket. Even awaited-and-discarded, a send that ran first would put a
         * loopback timeout between somebody's click and the card it produces.
         *
         * The picked component is the *innermost* entry of the ancestor chain —
         * the same one `ui/locator/main.ts` locates the moment a pick lands.
         * `ancestry[0]` is the root of the app, and recording it here would
         * observe `App` every time anybody picked anything.
         */
        if (answer.ok) sendResponse(answer.value);
        else sendResponse({ kind: 'error', error: 'That page cannot be picked on. Reload it and try again.' });

        if (answer.ok && answer.value.kind === 'picked') {
          const picked = answer.value.ancestry[answer.value.ancestry.length - 1];
          if (picked) void ingestComponentPick(picked);
        }
      });
      return true;
    }

    case 'CANCEL_PICK': {
      void relayToTab(message.tabId, { type: 'CANCEL_PICK' }).then((answer) =>
        sendResponse({ ok: answer.ok }),
      );
      return true;
    }

    case 'READ_COMPONENT_SOURCE': {
      const { tabId, group, index } = message;
      // `null` is an ordinary answer, not a failure: a native function and an
      // unsettled lazy both have no source text to read, and so does a tab that
      // has navigated since the pick. The caller says why there is no source.
      void relayToTab<ComponentSourceResponse>(tabId, {
        type: 'READ_COMPONENT_SOURCE',
        group,
        index,
      }).then((answer) => sendResponse(answer.ok ? (answer.value ?? { source: null }) : { source: null }));
      return true;
    }

    case 'HIGHLIGHT_COMPONENT': {
      const { tabId, group, index } = message;
      void relayToTab(tabId, { type: 'HIGHLIGHT_COMPONENT', group, index }).then((answer) =>
        sendResponse({ ok: answer.ok }),
      );
      return true;
    }

    default:
      return;
  }
});

/**
 * Carry a react-source-locator user's settings across the merge.
 *
 * The one thing an upgrade can do that a fresh install cannot: silently lose
 * work. react-source-locator kept its settings as a single JSON blob under one
 * key; DevFlow keeps flat dotted keys, sparse overrides only. Without this, an
 * existing user opens Settings after the update and finds their editor and
 * project root blank — not reset by anything they did, and with no way to tell
 * that the old values are still sitting in storage unread.
 *
 * Here as well as at the two Settings entry points because this is the only one
 * that runs *before* the user goes looking. `onInstalled` fires on update and on
 * enable, and the function is idempotent — it never overwrites a key `sync`
 * already holds, since the blob is by definition the older document — so running
 * it from three places costs three no-ops and buys the migration happening
 * before it is needed rather than when someone notices.
 *
 * A failure here is not worth interrupting an install for: the Settings page
 * will try again the moment it is opened.
 */
/**
 * A new browser session reissues every tab id, so any stored one is a coincidence.
 *
 * Unconditional, and not gated on the tab existing: the danger is not an id
 * naming nothing, it is an id naming *something* — Chrome hands the restored
 * tabs fresh ids from the same small range, so a stored `42` will very often
 * resolve to a real tab that has nothing to do with the recording. Cleared, the
 * review simply does not offer the pick until the next captured step says where
 * the recording actually is.
 */
chrome.runtime.onStartup.addListener(() => {
  void clearRecordingTab();
});

/*
 * And on every worker wake, including the ones nothing announces.
 *
 * `onStartup` covers the browser restarting; this covers Chrome killing the
 * service worker and reviving it, which happens constantly and fires no event
 * of its own. Here the id is usually still correct, so this only checks that
 * the tab is open and that something is still recording.
 */
void reconcileRecordingTab();

/*
 * And the toolbar with it. A badge does not survive a browser restart, so
 * without this a recording that was live when Chrome closed comes back with the
 * red and the count gone — the one state that must never be quiet.
 */
void refreshAction();

/**
 * The popup's locate answer, from the release that had one.
 *
 * `lastLocate` was written by the detached locate window and read by the popup
 * that outlived it. Both are gone — locating is the panel's, and the panel keeps
 * its own history — so on an upgrade the key is a record nothing will ever read
 * again, quietly counted into the storage figure the footer shows. Removing a
 * key that is already absent is a no-op, so this costs a fresh install nothing.
 */
function dropRetiredKeys(): void {
  void chrome.storage.local.remove('lastLocate').catch(() => {
    /* A key that will not delete is a stale figure, not a broken install. */
  });
}

chrome.runtime.onInstalled.addListener(() => {
  dropRetiredKeys();

  void migrateLegacySettings().then(
    (migrated) => {
      if (migrated.length > 0) {
        console.warn(`DevFlow: carried ${migrated.length} setting(s) across from the previous extension.`);
      }
    },
    () => {
      /* Retried on the next Settings open. */
    },
  );
});
