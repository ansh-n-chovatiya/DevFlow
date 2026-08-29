/**
 * Isolated-world content script: watches the page and turns interactions into
 * steps.
 *
 * Shares the DOM with the page but not its JS context, which is why network and
 * console data arrives from `injected/agent.ts` by `postMessage` rather than
 * being read directly.
 */

import {
  accessibleName,
  containerText,
  describeTarget,
  getElementLabel,
  getElementText,
  mayNavigate,
  nearestContainer,
} from '../core/describe/index.js';
import { redactUrl } from '../core/redact/index.js';
import { generateSelector, generateXPath } from '../core/selector/index.js';
import {
  AGENT_MESSAGE_SOURCE,
  CONTROL_MESSAGE_SOURCE,
  INDICATOR_ID,
  REACT_BUFFER_SIZE,
  REACT_BUFFER_TTL_MS,
  REACT_CHAIN_TIMEOUT_MS,
  REACT_SETTING_DEFAULTS,
} from '../shared/constants.js';
import { createChainBuffer } from '../core/react/chains.js';
import { load, subscribe } from '../features/settings/index.js';
import {
  RECORDING_DEFAULTS,
  loadRecordingSettings,
} from '../features/settings/recording.js';
import type { RecordingSettings } from '../features/settings/fields.js';
import { toAgentConfig } from '../features/settings/agent.js';
import { stepKey } from '../core/flow/index.js';
import {
  sendToWorker,
  type AgentMessage,
  type CapturedComponent,
  type ContentRequest,
} from '../shared/messages.js';
import type { BoundingBox, ConsoleEntry, DraftStep, NetworkCall } from '../shared/types.js';

let isRecording = false;
let isPaused = false;

/** Buffers filled by the MAIN-world agent, drained onto the next step. */
let pendingLogs: ConsoleEntry[] = [];
let pendingNetworkCalls: NetworkCall[] = [];

function clearBuffers(): void {
  pendingLogs = [];
  pendingNetworkCalls = [];
  reactChains.clear();
}

// ── React component chains ───────────────────────────────────────────────────

/**
 * See `core/react/chains.ts` for why chains are keyed rather than buffered.
 *
 * Built at the compiled-in defaults and reconfigured from the frozen settings
 * when a recording starts — `refreshFrozen` below. It has to exist before the
 * snapshot has been read, because the agent can deliver a chain for a click
 * that happened in the same tick as the page loaded.
 */
const reactChains = createChainBuffer<{ chain: CapturedComponent[]; truncated: boolean }>({
  size: REACT_BUFFER_SIZE,
  ttlMs: REACT_BUFFER_TTL_MS,
  timeoutMs: REACT_CHAIN_TIMEOUT_MS,
});

/**
 * The settings this recording is frozen at, assumed to be the defaults until
 * storage answers.
 *
 * The read is asynchronous and a page can be interacted with before it lands, so
 * this starts where the agent starts — at the compiled-in defaults — rather than
 * at nothing. Kept in a `let` and re-read when a recording *starts*; nothing
 * copies a field out of it into a module-level constant.
 *
 * The values here do not move while a recording runs. Changing the typing
 * debounce halfway through would leave a flow whose early steps were split one
 * way and whose later ones another, with nothing recording that. The Settings
 * screen says as much while a recording is live, and the flow carries the stamp
 * this object was resolved from.
 */
let frozen: RecordingSettings = RECORDING_DEFAULTS;

/**
 * The master capture setting. Assumed on until the read below says otherwise:
 * a recording that starts in the same tick as the page loads should attribute
 * its first click, and the setting is on for all but the user who turned it off.
 */
let captureReact = REACT_SETTING_DEFAULTS.reactCapture;

/**
 * Tell the agent whether to watch for interactions, and what to capture.
 *
 * The config rides on every control message rather than on a message of its
 * own: the agent has no storage to read from, so the only guarantee worth having
 * is that it cannot be watching without also having been told the current
 * settings. One message makes that true by construction.
 */
function postControl(recording: boolean): void {
  window.postMessage(
    {
      __flowsnap_control__: CONTROL_MESSAGE_SOURCE,
      recording,
      // Built from the *frozen* settings, so the MAIN world cannot be told a
      // body cap the recording it is capturing for was not started under. It is
      // the one path a setting has into the page's realm, and the one that
      // would otherwise make the freeze a half-truth: the worker's half frozen,
      // the agent's half live.
      config: toAgentConfig(frozen),
    },
    '*',
  );
}

