/**
 * What the popup should show, derived from what is true.
 *
 * Pure: no `chrome.*`, no DOM, no clock of its own — `now` is passed in. Every
 * decision about which state the popup is in lives here and is covered by
 * tests/popup-view.test.ts, so `main.ts` is left with nothing but rendering.
 *
 * ## Two surfaces, one view model
 *
 * The popup now has a second job — locating a component — and a popup cannot do
 * that job in the window it opens in: the picker's gesture is a click on the
 * page, and the click that reaches the page is the one that dismissed the popup.
 * So the locate half runs in a detached window showing this same document (see
 * `main.ts`, which owns that decision and the reasoning behind it), and this
 * module describes both. `PopupInput.surface` says which one is asking; every
 * other difference between them is derived here rather than branched on in the
 * controller, so "what does the locate window show while the picker is armed" is
 * a test rather than a walk through `main.ts`.
 */

import type { Preflight } from '../../features/recording/preflight.js';
import type {
  ComponentSource,
  LocateResult,
  RecordingState,
  Step,
  StoredError,
} from '../../shared/types.js';

/** How many screenshot thumbnails the current-flow card shows before counting. */
export const THUMBNAIL_LIMIT = 3;

/**
 * Which window this document is being rendered in.
 *
 * `toolbar` is the popup Chrome opens under the action icon. `locate` is the
 * same page in a window of its own, opened because the first one cannot survive
 * the click that does the picking.
 */
export type PopupSurface = 'toolbar' | 'locate';

/** Where the storage key that carries a finished locate between the two lives. */
export const LOCATE_KEY = 'lastLocate';

/**
 * The tab a locate window was opened for: `#locate=<tabId>`.
 *
 * A tab id is the whole of the hand-off, so it is validated like any other value
 * arriving in a URL. A window that opened with a mangled hash is the toolbar
 * popup — which shows the recording controls and no armed picker — rather than
 * a locate window pointed at `NaN`.
 */
export function parseLocateHash(hash: string): number | null {
  const match = /^#locate=(\d+)$/.exec(hash);
  if (!match) return null;

  const tabId = Number(match[1]);
  return Number.isSafeInteger(tabId) ? tabId : null;
}

/**
 * A finished locate, as the popup keeps it.
 *
 * `ComponentSource` and the count come straight off `LocateResult` — they are
 * what `resultCard()` renders, and re-deriving either would be a second answer.
 * The host and the timestamp are added because this outlives the window that
 * produced it: reopened tomorrow, a card with no page and no time is a path with
 * no idea whether it is still the one you wanted.
 */
export interface Located {
  component: string;
  source: ComponentSource;
  resourcesSearched: number;
  /** The page it was picked on. Empty when the URL would not parse. */
  host: string;
  at: number;
}

export function toLocated(result: LocateResult, host: string, at: number): Located {
  return {
    component: result.component,
    source: result.source,
    resourcesSearched: result.resourcesSearched,
    host,
    at,
  };
}

/**
 * What survived in storage, or nothing.
 *
 * Validated rather than trusted even though this extension wrote it: the shape
 * belongs to a build that may be two versions old, and the failure mode of a
 * half-read record is a card rendering `undefined` where a file path goes. A
 * name and a status are the two fields every renderer here dereferences.
 */
export function parseLocated(value: unknown): Located | null {
  if (!value || typeof value !== 'object') return null;

  const record = value as Partial<Located>;
  const source = record.source;

  if (typeof record.component !== 'string' || !record.component) return null;
  if (!source || typeof source !== 'object') return null;
  if (typeof source.name !== 'string' || typeof source.status !== 'string') return null;
  if (typeof record.at !== 'number') return null;

  return {
    component: record.component,
    source,
    resourcesSearched: typeof record.resourcesSearched === 'number' ? record.resourcesSearched : 0,
    host: typeof record.host === 'string' ? record.host : '',
    at: record.at,
  };
}

/**
 * How far one locate has got.
 *
 * The two verbs are separate stages because CONTRACTS §4.2 says they are: a pick
 * can succeed where a locate fails, and the user is waiting on different things
 * during each — on themselves while picking, on the extension while locating.
 * Showing one spinner across both would say the extension was busy during the
 * half where it was the user who had not clicked yet.
 */
