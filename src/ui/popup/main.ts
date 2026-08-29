/**
 * Popup controller.
 *
 * Reads state, hands it to `derivePopupView`, renders the result. Every decision
 * about which state the popup is in lives in view.ts and is tested there; this
 * file only knows how to put a view on screen and how to turn a click into a
 * storage write.
 *
 * Recording state is written to storage and nothing else. Every content script
 * watches storage, so a recording follows the user across tabs — messaging only
 * the active tab is what made recording silently stop the moment you switched.
 *
 * ## Why locating opens a second window
 *
 * A popup cannot survive the gesture that locating is made of. Chrome dismisses
 * it the moment focus leaves, the dismissing click never reaches the page — the
 * same fact `beginRecording` closes the popup over, one paragraph down — and
 * `START_PICK` answers with *the pick itself*, however long the user takes. So
 * the surface that asks has to be alive when the answer lands, and the toolbar
 * popup is guaranteed not to be. Four ways out were on the table:
 *
 *  1. **Ask, then die, and let something else remember.** Nothing else does: the
 *     worker relays the round trip and stores nothing, the content script
 *     answers the one request and forgets, and both belong to other packages.
 *     A result computed with nobody left to receive it is simply dropped.
 *  2. **Hand it to the viewer tab.** The natural home — it is already the
 *     product's large surface — but reaching a locate view there means routing
 *     it, and `viewer/{main,route}.ts` are not this package's to write. A door
 *     that needs another session's edit before it opens is not a door.
 *  3. **Open this same page in a window of its own.** It outlives the click, it
 *     is the popup rather than an imitation of it — same document, same view
 *     model, same card — and `chrome.windows.create` needs no permission the
 *     manifest does not already hold.
 *  4. **Write the answer down.** Necessary regardless: a window can be closed
 *     mid-pick, and the next popup should still know what was found.
 *
 * This file does (3) and (4), which together make the mechanism invisible: press
 * `Locate component`, the popup detaches into a small window over the page, pick
 * anything, and the answer arrives there and stays in `Recent` afterwards. The
 * one sentence the user is told is that the window stays open for the answer —
 * everything else about popup lifetimes is the extension's problem, not theirs.
 *
 * When the viewer grows a locate route, (2) becomes the better home for the
 * result and this window becomes the thing that hands it over; nothing above the
 * `beginLocate`/`runPick` seam would have to change.
 */

import { bytesInUse, getLocal, setLocal } from '../../chrome/storage.js';
import { hydrateTail, sweep as sweepShots } from '../../features/flows/shots.js';
import { ensureContentScript } from '../../chrome/scripting.js';
import { reloadAndWait } from '../../chrome/tabs.js';
import {
  prepare,
  probe,
  type Preflight,
  type RecordingTarget,
} from '../../features/recording/preflight.js';
import { sendToWorker } from '../../shared/messages.js';
import {
  RECORDING_DEFAULTS,
  loadRecordingSettings,
  snapshotForRecording,
} from '../../features/settings/recording.js';
import { DEFAULTS, type RecordingSettings, type Settings } from '../../features/settings/fields.js';
import { load as loadSettings } from '../../features/settings/index.js';
import { editorTemplate, type EditorLink } from '../../core/react/editor.js';
import { bundleBudget, createWorkerProvider } from '../../features/react/providers/worker.js';
import type { PickSuccess, RecordingState, Step, StoredError } from '../../shared/types.js';
import { resultCard } from '../components/result-card.js';
import { formatAgo, formatBytes, formatElapsed, formatRelative } from '../format.js';
import { hydrateIcons, setIcon } from '../icons.js';
import { initTheme } from '../theme.js';
import { showToast } from '../toast.js';
import {
  chooseComponent,
  locatePicked,
  locateSettings,
  type LocateDeps,
} from './locate.js';
import {
  LOCATE_KEY,
  derivePopupView,
  parseLocateHash,
  parseLocated,
  toLocated,
  THUMBNAIL_LIMIT,
  type Located,
  type LocateState,
  type LocateView,
  type NoticeView,
  type PopupView,
} from './view.js';

initTheme();
hydrateIcons();

/**
 * The tab this window is picking on, or null in the toolbar popup.
 *
 * The hash is the whole hand-off. A detached window has no active tab of its
 * own — `chrome.tabs.query({ currentWindow: true })` would answer with itself —
 * so the tab it is about has to travel with the URL rather than be looked up.
 */
const locateTabId = parseLocateHash(location.hash);
const surface = locateTabId === null ? 'toolbar' : 'locate';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`DevFlow: missing #${id} in popup.html`);
  return node as T;
}

