/**
 * MV3 service worker: screenshot capture, step persistence, badge, MCP export.
 *
 * Every Chrome call goes through `src/chrome/`, so failures arrive as values.
 * The worker's job is to decide what a failure means for the recording — most
 * of the time "save the step without an image and tell the user why".
 */

import { annotateScreenshot } from './annotator.js';
import { getLocal, setLocal } from '../chrome/storage.js';
import { load as loadSettings } from '../features/settings/index.js';
import {
  loadRecordingSettings,
  readRecordingStamp,
  renderedOverrides,
} from '../features/settings/recording.js';
import { applyPending } from '../features/settings/pending.js';
import { isMachineKey } from '../features/settings/fields.js';
import { deliverMachineSettings } from '../features/mcp/machine.js';
import type { RecordingSettings } from '../features/settings/fields.js';
import { shotPatch, sweep as sweepShots, withoutImages } from '../features/flows/shots.js';
import { captureVisibleTab, sendToTab } from '../chrome/tabs.js';
import type { OpenEditorResponse, WorkerRequest } from '../shared/messages.js';
import { isEditorScheme } from '../core/react/editor.js';
import {
  BADGE_COLOR,
} from '../shared/constants.js';
import { flowError, type FlowError } from '../shared/errors.js';
import type { BoundingBox, DraftStep, Step } from '../shared/types.js';
import type { CapturedComponent } from '../shared/messages.js';
import { stripReactRef } from '../core/react/attribution.js';
import { mergeTrailing, stepKey, type Pending } from '../core/flow/index.js';
import { mergeComponents } from '../core/react/table.js';
import { mergeScripts } from '../features/react/inventory.js';
import { clearResolverCaches, resolvePending } from '../features/react/resolver.js';

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

function updateBadge(count: number): void {
  void chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}

/**
 * Record a failure where the UI can find it. The popup and the viewer both read
 * `lastError`, so a silent capture or storage failure becomes something the user
 * can actually see.
 */
async function reportError(error: FlowError): Promise<void> {
  console.warn(`FlowSnap: ${error.code} — ${error.detail ?? error.message}`);
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
      value: `Recording stopped at ${maxSteps} steps, FlowSnap's safety limit. Every step up to here was saved.`,
      screenshot: null,
      stepNumber: recordedSteps.length + 1,
    });
    const written = await setLocal({ recordingActive: false, recordedSteps });
    if (!written.ok) await reportError(written.error);
    updateBadge(recordedSteps.length);
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
    omitted = 'Screenshots are switched off in FlowSnap settings for this recording.';
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
    ...(shotPatch(captured, screenshot, screenshotOriginal) ?? {}),
    // Only when something actually changed: a flow that clicks one button forty
    // times would otherwise rewrite an identical table forty times.
    ...(merged?.changed ? { reactComponents: merged.table, reactNeedles: merged.needles } : {}),
  });
  if (!written.ok) {
    await reportError(written.error);
    return;
  }

  updateBadge(recordedSteps.length);

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
  });
  if (!written.ok) await reportError(written.error);
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
  else updateBadge(recordedSteps.length);
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
      console.warn('FlowSnap: component resolution failed', error),
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
    const stripped = steps.map(stripReactRef);

    const written = await setLocal({
      recordedSteps: stripped,
      reactComponents: {},
      reactNeedles: {},
      reactScripts: {},
      reactMeta: null,
    });
    if (!written.ok) await reportError(written.error);
  };

  resolveQueue = resolveQueue.then(() => {
    captureQueue = captureQueue.then(() =>
      clear().catch((error: unknown) => console.warn('FlowSnap: React purge failed', error)),
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

  const payload = JSON.stringify({
    id: `flow-${Date.now()}`,
    name: `Flow ${new Date().toLocaleString()}`,
    timestamp: Date.now(),
    startUrl: steps[0]?.url,
    ...(Object.keys(stamp).length ? { settings: stamp } : {}),
    steps,
  });

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

// ── Wiring ───────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('recordingActive' in changes)) return;

  if (changes.recordingActive.newValue === true) {
    void chrome.action.setBadgeText({ text: '0' });
    void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    return;
  }

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
     * none of the three would overwrite a hand-edited `~/.flowsnap/config.json`
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

/** A tab that goes away cannot claim its pre-capture. */
chrome.tabs.onRemoved.addListener((tabId) => precaptures.delete(tabId));

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
          console.warn('FlowSnap: DOM delta not attached', error),
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
          console.error('FlowSnap: captureAndSave rejected', error),
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
        .catch((error: unknown) => console.error('FlowSnap: finishRecording rejected', error))
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
            reactComponents: {},
            reactNeedles: {},
            reactScripts: {},
            reactMeta: null,
          }),
        )
        .then((written) => {
          updateBadge(0);
          sendResponse({ ok: written.ok });
        });
      return true;
    }

    case 'OPEN_EDITOR': {
      void openEditor(message.url).then(sendResponse);
      return true;
    }

    default:
      return;
  }
});
