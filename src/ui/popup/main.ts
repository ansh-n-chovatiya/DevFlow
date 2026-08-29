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
 */

import { bytesInUse, getLocal, setLocal } from '../../chrome/storage.js';
import { hydrateTail, sweep as sweepShots } from '../../features/flows/shots.js';
import { reloadAndWait } from '../../chrome/tabs.js';
import { prepare, probe, type Preflight } from '../../features/recording/preflight.js';
import { sendToWorker } from '../../shared/messages.js';
import {
  RECORDING_DEFAULTS,
  loadRecordingSettings,
  snapshotForRecording,
} from '../../features/settings/recording.js';
import { DEFAULTS, type RecordingSettings, type Settings } from '../../features/settings/fields.js';
import { load as loadSettings } from '../../features/settings/index.js';
import type { RecordingState, Step, StoredError } from '../../shared/types.js';
import { formatAgo, formatBytes, formatElapsed, formatRelative } from '../format.js';
import { hydrateIcons, setIcon } from '../icons.js';
import { initTheme } from '../theme.js';
import { derivePopupView, THUMBNAIL_LIMIT, type NoticeView, type PopupView } from './view.js';

initTheme();
hydrateIcons();

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`FlowSnap: missing #${id} in popup.html`);
  return node as T;
}

const dom = {
  brandDot: el('brand-dot'),
  settings: el<HTMLButtonElement>('btn-settings'),

  loading: el('s-loading'),

  target: el('s-target'),
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

function render(view: PopupView): void {
  show(dom.loading, view.body === 'loading');
  dom.loading.setAttribute('aria-hidden', String(view.body !== 'loading'));

  show(dom.target, view.target !== null);
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

async function refresh(): Promise<void> {
  await readStored();
  await readUsage();
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

// ── Live updates ─────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  const watched = [
    'recordedSteps',
    'recordingActive',
    'recordingPaused',
    'recordingStartedAt',
    'lastError',
  ];
  if (watched.some((key) => key in changes)) void refresh();
});

// ── Start ────────────────────────────────────────────────────────────────────

void (async () => {
  // Stored state first: it is what decides whether the popup shows a recording
  // at all, and it resolves faster than the tab probe.
  await refresh();
  state.preflight = await probe();
  paint();
})();