const dom = {
  brandDot: el('brand-dot'),
  settings: el<HTMLButtonElement>('btn-settings'),

  loading: el('s-loading'),

  target: el('s-target'),
  targetLabel: el('target-label'),
  targetFavicon: el<HTMLImageElement>('target-favicon'),
  targetHost: el('target-host'),

  blocked: el('s-blocked'),
  blockedTitle: el('blocked-title'),
  blockedUrl: el('blocked-url'),

  notice: el('notice'),
  noticeIcon: el('notice-icon'),
  noticeTitle: el('notice-title'),
  noticeBody: el('notice-body'),

  start: el<HTMLButtonElement>('btn-start'),
  startIcon: el('btn-start-icon'),
  reload: el<HTMLButtonElement>('btn-reload'),

  live: el('s-live'),
  liveBanner: el('live-banner'),
  liveDot: el('live-dot'),
  liveLabel: el('live-label'),
  liveTimer: el('live-timer'),
  liveCount: el('live-count'),
  liveCap: el('live-cap'),
  liveLast: el('live-last'),
  pause: el<HTMLButtonElement>('btn-pause'),
  resume: el<HTMLButtonElement>('btn-resume'),
  stop: el<HTMLButtonElement>('btn-stop'),

  flow: el('s-flow'),
  flowCount: el('flow-count'),
  flowWhen: el('flow-when'),
  flowThumbs: el('flow-thumbs'),
  view: el<HTMLButtonElement>('btn-view'),
  clear: el<HTMLButtonElement>('btn-clear'),

  empty: el('s-empty'),

  locateAction: el<HTMLButtonElement>('btn-locate'),
  locateActionLabel: el('btn-locate-label'),

  recent: el('s-recent'),
  recentWhen: el('recent-when'),
  recentCard: el('recent-card'),

  locate: el('s-locate'),
  locateSpinner: el('locate-spinner'),
  locateStatus: el('locate-status'),
  locateNotice: el('locate-notice'),
  locateNoticeTitle: el('locate-notice-title'),
  locateNoticeBody: el('locate-notice-body'),
  locateCard: el('locate-card'),
  pick: el<HTMLButtonElement>('btn-pick'),
  pickLabel: el('btn-pick-label'),
  cancelPick: el<HTMLButtonElement>('btn-cancel-pick'),

  footer: el('footer'),
  storageText: el('storage-text'),
  library: el<HTMLButtonElement>('btn-library'),

  discardDialog: el<HTMLDialogElement>('discard-dialog'),
  discardBody: el('discard-body'),
};

// ── State ────────────────────────────────────────────────────────────────────

interface PopupState {
  preflight: Preflight | null;
  recording: RecordingState;
  steps: Step[];
  startedAt: number | null;
  usedBytes: number | null;
  lastError: StoredError | null;
  /**
   * The settings the live recording was frozen at.
   *
   * The compiled-in answer until storage replies, and until a recording starts:
   * an idle popup has no recording to describe, and the defaults are what the
   * next one will use unless the user has changed something — which the read
   * below then corrects, before anything is on screen long enough to read.
   */
  frozen: RecordingSettings;
  /**
   * The two live settings the popup reads, kept beside the frozen ones.
   *
   * Neither shapes a recording: one decides how long a failure is worth
   * mentioning, the other how long to wait for a reload the user asked for
   * before Record was pressed. So they are read on every refresh, not taken
   * from the snapshot.
   */
  live: Settings;
  /** How far this window's locate has got. Only moves on the locate surface. */
  locate: LocateState;
  /** The last locate, read from storage. Only shown on the toolbar. */
  recent: Located | null;
  /**
   * The two settings that decide whether a path is clickable, resolved once.
   *
   * Null is the ordinary state — most people have no project root configured —
   * and it is the card's signal to show the path without an Open in Editor
   * button rather than one that would open nothing.
   */
  editor: EditorLink | null;
}

const state: PopupState = {
  preflight: null,
  recording: 'idle',
  steps: [],
  startedAt: null,
  usedBytes: null,
  lastError: null,
  frozen: RECORDING_DEFAULTS,
  live: DEFAULTS,
  locate: { phase: 'starting', component: null, answer: null, stopped: null },
  recent: null,
  editor: null,
};

function show(node: HTMLElement, visible: boolean): void {
  node.classList.toggle('hidden', !visible);
}

const NOTICE_ICON = {
  info: 'info',
  warn: 'triangle-alert',
  danger: 'triangle-alert',
} as const;