/** What the agent should be doing right now: recording, live, and switched on. */
function syncAgent(): void {
  postControl(isRecording && !isPaused && captureReact);
}

// ── Agent bridge ─────────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent<AgentMessage>) => {
  // Only this window's own agent may contribute. Without this check any page
  // script or cross-origin iframe could post the same envelope and inject
  // fabricated network calls and log lines into the recording — which then flow
  // into an AI's context as if they had been observed.
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!isRecording || isPaused) return;

  const data = event.data;
  if (!data || data.__flowsnap_source__ !== AGENT_MESSAGE_SOURCE) return;

  if (data.kind === 'log') {
    pendingLogs.push({
      level: data.level as ConsoleEntry['level'],
      args: data.args,
      timestamp: data.timestamp,
    });
  } else if (data.kind === 'react') {
    reactChains.deliver({
      eventTime: data.eventTime,
      value: { chain: data.chain, truncated: data.truncated },
      at: Date.now(),
    });
  } else if (data.kind === 'scripts') {
    // Straight through to the worker. The content script keeps no state for
    // this — the agent already sends each URL once, and the worker is the only
    // thing that has to remember them across a page it may outlive.
    void sendToWorker({ type: 'REACT_SCRIPTS', urls: data.urls, pageUrl: location.href });
  } else if (data.kind === 'react-meta') {
    void sendToWorker({
      type: 'REACT_META',
      meta: { detected: data.detected, version: data.version, build: data.build },
    });
  } else if (data.kind === 'network') {
    pendingNetworkCalls.push({
      method: data.method,
      url: data.url,
      requestHeaders: data.requestHeaders,
      requestBody: data.requestBody,
      status: data.status,
      responseHeaders: data.responseHeaders,
      responseBody: data.responseBody,
      durationMs: data.durationMs,
      timestamp: data.timestamp,
      // Built field by field, so anything not named here is dropped — which is
      // what happened to the truncation flags until they were listed.
      ...(data.requestBodyTruncated
        ? { requestBodyTruncated: true, requestBodyBytes: data.requestBodyBytes }
        : {}),
      ...(data.responseBodyTruncated
        ? { responseBodyTruncated: true, responseBodyBytes: data.responseBodyBytes }
        : {}),
    });
  }
});

// ── Control messages ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse) => {
  if (!message?.type) return;

  switch (message.type) {
    // Answering this is how the extension knows a tab can record at all.
    case 'PING':
      sendResponse({ ok: true });
      return true;

    case 'START_RECORDING':
      void applyState(true, false);
      break;

    /*
     * Everything the page produced that no step has claimed, handed over and
     * forgotten.
     *
     * `splice(0)` rather than a copy, and answered even when both are empty, so
     * the worker can tell "nothing happened" from "this tab never replied" —
     * a tab that has been closed or navigated returns no answer at all, and the
     * two must not look the same.
     */
    case 'FLUSH_PENDING':
      sendResponse({
        consoleLogs: pendingLogs.splice(0),
        networkCalls: pendingNetworkCalls.splice(0),
        url: redactUrl(window.location.href),
        title: document.title,
      });
      break;

    case 'STOP_RECORDING':
      void applyState(false, false);
      break;

    case 'PAUSE_RECORDING':
      void applyState(true, true);
      break;

    case 'RESUME_RECORDING':
      void applyState(true, false);
      break;

    case 'CLEAR_STEPS':
      clearBuffers();
      break;

    case 'GET_SCROLL':
      // Answered whether or not this tab is recording: the worker only asks the
      // tab it is about to photograph, and refusing would cost the correction.
      sendResponse({ x: window.scrollX, y: window.scrollY });
      return true;
  }

  return;
});

async function applyState(recording: boolean, paused: boolean): Promise<void> {
  isRecording = recording;
  isPaused = paused;
  if (!recording || paused) clearBuffers();

  /*
   * A recording starting is the moment this page adopts its frozen settings.
   *
   * Every tab in the browser runs this script, and a tab the user switches to
   * mid-recording joins one that is already running — so the snapshot is read
   * here rather than at injection, and the whole recording, across every tab it
   * touches, is capturing under one answer.
   *
   * Awaited before `syncAgent`, so the push that follows carries the new
   * recording's config rather than the previous one's.
   */
  if (recording) await refreshFrozen();

  // Paused counts as not watching: the agent should not walk fibers for
  // interactions that will never become steps.
  syncAgent();
  renderIndicator();
}