export type LocatePhase =
  /** Making sure the page can be picked on. */
  | 'starting'
  /** Armed. The page is waiting for a click and this window is waiting for it. */
  | 'picking'
  /** Picked. Reading the component's source and searching the page's bundles. */
  | 'locating'
  /** There is a card. */
  | 'answered'
  /** The gesture ended with nothing: Escape, a page with no React, a dead tab. */
  | 'stopped';

export interface LocateState {
  phase: LocatePhase;
  /** The component being resolved, once one is picked. */
  component: string | null;
  answer: Located | null;
  /**
   * Why nothing came back, when there is something to say.
   *
   * Null for a plain cancel — pressing Escape is not a failure, and a banner
   * explaining it would be the popup arguing with the user about a decision they
   * just made.
   */
  stopped: string | null;
}

export interface PopupInput {
  /** Which window is rendering. See `PopupSurface`. */
  surface: PopupSurface;
  /** The locate in progress. Only read on the `locate` surface. */
  locate: LocateState;
  /** The last finished locate, from storage. Only shown on the toolbar. */
  recent: Located | null;
  /** `null` while the active tab is still being resolved. */
  preflight: Preflight | null;
  recording: RecordingState;
  steps: Step[];
  /** When the live recording began, for the elapsed timer. */
  startedAt: number | null;
  /** `null` when usage has not been read yet. */
  usedBytes: number | null;
  lastError: StoredError | null;
  now: number;
  /**
   * The step count this recording warns at — the frozen `recording.warnSteps`,
   * passed in rather than read here.
   *
   * Settings are frozen for the duration of a recording, and this number is
   * advice *about the recording in progress*: a threshold that moved under a
   * running recording would tell the user their flow had become long because
   * they had opened Settings, not because they had recorded anything.
   */
  warnSteps: number;
  /**
   * `ui.errorTtlMs` — how recent a stored failure has to be to interrupt.
   *
   * An input rather than an import, for the reason `warnSteps` is one: this
   * module is pure and is driven directly by its tests, and a value read here
   * would be the compiled-in default whatever the user had chosen. Live, not
   * frozen — "is this failure still worth mentioning" is a question about now.
   */
  errorTtlMs: number;
}

export interface NoticeView {
  tone: 'info' | 'warn' | 'danger';
  title: string;
  body: string;
}

/** What the one filled button does. Absent while recording, which has its own pair. */
export interface PrimaryView {
  label: string;
  icon: 'circle-dot' | 'refresh-cw';
  disabled: boolean;
}

export interface LiveView {
  paused: boolean;
  /** `null` when the start time is unknown — an older recording, or a reload. */
  elapsedMs: number | null;
  count: number;
  /** Past `warnSteps`: advice about export weight, not a countdown to a cap. */
  long: boolean;
  lastAction: string | null;
  lastAgoMs: number | null;
}

export interface FlowView {
  count: number;
  lastAt: number | null;
  /** Data URLs, newest last, capped at THUMBNAIL_LIMIT. */
  thumbnails: string[];
  /** Steps with images beyond the ones shown. */
  extra: number;
}

/** A figure, not a proportion — `unlimitedStorage` leaves no denominator. */
export interface StorageView {
  usedBytes: number;
}

/**
 * The locate action, beside recording rather than under it.
 *
 * Disabled on the same tabs Start is disabled on, and for the same reason: both
 * need a content script, and a `chrome://` page will never have one. Offered
 * during a live recording too — picking and recording are independent switches
 * on one agent, and the picker's click is swallowed before the recorder sees it.
 */
export interface LocateAction {
  label: string;
  disabled: boolean;
}

/** What the locate window shows. Null on the toolbar, non-null on the locate surface. */
export interface LocateView {
  phase: LocatePhase;
  /** The line under the heading: what to do now, or what just happened. */
  status: string;
  /** The extension is working. Not set while the wait is on the user. */
  busy: boolean;
  /** `Cancel`, offered only while a pick is actually armed to cancel. */
  cancel: boolean;
  /** The button that arms a pick, and what it is called this time. */
  pick: { label: string } | null;
  answer: Located | null;
  notice: NoticeView | null;
}

/** Which block fills the body. Exactly one, always. */
export type PopupBody = 'loading' | 'blocked' | 'live' | 'flow' | 'empty' | 'locate';