function renderNotice(notice: NoticeView | null): void {
  show(dom.notice, notice !== null);
  if (!notice) return;

  dom.notice.className = `banner banner--${notice.tone}`;
  setIcon(dom.noticeIcon, NOTICE_ICON[notice.tone]);
  dom.noticeTitle.textContent = notice.title;
  dom.noticeBody.textContent = notice.body;
}

function renderThumbs(thumbnails: string[], extra: number): void {
  dom.flowThumbs.replaceChildren();

  for (const src of thumbnails) {
    const img = document.createElement('img');
    img.className = 'thumbs__item';
    img.src = src;
    img.alt = '';
    dom.flowThumbs.append(img);
  }

  if (extra > 0) {
    const chip = document.createElement('span');
    chip.className = 'chip chip--count';
    chip.textContent = `+${extra}`;
    dom.flowThumbs.append(chip);
  }

  show(dom.flowThumbs, thumbnails.length > 0);
}

/**
 * The card, wherever it appears.
 *
 * Rebuilt rather than updated, which is what `result-card.ts` documents as the
 * contract for all three of its callers: a card is content, not chrome, and a
 * new answer or a changed editor setting produces a new one.
 *
 * No `onOpenSources`. The popup has no DevTools window to reveal a compiled
 * position in, and omitting the handler is how a surface says so — the card
 * leaves the button out rather than rendering one that cannot work.
 */
function renderCard(mount: HTMLElement, located: Located | null): void {
  mount.replaceChildren();
  if (!located) return;

  mount.append(
    resultCard({
      source: located.source,
      link: state.editor,
      resourcesSearched: located.resourcesSearched,
      onCopyPath: (path) => void copyPath(path),
      onOpenEditor: (url) => void openInEditor(url),
      onPickAnother: locateTabId !== null ? () => void runPick(locateTabId) : undefined,
    }),
  );
}

function renderLocate(locate: LocateView): void {
  show(dom.locateSpinner, locate.busy);
  dom.locateStatus.textContent = locate.status;

  show(dom.locateNotice, locate.notice !== null);
  if (locate.notice) {
    dom.locateNotice.className = `banner banner--${locate.notice.tone}`;
    dom.locateNoticeTitle.textContent = locate.notice.title;
    dom.locateNoticeBody.textContent = locate.notice.body;
  }

  renderCard(dom.locateCard, locate.answer);

  show(dom.pick, locate.pick !== null);
  if (locate.pick) dom.pickLabel.textContent = locate.pick.label;
  show(dom.cancelPick, locate.cancel);
}

function render(view: PopupView): void {
  document.body.classList.toggle('popup--window', view.surface === 'locate');

  show(dom.loading, view.body === 'loading');
  dom.loading.setAttribute('aria-hidden', String(view.body !== 'loading'));

  show(dom.target, view.target !== null);
  dom.targetLabel.textContent = view.targetLabel;
  if (view.target) {
    dom.targetHost.textContent = view.target.host || view.target.title || 'this tab';
    const favicon = view.target.favIconUrl;
    // Chrome hands back chrome:// favicon URLs for some tabs, which an extension
    // page cannot load; only http(s) and data URLs are worth attempting.
    const usable = favicon != null && /^(https?:|data:)/.test(favicon);
    show(dom.targetFavicon, usable);
    if (usable) dom.targetFavicon.src = favicon;
  }

  show(dom.blocked, view.blocked !== null);
  if (view.blocked) {
    dom.blockedTitle.textContent = view.blocked.title || 'Untitled tab';
    dom.blockedUrl.textContent = view.blocked.url;
  }

  renderNotice(view.notice);

  show(dom.start, view.primary !== null);
  if (view.primary) {
    dom.start.disabled = view.primary.disabled;
    setIcon(dom.startIcon, view.primary.icon);
  }
  show(dom.reload, view.offerReload);

  show(dom.live, view.live !== null);
  if (view.live) {
    const { live } = view;
    dom.live.classList.toggle('live--paused', live.paused);

    dom.liveBanner.dataset.state = live.paused ? 'paused' : 'recording';
    dom.liveDot.classList.toggle('rec-dot--paused', live.paused);
    dom.liveLabel.textContent = live.paused ? 'Paused' : 'Recording';
    dom.liveTimer.textContent = live.elapsedMs == null ? '--:--' : formatElapsed(live.elapsedMs);

    dom.liveCount.textContent = String(live.count);
    show(dom.liveCap, live.long);
    if (live.long) {
      dom.liveCap.textContent = 'This flow is getting long — it will still record, but exports take longer.';
    }

    dom.liveLast.textContent = live.paused
      ? 'Nothing is being captured while paused'
      : live.lastAction
        ? `${live.lastAction}  ·  ${formatAgo(live.lastAgoMs ?? 0)}`
        : 'Waiting for the first interaction';

    show(dom.pause, !live.paused);
    show(dom.resume, live.paused);
  }

  show(dom.flow, view.flow !== null);
  if (view.flow) {
    dom.flowCount.textContent = String(view.flow.count);
    dom.flowWhen.textContent =
      view.flow.lastAt == null
        ? ''
        : (formatRelative(Date.now() - view.flow.lastAt) ?? 'a while ago');
    renderThumbs(view.flow.thumbnails, view.flow.extra);
  }

  show(dom.empty, view.body === 'empty');

  show(dom.locateAction, view.locateAction !== null);
  if (view.locateAction) {
    dom.locateAction.disabled = view.locateAction.disabled;
    dom.locateActionLabel.textContent = view.locateAction.label;
  }

  show(dom.recent, view.recent !== null);
  if (view.recent) {
    dom.recentWhen.textContent = formatRelative(Date.now() - view.recent.at) ?? 'a while ago';
    renderCard(dom.recentCard, view.recent);
  }

  show(dom.locate, view.locate !== null);
  if (view.locate) renderLocate(view.locate);

  show(dom.footer, view.storage !== null);
  if (view.storage) {
    dom.storageText.textContent = `${formatBytes(view.storage.usedBytes)} stored`;
  }

  show(dom.brandDot, view.recording !== 'idle');
  dom.brandDot.classList.toggle('rec-dot--paused', view.recording === 'paused');
}