/**
 * Follow the recording state wherever it changes.
 *
 * A runtime message only reaches the tab the popup was opened over, so a tab the
 * user switched to — or one that was already open when recording started — never
 * learned it was supposed to be recording, and captured nothing at all with no
 * indicator and no error. Storage is shared by every tab, so watching it is what
 * makes a recording follow the user across tabs.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('recordingActive' in changes) && !('recordingPaused' in changes)) return;

  void chrome.storage.local.get(['recordingActive', 'recordingPaused']).then(async (state) => {
    const active = Boolean(state.recordingActive);
    const paused = Boolean(state.recordingPaused);
    const wasRecording = isRecording && !isPaused;
    // Awaited: the navigation step below is the recording's first, and it must
    // be captured under the settings the recording was started with.
    await applyState(active, paused);

    // A finished recording releases the tab to log itself again in the next one.
    if (!active) loggedNavigation = false;

    // Entering a live recording in a tab that was idle: log the page, so the
    // flow shows where the user went rather than jumping between contexts. Only
    // the tab on screen — this listener runs in every open tab at once, and the
    // rest of them are not somewhere the user just went. They log on arrival.
    if (active && !paused && !wasRecording && isOnScreen() && !loggedNavigation) {
      captureNavigationStep();
    }
  });
});

// ── The capture setting ──────────────────────────────────────────────────────

function applyCaptureSetting(enabled: boolean, initial = false): void {
  if (enabled === captureReact) return;
  captureReact = enabled;
  // Chains already collected for a step that has not claimed them are dropped:
  // turning capture off should stop attribution now, not after the buffer
  // drains into the next two steps.
  if (!enabled) reactChains.clear();
  syncAgent();

  // And what the recording has already stored goes with them. Stopping new
  // attribution alone would leave a flow that is half attributed, which is the
  // one outcome nobody asked for: the switch says "do not record this", not
  // "record it up to here". Skipped on the initial read — that is not somebody
  // switching it off, it is the setting already having been off, and a page
  // load must not clear a recording running in another tab.
  if (!enabled && !initial) void sendToWorker({ type: 'REACT_PURGE' });
}

/**
 * Re-read the recording's frozen settings and push them to the agent.
 *
 * Called when a recording *starts* — not when a setting changes. The values
 * a recording captures under are decided once, at `START_RECORDING`, and a page
 * that joins a recording already in progress reads the same snapshot every
 * other page in it is using.
 *
 * `frozen()` resolves whatever the snapshot holds against the field table, so a
 * missing key, a value from a newer version and a hand-edited number out of
 * range all arrive here as something usable.
 */
async function refreshFrozen(): Promise<void> {
  frozen = await loadRecordingSettings();
  // The buffer is a module-level object built before storage could answer, so
  // it is told rather than asked — the alternative is a `const` holding the
  // compiled-in default for the life of the page, which is the exact failure
  // `settings-module-scope.test.ts` exists to prevent.
  reactChains.configure({
    size: frozen['react.bufferSize'],
    ttlMs: frozen['react.bufferTtlMs'],
    timeoutMs: frozen['react.chainTimeoutMs'],
  });
  // The agent has no storage of its own, so this push is the only way the new
  // recording's caps, console levels and walk limits reach the page's realm.
  syncAgent();
}

/**
 * `reactCapture` is the one setting that still applies mid-recording, and the
 * asymmetry is deliberate on both sides.
 *
 * Everything else in the freeze changes what a *future* step looks like, so
 * applying it late would leave one flow describing two rules. This one changes
 * what has already been collected: switching it off purges the component table
 * and strips the ids from the steps that carry them. "Do not record this"
 * cannot honestly mean "from the next recording onwards" when the data is on
 * disk now, so it takes effect at the keystroke — and the frozen copy is
 * updated with it, so the flow's stamp and the flow agree.
 *
 * Do not fold this back into the freeze. See `features/settings/recording.ts`.
 */
subscribe((next) => {
  frozen = { ...frozen, reactCapture: next.reactCapture };
  applyCaptureSetting(next.reactCapture);
});

void (async () => {
  await refreshFrozen();
  // The initial read is not somebody switching capture off — it is the setting
  // already having been off — so it must not purge a recording running in
  // another tab.
  applyCaptureSetting((await load()).reactCapture, true);
})();

// ── Resume after a navigation ────────────────────────────────────────────────

