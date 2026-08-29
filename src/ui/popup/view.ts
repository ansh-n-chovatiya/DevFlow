/**
 * What the popup should show, derived from what is true.
 *
 * Pure: no `chrome.*`, no DOM, no clock of its own — `now` is passed in. Every
 * decision about which state the popup is in lives here and is covered by
 * tests/popup-view.test.ts, so `main.ts` is left with nothing but rendering.
 */

import type { Preflight } from '../../features/recording/preflight.js';
import type { RecordingState, Step, StoredError } from '../../shared/types.js';

/** How many screenshot thumbnails the current-flow card shows before counting. */
export const THUMBNAIL_LIMIT = 3;

export interface PopupInput {
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

/** Which block fills the body. Exactly one, always. */
export type PopupBody = 'loading' | 'blocked' | 'live' | 'flow' | 'empty';

export interface PopupView {
  body: PopupBody;
  recording: RecordingState;
  /** The tab a recording would target. `null` when blocked or still loading. */
  target: { host: string; title: string; favIconUrl?: string } | null;
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
 * The notice explaining a tab FlowSnap has not attached to.
 *
 * Not an error: pressing Start injects the scripts and recording works. What it
 * cannot recover is the network and console activity from before that moment,
 * which is worth one sentence rather than a silent gap in the flow.
 */
const ATTACH_NOTICE: NoticeView = {
  tone: 'info',
  title: 'This tab opened before FlowSnap did',
  body: "FlowSnap will attach when you start. Network calls and console output from before then can't be captured — reload first if you need them.",
};

export function derivePopupView(input: PopupInput): PopupView {
  const { preflight, recording, steps, lastError, now, usedBytes } = input;

  const storage = storageView(usedBytes);
  const error = errorNotice(lastError, now, input.errorTtlMs);

  // A live recording follows the user across tabs, so it outranks whatever the
  // active tab happens to be — including a chrome:// page they just switched to.
  if (recording !== 'idle') {
    return {
      body: 'live',
      recording,
      target: preflight?.status === 'blocked' ? null : (preflight?.target ?? null),
      blocked: null,
      primary: null,
      offerReload: false,
      live: liveView(input),
      flow: null,
      notice: error,
      storage,
    };
  }

  if (preflight === null) {
    return {
      body: 'loading',
      recording,
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
      body: 'blocked',
      recording,
      target: null,
      blocked: { title: preflight.title, url: preflight.url },
      primary: { label: 'Start recording', icon: 'circle-dot', disabled: true },
      offerReload: false,
      live: null,
      flow: null,
      notice: {
        tone: 'warn',
        title: "FlowSnap can't record this tab",
        body: preflight.error.message,
      },
      storage,
    };
  }

  const needsAttach = preflight.status === 'needs-attach';
  const flow = flowView(steps);

  return {
    body: flow ? 'flow' : 'empty',
    recording,
    target: preflight.target,
    blocked: null,
    primary: { label: 'Start recording', icon: 'circle-dot', disabled: false },
    offerReload: needsAttach,
    live: null,
    flow,
    // A real failure is more urgent than an explanation of what will be missing.
    notice: error ?? (needsAttach ? ATTACH_NOTICE : null),
    storage,
  };
}