function paint(): void {
  render(
    derivePopupView({
      ...state,
      surface,
      now: Date.now(),
      warnSteps: state.frozen['recording.warnSteps'],
      errorTtlMs: state.live['ui.errorTtlMs'],
    }),
  );
}

// ── Reading ──────────────────────────────────────────────────────────────────

async function readStored(): Promise<void> {
  const stored = await getLocal([
    'recordingActive',
    'recordingPaused',
    'recordedSteps',
    'recordingStartedAt',
    'lastError',
  ]);

  if (!stored.ok) {
    state.lastError = { ...stored.error, at: Date.now() };
    return;
  }

  const { recordingActive, recordingPaused, recordedSteps, recordingStartedAt, lastError } =
    stored.value;

  state.recording = recordingActive ? (recordingPaused ? 'paused' : 'recording') : 'idle';
  /*
   * Only the tail. The card draws `THUMBNAIL_LIMIT` images and counts the rest,
   * and the popup opens on every click of the toolbar icon — hydrating a
   * 300-step recording to show three pictures is the cost `features/flows/shots`
   * exists to remove, paid in the one place the user waits for a window.
   */
  const captured = Array.isArray(recordedSteps) ? recordedSteps : [];
  state.steps = await hydrateTail(captured, THUMBNAIL_LIMIT);
  state.startedAt = typeof recordingStartedAt === 'number' ? recordingStartedAt : null;
  state.lastError = lastError ?? null;
  // Read every refresh, never once at import: the popup is opened again and
  // again across the life of one recording, and each open must describe the
  // recording that is actually running rather than the one that was.
  state.frozen = await loadRecordingSettings();
  state.live = await loadSettings();
}

async function readUsage(): Promise<void> {
  state.usedBytes = await bytesInUse();
}

/**
 * The last locate, and whether its path can be opened.
 *
 * Both are read on every refresh rather than once at start-up: the locate window
 * writes the key while this popup may be open beside it, and the editor pair
 * lives in Settings, which is a different tab entirely.
 */
async function readLocate(): Promise<void> {
  const stored = await getLocal(LOCATE_KEY);
  state.recent = stored.ok ? parseLocated(stored.value[LOCATE_KEY]) : null;

  const { projectRoot, editor, customEditorTemplate } = state.live;
  const template = editorTemplate(editor, customEditorTemplate);
  state.editor = projectRoot && template ? { projectRoot, template } : null;
}

async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    showToast({ message: 'Path copied.', tone: 'success', durationMs: 2500 });
  } catch {
    // Chrome refuses the clipboard when the document is not focused, which is
    // easy to hit here: the window that shows this card is usually not the one
    // the user is clicking in.
    showToast({ message: 'Chrome wouldn’t copy that. Select it and press Ctrl+C.', tone: 'danger' });
  }
}