void chrome.storage.local.get(['recordingActive', 'recordingPaused']).then(async (state) => {
  if (!state.recordingActive) return;
  await applyState(true, Boolean(state.recordingPaused));
  // Gated on visibility for the same reason as the storage listener below: a
  // page that loads in a background tab — a middle-click, a `target=_blank`, a
  // prerender Chrome started on its own — has not been navigated to yet. It
  // logs itself when the user actually looks at it.
  if (!isPaused && isOnScreen()) captureNavigationStep();
});

/**
 * Whether the user is actually looking at this tab.
 *
 * Every tab in the browser runs this content script, and extension storage is
 * shared by all of them — so anything that reacts to a recording starting fires
 * in all of them at once. Without this check, pressing Start wrote one
 * "Navigated to …" step per open tab, in the same millisecond, each carrying a
 * screenshot of whichever tab was on screen (`captureVisibleTab` can only
 * photograph the visible one). The recording opened with a burst of navigations
 * the user never made, to pages they had open hours ago.
 *
 * `visibilityState` is also 'hidden' while a page is prerendering, which is what
 * keeps Chrome's own speculative loads — google.com/search/warmup.html and
 * friends — out of the flow.
 */
function isOnScreen(): boolean {
  return document.visibilityState === 'visible';
}

/**
 * Whether this document has already contributed its navigation step to the
 * recording that is currently live.
 *
 * Scoped to the document, so an ordinary navigation within the tab starts over
 * with a fresh script and logs the new page. Its job is to stop one tab from
 * logging itself twice — once on becoming visible and once from a state change
 * that arrives while it is already on screen.
 */
let loggedNavigation = false;

function captureNavigationStep(): void {
  loggedNavigation = true;
  lastUrl = window.location.href;
  requestScreenshotAndSave({
    type: 'navigate',
    url: redactUrl(window.location.href),
    title: document.title,
    timestamp: Date.now(),
    action: `Navigated to ${document.title || window.location.href}`,
  });
}

/**
 * The URL this document has already been recorded at.
 *
 * A single-page app moves between routes by `pushState`, which loads no
 * document, starts no content script and fires no `popstate` — so a React flow,
 * which is most of what FlowSnap records, came out as a run of clicks with
 * nothing to say the page had changed underneath them. This is what notices.
 */
let lastUrl = window.location.href;

/**
 * Record a route change the app made for itself.
 *
 * Deduplicated by URL, because a router can announce the same route more than
 * once, and delayed by a beat, because the URL changes before the framework has
 * rendered what the URL now means — capturing immediately photographs the route
 * the user has just left.
 */
function captureRouteChange(): void {
  if (!isRecording || isPaused || !isOnScreen()) return;
  if (window.location.href === lastUrl) return;
  lastUrl = window.location.href;

  setTimeout(() => {
    if (!isRecording || isPaused || !isOnScreen()) return;
    captureNavigationStep();
  }, frozen['recording.spaSettleMs']);
}

/**
 * `navigation` is the only event that fires for a `pushState`, and Chrome has
 * had it since 102 — well under the manifest's floor of 116. `popstate` and
 * `hashchange` are the fallback for anything that does not, and cover Back,
 * Forward and hash routers on their own.
 */
const navigationApi = (window as { navigation?: EventTarget }).navigation;
if (navigationApi) {
  navigationApi.addEventListener('navigatesuccess', captureRouteChange);
} else {
  window.addEventListener('popstate', captureRouteChange);
  window.addEventListener('hashchange', captureRouteChange);
}

/**
 * A tab the user switches to mid-recording logs itself the moment it comes on
 * screen.
 *
 * This is what actually makes a recording follow the user across tabs: the tab
 * was told to record when Start was pressed, but stayed silent because nobody
 * was looking at it. Arriving is the event worth recording, and it lands in the
 * flow in the order it happened, with a screenshot of the right page.
 */
document.addEventListener('visibilitychange', () => {
  if (!isRecording || isPaused) return;
  if (!isOnScreen() || loggedNavigation) return;
  captureNavigationStep();
});

// ── Capture ──────────────────────────────────────────────────────────────────