export interface PopupView {
  surface: PopupSurface;
  body: PopupBody;
  recording: RecordingState;
  /** The tab a recording would target. `null` when blocked or still loading. */
  target: { host: string; title: string; favIconUrl?: string } | null;
  /**
   * What the target row is called, which is not the same question on the two
   * surfaces: one is about to be recorded, the other is being picked on.
   */
  targetLabel: string;
  /** The locate action, or null where there is nothing to offer it beside. */
  locateAction: LocateAction | null;
  /** The last locate, on the toolbar, when there is room to think about it. */
  recent: Located | null;
  /** The locate in progress. Non-null exactly on the locate surface. */
  locate: LocateView | null;
  /** The tab that cannot be recorded, for the blocked state's own header. */
  blocked: { title: string; url: string } | null;
  primary: PrimaryView | null;
  /** Offer to reload the tab first, so pre-Start network and console are captured. */
  offerReload: boolean;
  live: LiveView | null;
  flow: FlowView | null;
  notice: NoticeView | null;
  storage: StorageView | null;
}

/**
 * A stored failure outranks everything else the popup could say — it is usually
 * why the user opened it — but only while it is recent.
 */
function errorNotice(error: StoredError | null, now: number, ttlMs: number): NoticeView | null {
  if (!error || now - error.at > ttlMs) return null;
  return {
    tone: error.code === 'STORAGE_QUOTA' ? 'danger' : 'warn',
    title: error.code === 'STORAGE_QUOTA' ? 'The disk is full' : "That didn't save",
    body: error.message,
  };
}

function storageView(usedBytes: number | null): StorageView | null {
  return usedBytes == null ? null : { usedBytes };
}

function flowView(steps: Step[]): FlowView | null {
  if (steps.length === 0) return null;

  const withImages = steps.filter((step) => Boolean(step.screenshot));
  const thumbnails = withImages
    .slice(-THUMBNAIL_LIMIT)
    .map((step) => step.screenshot as string);

  return {
    count: steps.length,
    lastAt: steps[steps.length - 1]?.timestamp ?? null,
    thumbnails,
    extra: Math.max(0, withImages.length - thumbnails.length),
  };
}

function liveView(input: PopupInput): LiveView {
  const { steps, now, startedAt, recording, warnSteps } = input;
  const last = steps[steps.length - 1];

  return {
    paused: recording === 'paused',
    elapsedMs: startedAt == null ? null : Math.max(0, now - startedAt),
    count: steps.length,
    long: steps.length >= warnSteps,
    lastAction: last?.action ?? null,
    lastAgoMs: last ? Math.max(0, now - last.timestamp) : null,
  };
}

/**
 * The notice explaining a tab the extension has not attached to.
 *
 * Not an error: pressing Start injects the scripts and recording works. What it
 * cannot recover is the network and console activity from before that moment,
 * which is worth one sentence rather than a silent gap in the flow.
 */
const ATTACH_NOTICE: NoticeView = {
  tone: 'info',
  title: 'This tab opened before DevFlow did',
  body: "DevFlow will attach when you start. Network calls and console output from before then can't be captured — reload first if you need them.",
};

/** Frozen in CONTRACTS §4.4, both of them, and this is the whole of the choice. */
const PICK_LABEL = 'Pick component';
const PICK_AGAIN_LABEL = 'Pick another';
const LOCATE_LABEL = 'Locate component';

/**
 * Can a component be picked on this tab?
 *
 * The same question Start asks, because it has the same answer: both need the
 * content script, `needs-attach` means it is one injection away, and `blocked`
 * means it never will be. Unknown — the probe has not come back — reads as no,
 * so the action is enabled by evidence rather than by default.
 */
function canPick(preflight: Preflight | null): boolean {
  return preflight?.status === 'ready' || preflight?.status === 'needs-attach';
}

/**
 * The locate window, phase by phase.
 *
 * The status line is the only place the mechanism is admitted to, and it is
 * admitted to exactly once: *this window stays open for the answer*. That
 * sentence is there because the alternative is a user who clicks the page,
 * watches the popup vanish, and has no reason to believe anything is still
 * listening. Everything else about detached windows is the extension's problem.
 */