/**
 * The worker opens editor links, because an extension page cannot navigate
 * itself to a custom scheme — see `OpenEditor` in shared/messages.ts.
 */
async function openInEditor(url: string): Promise<void> {
  const response = await sendToWorker({ type: 'OPEN_EDITOR', url });
  if (response?.ok) return;

  showToast({ message: response?.error ?? 'Chrome wouldn’t open that link.', tone: 'danger' });
}

/**
 * The timer is the only thing that changes without an event, so it is the only
 * thing on an interval — and only while a recording is actually running.
 */
let ticker: ReturnType<typeof setInterval> | null = null;

function syncTicker(): void {
  const wanted = state.recording === 'recording';
  if (wanted && ticker === null) ticker = setInterval(paint, 1000);
  if (!wanted && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

/**
 * What the locate window needs, which is much less than the popup does.
 *
 * No steps, no thumbnails, no storage figure: this window shows one gesture and
 * its answer. The recording flags are still read, because the brand dot carries
 * them on every surface, and the settings because the card's editor link comes
 * out of them.
 */
async function readForLocateWindow(): Promise<void> {
  const stored = await getLocal(['recordingActive', 'recordingPaused']);

  if (stored.ok) {
    const { recordingActive, recordingPaused } = stored.value;
    state.recording = recordingActive ? (recordingPaused ? 'paused' : 'recording') : 'idle';
  }

  state.live = await loadSettings();
  await readLocate();
}

async function refresh(): Promise<void> {
  if (surface === 'locate') {
    await readForLocateWindow();
    paint();
    return;
  }

  await readStored();
  await readUsage();
  await readLocate();
  syncTicker();
  paint();
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function beginRecording(): Promise<void> {
  const ready = await prepare();

  if (!ready.ok) {
    // Re-probe rather than inventing a state: whatever went wrong, the popup
    // should now show what is actually true of the tab.
    state.preflight = await probe();
    state.lastError = { ...ready.error, at: Date.now() };
    paint();
    return;
  }

  // The previous recording's images are keyed independently of its steps, so
  // emptying the array does not free them. Swept before the array is replaced:
  // afterwards there is nothing left that names them.
  await sweepShots();

  /*
   * `START_RECORDING` snapshots the settings. This is that moment.
   *
   * Read before the write and included in the same batch, so there is no
   * instant in which a recording is live without a snapshot — the worker reads
   * this key on every capture, and a capture that found it missing would use
   * the defaults and put a step in the flow that the stamp does not describe.
   */
  const settings = await snapshotForRecording();

  const written = await setLocal({
    recordingActive: true,
    recordingPaused: false,
    recordedSteps: [],
    recordingStartedAt: Date.now(),
    recordingSettings: settings,
    lastError: null,
    // Cleared so it only ever names the flow this recording was auto-exported
    // as. The review tab reuses it when the user presses Send, which is what
    // stops one recording from becoming two flows on the MCP server; a stale id
    // from the previous recording would make it overwrite the wrong one.
    lastMcpFlowId: '',
  });

  if (!written.ok) {
    state.lastError = { ...written.error, at: Date.now() };
    paint();
    return;
  }

  await refresh();

  // Recording is live, so get out of the way. The popup overlays the page and
  // has to be dismissed before the flow can start, and the click that dismisses
  // it does not reach the page underneath — so the first interaction the user
  // meant to record is the one that gets lost. The navigation step is captured
  // from the storage change, not from here, and the on-page indicator and the
  // toolbar badge carry the recording state once this window is gone.
  window.close();
}

dom.start.addEventListener('click', () => {
  dom.start.disabled = true;
  void beginRecording();
});

/**
 * Reload before starting, so the MAIN-world agent is present for the page's own
 * load. Injecting into an already-loaded page cannot recover the network calls
 * and console output that happened before it landed.
 */
dom.reload.addEventListener('click', () => {
  void (async () => {
    const found = await probe();
    if (found.status === 'blocked') {
      state.preflight = found;
      paint();
      return;
    }

    dom.reload.disabled = true;
    await reloadAndWait(found.target.tabId, state.live['recording.reloadTimeoutMs']);
    await beginRecording();
    dom.reload.disabled = false;
  })();
});

/**
 * Stopping goes through the worker so the steps still in its capture queue are
 * written before the recording is declared over — see `FinishRecording`. The
 * direct write stays as the fallback: a recording that will not stop because a
 * message failed is worse than one that stops a step short.
 */
dom.stop.addEventListener('click', () => {
  void (async () => {
    dom.stop.disabled = true;
    const finished = await sendToWorker({ type: 'FINISH_RECORDING' });
    if (!finished?.ok) {
      await setLocal({ recordingActive: false, recordingPaused: false, recordingStartedAt: null });
    }
    dom.stop.disabled = false;
    await refresh();
  })();
});

dom.pause.addEventListener('click', () => {
  void (async () => {
    await setLocal({ recordingPaused: true });
    await refresh();
  })();
});

dom.resume.addEventListener('click', () => {
  void (async () => {
    await setLocal({ recordingPaused: false });
    await refresh();
  })();
});

/**
 * The two buttons now go to two places — the viewer split into Library and
 * Review in step 8 (structural decision A). "Open flow" lands on the recording
 * in progress; "Library" lands on the list.
 */
dom.view.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html#/current') });
});

dom.library.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});