function toPlainRect(rect: DOMRect | null): BoundingBox | null {
  if (!rect) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Screenshot before a navigating click lands.
 *
 * The worker holds the frame and the click that follows claims it. Restricted to
 * interactions that may actually navigate, because Chrome rate-limits captures
 * and spending one on every pointerdown would starve the real steps.
 */
document.addEventListener(
  'pointerdown',
  (event) => {
    if (!isRecording || isPaused) return;
    const target = event.target;
    if (!(target instanceof Element) || !mayNavigate(target)) return;
    void withIndicatorHidden(() => sendToWorker({ type: 'PRECAPTURE' }));
  },
  true,
);

document.addEventListener(
  'click',
  (event) => {
    if (!isRecording || isPaused) return;

    const rawEl = event.target;
    if (!(rawEl instanceof Element)) return;

    const { el, action } = describeTarget(rawEl);

    // A native <select> is fully covered by the `change` listener below
    // ("Selected X from …"). Swallowing the click avoids a redundant
    // "Opened dropdown" step on every dropdown interaction.
    if (el.tagName.toLowerCase() === 'select') return;

    requestScreenshotAndSave(
      {
        type: 'click',
        url: redactUrl(window.location.href),
        timestamp: Date.now(),
        element: {
          tag: el.tagName.toLowerCase(),
          text: getElementText(el),
          label: accessibleName(el) || getElementLabel(el),
          role: el.getAttribute('role'),
          type: el.getAttribute('type'),
          cssSelector: generateSelector(el),
          xpath: generateXPath(el),
          boundingBox: toPlainRect(el.getBoundingClientRect()),
          ariaLabel: el.getAttribute('aria-label'),
        },
        action,
      },
      event.timeStamp,
      el,
    );
  },
  true,
);

/**
 * One debounce timer per field, not one for the page.
 *
 * A single shared timer meant that tabbing from email to password inside the
 * debounce window discarded the email step entirely — filling a form quickly
 * lost steps.
 */
/**
 * The timer also carries the `timeStamp` of the event that armed it.
 *
 * The step is written 800 ms after the interaction, long after the component
 * chain for it arrived, so the chain has to be claimed by the key of the event
 * that *caused* the step rather than by whatever is current when it fires.
 */
const inputTimers = new WeakMap<Element, { timer: ReturnType<typeof setTimeout>; eventTime: number }>();

document.addEventListener(
  'input',
  (event) => {
    if (!isRecording || isPaused) return;

    const el = event.target;
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;

    const existing = inputTimers.get(el);
    if (existing) clearTimeout(existing.timer);

    const eventTime = event.timeStamp;
    inputTimers.set(el, {
      eventTime,
      timer: setTimeout(() => {
        inputTimers.delete(el);

        const rawValue = el.value ?? '';
        const isPassword = el instanceof HTMLInputElement && el.type === 'password';
        const value = isPassword ? '•'.repeat(rawValue.length) : rawValue;
        const label = getElementLabel(el);

        requestScreenshotAndSave(
          {
            type: 'input',
            url: redactUrl(window.location.href),
            timestamp: Date.now(),
            element: {
              tag: el.tagName.toLowerCase(),
              label,
              cssSelector: generateSelector(el),
              xpath: generateXPath(el),
              boundingBox: toPlainRect(el.getBoundingClientRect()),
            },
            value,
            action: `Typed "${value}" into ${label}`,
          },
          eventTime,
          el,
        );
      }, frozen['recording.inputDebounceMs']),
    });
  },
  true,
);

/**
 * `input` fires for text fields; `change` is the right event for `<select>` —
 * clicking an option fires `click` on the `<option>`, but the value is not set
 * until `change`.
 */
document.addEventListener(
  'change',
  (event) => {
    if (!isRecording || isPaused) return;

    const el = event.target;
    if (!(el instanceof HTMLSelectElement)) return;

    const label = getElementLabel(el);
    const selectedText = el.options[el.selectedIndex]?.text || el.value;

    requestScreenshotAndSave(
      {
        type: 'input',
        url: redactUrl(window.location.href),
        timestamp: Date.now(),
        element: {
          tag: 'select',
          label,
          cssSelector: generateSelector(el),
          xpath: generateXPath(el),
          boundingBox: toPlainRect(el.getBoundingClientRect()),
        },
        value: selectedText,
        action: `Selected "${selectedText}" from ${label}`,
      },
      event.timeStamp,
      el,
    );
  },
  true,
);

/**
 * Watch what the interaction did to the region around the element.
 *
 * Sent as its own message rather than held onto, because the step is written
 * immediately — delaying it to wait for this would delay the screenshot with it,
 * and the picture is the thing that must not move. The worker merges the two by
 * step key.
 *
 * Nothing is sent when the text did not change, which is most steps.
 */
function watchDomDelta(el: Element, key: string): void {
  // Refusable, like the trailing step: it is worth a switch, and a flow whose
  // stamp says the feature was off cannot be misread as one where nothing on
  // the page ever changed.
  if (!frozen['recording.domDelta']) return;

  const cap = frozen['recording.containerTextCap'];
  const container = nearestContainer(el);
  const before = containerText(container, cap);

  setTimeout(() => {
    if (!isRecording || isPaused) return;

    // Re-read from the container captured at interaction time. Re-finding it
    // would follow the page's *current* DOM, and on a re-render that is a
    // different node — which reads as "everything changed" on every step.
    //
    // The same cap on both reads, taken once: reading the cap again here would
    // let a change made in between turn "the text is the same" into "the text
    // changed", and record a delta the page never produced.
    const after = containerText(container, cap);
    if (after === before) return;

    void sendToWorker({ type: 'STEP_DOM_DELTA', key, before, after });
  }, frozen['recording.domDeltaMs']);
}

/**
 * `eventTime` is the `timeStamp` of the interaction that produced this step, and
 * is how its component chain is claimed. Steps with no originating event — a
 * navigation — pass nothing and simply carry no components. `el` is the element
 * itself, for the DOM delta above; a step without one is not watched.
 */
function requestScreenshotAndSave(step: DraftStep, eventTime?: number, el?: Element): void {
  // Drained synchronously, exactly as before: waiting for a component chain must
  // not change which console and network activity lands on which step.
  const enriched: DraftStep = {
    ...step,
    consoleLogs: pendingLogs.splice(0),
    networkCalls: pendingNetworkCalls.splice(0),
  };

  // Only for steps with an element: a navigation has no region to watch, and
  // the page it landed on is a different document anyway.
  if (el && step.element) watchDomDelta(el, stepKey(step));

  void (async () => {
    let components: CapturedComponent[] | undefined;

    if (eventTime !== undefined && enriched.element) {
      const found = await reactChains.take(eventTime, Date.now());
      if (found && found.chain.length > 0) {
        components = found.chain;
        enriched.element.react = {
          chain: found.chain.map((component) => component.id),
          ...(found.truncated ? { truncated: true } : {}),
        };
      }
    }

    await withIndicatorHidden(() =>
      sendToWorker({
        type: 'CAPTURE_AND_SAVE_STEP',
        step: enriched,
        elementBox: enriched.element?.boundingBox ?? null,
        dpr: window.devicePixelRatio || 1,
        // Read here rather than at capture time, because this is the moment the
        // box belongs to. The worker asks the page again just before it takes
        // the picture and highlights the difference away.
        scroll: { x: window.scrollX, y: window.scrollY },
        components,
        componentsPageUrl: components ? window.location.href : undefined,
      }),
    );
  })();
}

// ── On-page indicator ────────────────────────────────────────────────────────

/**
 * Depth of nested capture requests. The indicator is FlowSnap's own UI, and
 * `captureVisibleTab` photographs whatever is on screen — so without hiding it,
 * every screenshot the tool has ever taken contains its own badge, which then
 * ships to an AI as if it were part of the recorded page.
 */
let captureDepth = 0;

/**
 * Resolve once the browser has painted a frame, so an element removed a moment
 * ago is genuinely off screen before anything photographs it.
 *
 * `requestAnimationFrame` never fires in a background tab, so this races a
 * timeout — waiting forever would mean the step is never sent at all.
 */
function afterPaint(): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ),
    // Frozen, and read per capture: the indicator is hidden for the length of
    // this race, so a value taken once would outlive the recording it was read
    // for.
    new Promise<void>((resolve) => setTimeout(resolve, frozen['screenshots.paintTimeoutMs'])),
  ]);
}

async function withIndicatorHidden<T>(action: () => Promise<T>): Promise<T> {
  const wasVisible = document.getElementById(INDICATOR_ID) !== null;

  captureDepth++;
  renderIndicator();
  if (wasVisible) await afterPaint();

  try {
    return await action();
  } finally {
    captureDepth--;
    renderIndicator();
  }
}

function renderIndicator(): void {
  const existing = document.getElementById(INDICATOR_ID);

  if (!isRecording || captureDepth > 0) {
    existing?.remove();
    return;
  }

  if (!document.body) return;

  const indicator = existing ?? document.createElement('div');
  if (!existing) {
    indicator.id = INDICATOR_ID;
    document.body.appendChild(indicator);
  }

  // The status dot is drawn by content.css as a ::before, so it can pulse and
  // can stop pulsing under prefers-reduced-motion. It used to be a "●" in the
  // text, which could do neither — and the design system allows no emoji.
  indicator.textContent = isPaused ? 'Paused' : 'Recording';
  indicator.classList.toggle('paused', isPaused);
}