function locateView(state: LocateState): LocateView {
  const idle = { busy: false, cancel: false, answer: null, notice: null };

  switch (state.phase) {
    case 'starting':
      return { ...idle, phase: state.phase, status: 'Getting the page ready.', busy: true, pick: null };

    case 'picking':
      return {
        ...idle,
        phase: state.phase,
        status: 'Click a component on the page. This window stays open for the answer.',
        cancel: true,
        pick: null,
      };

    case 'locating':
      return {
        ...idle,
        phase: state.phase,
        status: state.component
          ? `Finding where ${state.component} was written.`
          : 'Finding where it was written.',
        busy: true,
        pick: null,
      };

    case 'answered':
      return {
        ...idle,
        phase: state.phase,
        status: state.answer?.host ? `Picked on ${state.answer.host}.` : 'Picked from the page.',
        pick: { label: PICK_AGAIN_LABEL },
        answer: state.answer,
      };

    case 'stopped':
      return {
        ...idle,
        phase: state.phase,
        status: 'Nothing picked.',
        // `Pick another` belongs over a result. With nothing on screen the
        // offer is the first one again, which is also what it will do.
        pick: { label: state.answer ? PICK_AGAIN_LABEL : PICK_LABEL },
        answer: state.answer,
        notice: state.stopped
          ? { tone: 'warn', title: 'That pick found nothing', body: state.stopped }
          : null,
      };
  }
}

export function derivePopupView(input: PopupInput): PopupView {
  const { preflight, recording, steps, lastError, now, usedBytes, surface } = input;

  const storage = storageView(usedBytes);
  const error = errorNotice(lastError, now, input.errorTtlMs);

  const base = {
    surface,
    recording,
    targetLabel: surface === 'locate' ? 'This tab' : 'Recording target',
    locateAction: null,
    recent: null,
    locate: null,
  };

  /*
   * The locate window shows one thing.
   *
   * Not the recording controls, even with a recording running: this window was
   * opened for one gesture, it is a few hundred pixels of screen, and a Stop
   * button beside a live picker is a click away from ending a recording the user
   * was only trying to locate inside of. The brand dot still carries the
   * recording state, as it does everywhere.
   */
  if (surface === 'locate') {
    return {
      ...base,
      body: 'locate',
      target: preflight?.status === 'blocked' ? null : (preflight?.target ?? null),
      blocked: null,
      primary: null,
      offerReload: false,
      live: null,
      flow: null,
      notice: error,
      storage: null,
      locate: locateView(input.locate),
    };
  }

  // A live recording follows the user across tabs, so it outranks whatever the
  // active tab happens to be — including a chrome:// page they just switched to.
  if (recording !== 'idle') {
    return {
      ...base,
      body: 'live',
      target: preflight?.status === 'blocked' ? null : (preflight?.target ?? null),
      blocked: null,
      primary: null,
      offerReload: false,
      live: liveView(input),
      flow: null,
      notice: error,
      storage,
      // Offered, but not on a tab that cannot take a content script — which is
      // the same test Start uses, asked of the tab rather than the recording.
      locateAction: { label: LOCATE_LABEL, disabled: !canPick(preflight) },
      // A recording in progress is what this window is for while it lasts. The
      // last locate is still one click away in its own window.
      recent: null,
    };
  }

  if (preflight === null) {
    return {
      ...base,
      body: 'loading',
      target: null,
      blocked: null,
      primary: null,
      offerReload: false,
      live: null,
      flow: null,
      notice: null,
      storage: null,
    };
  }

  if (preflight.status === 'blocked') {
    return {
      ...base,
      body: 'blocked',
      target: null,
      blocked: { title: preflight.title, url: preflight.url },
      primary: { label: 'Start recording', icon: 'circle-dot', disabled: true },
      offerReload: false,
      live: null,
      flow: null,
      notice: {
        tone: 'warn',
        title: "DevFlow can't record this tab",
        body: preflight.error.message,
      },
      storage,
      locateAction: { label: LOCATE_LABEL, disabled: true },
      // Still shown: it is a component from another page, and this tab being
      // unpickable says nothing about whether that answer is still wanted.
      recent: input.recent,
    };
  }

  const needsAttach = preflight.status === 'needs-attach';
  const flow = flowView(steps);

  return {
    ...base,
    body: flow ? 'flow' : 'empty',
    target: preflight.target,
    blocked: null,
    primary: { label: 'Start recording', icon: 'circle-dot', disabled: false },
    offerReload: needsAttach,
    live: null,
    flow,
    // A real failure is more urgent than an explanation of what will be missing.
    notice: error ?? (needsAttach ? ATTACH_NOTICE : null),
    storage,
    locateAction: { label: LOCATE_LABEL, disabled: false },
    recent: input.recent,
  };
}