dom.settings.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

/**
 * Discarding is irreversible and the steps are not written anywhere else yet, so
 * it asks first — and says how much is about to be lost.
 */
dom.clear.addEventListener('click', () => {
  const count = state.steps.length;
  dom.discardBody.textContent =
    count === 1
      ? 'The one recorded step will be deleted. This cannot be undone.'
      : `All ${count} recorded steps will be deleted. This cannot be undone.`;
  dom.discardDialog.showModal();
});

dom.discardDialog.addEventListener('close', () => {
  if (dom.discardDialog.returnValue !== 'discard') return;

  void (async () => {
    await sendToWorker({ type: 'CLEAR_STEPS' });
    // `CLEAR_STEPS` sweeps too. Repeated here because this path does not depend
    // on the worker answering — it writes the cleared state itself for exactly
    // that reason, and the images have to be cleared on the same terms.
    await sweepShots();
    await setLocal({
      recordedSteps: [],
      recordingActive: false,
      recordingPaused: false,
      recordingStartedAt: null,
      lastError: null,
    });
    await refresh();
  })();
});

// ── Locating: the toolbar side ───────────────────────────────────────────────

/** The detached window's size. Wide enough for the popup body, tall enough for a card. */
const LOCATE_WINDOW = { width: 380, height: 620 };

/**
 * Where to put it: under the toolbar button it just came from.
 *
 * The illusion is worth the four lines. A window that opens in the middle of the
 * screen reads as a new thing that has appeared; one that opens where the popup
 * was reads as the popup staying put, which is what it is.
 */
async function locateWindowBounds(windowId: number): Promise<{ left?: number; top?: number }> {
  try {
    const host = await chrome.windows.get(windowId);
    if (host.left == null || host.top == null || host.width == null) return {};

    return {
      left: Math.max(0, host.left + host.width - LOCATE_WINDOW.width - 16),
      top: Math.max(0, host.top + 72),
    };
  } catch {
    // Positioning is a nicety; Chrome placing it wherever it likes is not a
    // failure worth abandoning the locate over.
    return {};
  }
}

/**
 * The locate window that is already open, if there is one.
 *
 * Found by looking rather than remembered, because the alternative is a stored
 * window id that outlives the window: an id written to storage survives the user
 * closing the window, the worker restarting and Chrome quitting, and every one
 * of those leaves a locate that silently targets nothing.
 */
async function existingLocateWindow(): Promise<{ windowId: number; tabId: number } | null> {
  const ours = chrome.runtime.getURL('popup.html');

  try {
    for (const open of await chrome.windows.getAll({ populate: true })) {
      if (open.type !== 'popup' || open.id == null) continue;

      const tab = open.tabs?.find((candidate) => candidate.url?.startsWith(ours));
      if (tab?.id != null) return { windowId: open.id, tabId: tab.id };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Detach the popup onto a tab and get out of the way.
 *
 * `prepare()` rather than `probe()`: it injects the content script the same way
 * pressing Start does, so a tab that predates the extension is pickable rather
 * than merely reported as not ready. The window is opened before this one
 * closes, because after `window.close()` there is nothing left to open it with.
 */
async function beginLocate(): Promise<void> {
  const ready = await prepare();

  if (!ready.ok) {
    state.preflight = await probe();
    state.lastError = { ...ready.error, at: Date.now() };
    paint();
    return;
  }

  await showLocateWindow(ready.value);
  window.close();
}

async function showLocateWindow(target: RecordingTarget): Promise<void> {
  const url = chrome.runtime.getURL(`popup.html#locate=${target.tabId}`);
  const existing = await existingLocateWindow();

  // One locate window, re-pointed. Two windows picking on two tabs is two live
  // pickers and two answers, and the second one to arrive would look like the
  // answer to whichever gesture the user remembers making.
  if (existing) {
    await chrome.tabs.update(existing.tabId, { url });
    /*
     * Reloaded, not merely re-pointed.
     *
     * Pressing `Locate component` arms a pick — that is what the button says.
     * Pointing an open window at the tab it is already showing changes nothing
     * about the URL, so nothing reloads, and the window would sit there with the
     * previous answer on screen and no picker armed. A reload is one start-up
     * path for both cases, and there is no half-torn-down pick left behind.
     */
    await chrome.tabs.reload(existing.tabId);
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }

  await chrome.windows.create({
    url,
    type: 'popup',
    focused: true,
    ...LOCATE_WINDOW,
    ...(await locateWindowBounds(target.windowId)),
  });
}

// ── Locating: the window's side ──────────────────────────────────────────────

function setLocate(next: Partial<LocateState>): void {
  state.locate = { ...state.locate, ...next };
  paint();
}

/**
 * Bring the answer forward.
 *
 * The pick happens in the page's window, which is on top by the time it lands,
 * so an answer that arrives quietly arrives behind whatever the user is looking
 * at. Called for a result and for a failure, never for a plain cancel: someone
 * who pressed Escape has said what they want, and stealing their focus to
 * confirm it would be the window arguing back.
 */
async function surfaceWindow(): Promise<void> {
  try {
    const current = await chrome.windows.getCurrent();
    if (current.id != null) await chrome.windows.update(current.id, { focused: true });
  } catch {
    // A window that cannot be focused is still a window with the answer in it.
  }
}

function stopLocate(reason: string | null): void {
  setLocate({ phase: 'stopped', component: null, stopped: reason });
  if (reason) void surfaceWindow();
}

/** Display only, so a URL that will not parse costs a hostname and nothing else. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * The tab named in the hash, as the view's target row wants it.
 *
 * Null means the tab itself is gone — closed, or never there. A tab that is
 * present but cannot be picked on is *not* rejected here: `ensureContentScript`
 * is the one that knows why, and it says so in a sentence this window can show.
 */
async function readPickTarget(tabId: number): Promise<RecordingTarget | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.id == null || !tab.url) return null;

    return {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      host: hostOf(tab.url),
      title: tab.title ?? '',
      favIconUrl: tab.favIconUrl,
    };
  } catch {
    return null;
  }
}

/**
 * What the page has loaded, asked of the page.
 *
 * The resolver's inventory (`reactScripts`) is written by the recorder while it
 * records, so on this path it is usually empty — and a locate that trusted it
 * would answer "nothing to search" on every page nobody was recording. The tab
 * knows, so the tab is asked.
 */
async function scriptsInTab(tabId: number): Promise<string[]> {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: collectScripts });
    return Array.isArray(result?.result) ? result.result : [];
  } catch {
    // A tab that navigated to somewhere unscriptable mid-pick. The locate goes
    // on and reports having found nothing to search, which is what happened.
    return [];
  }
}

/**
 * Runs inside the page, so it is serialised to get there: no imports, no
 * closure, nothing but what the DOM and the timeline already know.
 *
 * Both sources, for the reason `inventory.ts` gives: the resource timeline is
 * the complete load order but can be evicted under buffer pressure, and
 * `document.scripts` catches the tags whatever the timeline dropped.
 */
function collectScripts(): string[] {
  const urls: string[] = [];

  for (const entry of performance.getEntriesByType('resource')) {
    if ((entry as PerformanceResourceTiming).initiatorType === 'script') urls.push(entry.name);
  }
  for (const script of Array.from(document.scripts)) {
    if (script.src) urls.push(script.src);
  }

  return urls;
}

/** Everything one locate reaches outside itself, pointed at this tab. */
function locateDeps(tabId: number, settings: Settings): LocateDeps {
  return {
    readSource: async (group, index) => {
      const answer = await sendToWorker({ type: 'READ_COMPONENT_SOURCE', tabId, group, index });
      return answer?.source ?? null;
    },
    listScripts: () => scriptsInTab(tabId),
    // Built per locate rather than kept: this window exists for one gesture, and
    // a cache that outlives it would only ever be paid for and never used.
    provider: createWorkerProvider(bundleBudget(settings)),
    now: Date.now,
  };
}

/**
 * Arm the picker, wait however long the user takes, then answer.
 *
 * `START_PICK` resolves with the pick itself — the content script holds its
 * response until the agent reports, bounded by `PICK_TIMEOUT_MS` — which is the
 * whole reason this window has to still exist. Everything after the await is
 * running two minutes later than the click that started it.
 */
async function runPick(tabId: number): Promise<void> {
  setLocate({ phase: 'starting', component: null, answer: null, stopped: null });

  const target = await readPickTarget(tabId);
  if (!target) {
    stopLocate('That tab has gone. Open the popup on the page you want to pick on.');
    return;
  }

  state.preflight = { status: 'ready', target };
  paint();

  const attached = await ensureContentScript(target.tabId, target.url);
  if (!attached.ok) {
    stopLocate(attached.error.message);
    return;
  }

  setLocate({ phase: 'picking' });

  const pick = await sendToWorker({ type: 'START_PICK', tabId });

  if (!pick) {
    stopLocate('The extension stopped listening before the pick came back. Try again.');
    return;
  }
  // Escape, or a second surface taking the picker over. Nothing went wrong, so
  // nothing is said and nothing takes the user's focus.
  if (pick.kind === 'cancelled') {
    stopLocate(null);
    return;
  }
  if (pick.kind === 'error') {
    stopLocate(pick.error);
    return;
  }

  await locate(pick, target);
}

async function locate(pick: PickSuccess, target: RecordingTarget): Promise<void> {
  const settings = await loadSettings();
  const options = locateSettings(settings);

  // Asked here only for the name to put on screen while the search runs.
  // `locatePicked` chooses again from the same pure function rather than being
  // handed the answer, so nothing about which component is located depends on
  // this window having painted first.
  const chosen = chooseComponent(pick, options.hidden);
  setLocate({ phase: 'locating', component: chosen?.component.name ?? null });

  const result = await locatePicked(pick, target.url, options, locateDeps(target.tabId, settings));

  if (!result) {
    stopLocate('There is no React component around what you clicked.');
    return;
  }

  const located = toLocated(result, target.host, Date.now());

  // Written before it is shown, so the answer survives this window being closed
  // — the next popup opens with it under `Recent`. A failed write costs the
  // memory, not the answer that is about to be on screen.
  await setLocal({ [LOCATE_KEY]: located });

  setLocate({ phase: 'answered', component: result.component, answer: located, stopped: null });
  void surfaceWindow();
}

dom.locateAction.addEventListener('click', () => {
  dom.locateAction.disabled = true;
  void beginLocate();
});

dom.pick.addEventListener('click', () => {
  if (locateTabId !== null) void runPick(locateTabId);
});

dom.cancelPick.addEventListener('click', () => {
  if (locateTabId !== null) void sendToWorker({ type: 'CANCEL_PICK', tabId: locateTabId });
});

/** Esc cancels from this window too, so the pair in CONTRACTS §4.4 both work. */
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || locateTabId === null) return;
  if (state.locate.phase !== 'picking') return;

  void sendToWorker({ type: 'CANCEL_PICK', tabId: locateTabId });
});

/*
 * A window closed mid-pick leaves the page armed.
 *
 * The agent's crosshair and its capture-phase listeners are on a page the user
 * is still trying to use, and `PICK_TIMEOUT_MS` is two minutes of that. Sent
 * from `pagehide` on a best-effort basis — an unloading document may not get the
 * message out, which is exactly what the timeout is the backstop for.
 */
window.addEventListener('pagehide', () => {
  if (locateTabId === null || state.locate.phase !== 'picking') return;
  void sendToWorker({ type: 'CANCEL_PICK', tabId: locateTabId });
});

// ── Live updates ─────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  const watched = [
    'recordedSteps',
    'recordingActive',
    'recordingPaused',
    'recordingStartedAt',
    'lastError',
    // The locate window writes this one, and it can be open beside the popup —
    // so `Recent` follows a pick made while this window is on screen.
    LOCATE_KEY,
  ];
  if (watched.some((key) => key in changes)) void refresh();
});

// ── Start ────────────────────────────────────────────────────────────────────

void (async () => {
  // Stored state first: it is what decides whether the popup shows a recording
  // at all, and it resolves faster than the tab probe.
  await refresh();

  /*
   * The locate window arms immediately.
   *
   * It was opened by a press of `Locate component`, so waiting behind a second
   * button would be asking the user to say the same thing twice. It does not
   * probe either: `probe()` reads the active tab of the current window, which
   * in a detached window is this page, and the tab it is actually about came in
   * the hash.
   */
  if (locateTabId !== null) {
    await runPick(locateTabId);
    return;
  }

  state.preflight = await probe();
  paint();
})();
