/** Operations on a flow's step list. Pure — no storage, no Chrome APIs. */

import type { ConsoleEntry, ConsoleLevel, NetworkCall, Step, StepType } from '../../shared/types.js';

/**
 * Re-derive `stepNumber` from position.
 *
 * The recorder stamps a number at capture time, so deleting a step used to leave
 * exports numbered 1, 2, 4. Numbering is a function of order, so it is derived
 * on the way out rather than stored and maintained.
 */
export function renumber(steps: Step[]): Step[] {
  return steps.map((step, i) => ({ ...step, stepNumber: i + 1 }));
}

/** Two-digit zero-padded string, for `step-01.jpg`. */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Strip characters that are illegal in filenames on any of the big three. */
export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|]/g, '')
      .trim()
      .replace(/^\.+|\.+$/g, '') || 'flowsnap-flow'
  );
}

/** Default export filename: `flowsnap-flow-2026-08-15`. */
export function defaultFilename(now = new Date()): string {
  return `flowsnap-flow-${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Millisecond delta as `+1.2s` or `+1m 3s`. Empty string for negative deltas. */
export function formatDelta(ms: number): string {
  if (ms < 0) return '';
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `+${minutes}m ${seconds}s`;
}

/** The first URL in the flow, used as the MCP payload's `startUrl`. */
export function startUrl(steps: Step[]): string | undefined {
  return steps[0]?.url;
}

/** Pathname (+ search) of a URL, for compact page-change markers. */
export function urlPath(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Host of the first URL we can parse. One unparseable URL must not blank it. */
export function flowHost(steps: Step[]): string {
  for (const step of steps) {
    if (!step.url) continue;
    try {
      return new URL(step.url).host;
    } catch {
      // Keep looking.
    }
  }
  return '';
}

/**
 * A step wearing a screenshot the user supplied instead of one we captured.
 *
 * Three fields move together, which is why this is a function rather than a
 * spread at the call site:
 *
 *   - `screenshotOriginal` goes. It is the un-annotated base the image editor
 *     draws from, and leaving the old one behind means opening the annotator on
 *     a replaced step silently reverts to the picture that was replaced.
 *   - `highlightBox` goes. It is in the capture's coordinate space, so against
 *     a different image it marks an arbitrary rectangle.
 *   - `screenshotImported` is set, because a screenshot is read everywhere as
 *     evidence of what the page looked like, and for this one that is a claim
 *     nobody checked.
 *
 * Pure — see tests/screenshot-import.test.ts.
 */
export function withImportedScreenshot(step: Step, dataUrl: string): Step {
  const next: Step = { ...step, screenshot: dataUrl, screenshotImported: true };
  delete next.screenshotOriginal;
  next.highlightBox = null;
  return next;
}

/**
 * A name for one step that survives a round trip through storage.
 *
 * Identity, never index: the worker appends while the viewer is editing, so
 * position 3 is not a name two readers will agree on. Two steps are the same
 * step if they happened at the same moment in the same way.
 *
 * Lives here rather than beside either of its callers because both of them —
 * `writeCurrent`'s merge and the screenshot side-table — must key on exactly
 * the same string, and a second copy of this rule is a silent way for a step's
 * image to end up filed under a name nothing looks for.
 */
export function stepKey(step: Pick<Step, 'timestamp' | 'type'>): string {
  return `${step.timestamp}:${step.type}`;
}

/**
 * Console and network activity that no step ever claimed.
 *
 * Handed over by each recorded tab when a recording stops — see `FLUSH_PENDING`.
 */
export interface Pending {
  consoleLogs?: ConsoleEntry[];
  networkCalls?: NetworkCall[];
  url?: string;
  title?: string;
}

/**
 * Merge what every tab was still holding into one trailing step's worth, or
 * `null` when there is nothing to say.
 *
 * A recording follows the user across tabs, so the request that failed may have
 * been issued by one they had already left — every tab is asked, and the answers
 * arrive in whatever order they came back. Sorted by clock afterwards, because a
 * stack trace printed *before* a request failed is a different story from one
 * printed after it, and tab response order is not a story at all.
 *
 * `url` is taken from the first tab that actually had something, not from the
 * first that answered: the page this activity belongs to is the page that
 * produced it.
 */
export function mergeTrailing(answers: (Pending | null | undefined)[]): {
  consoleLogs: ConsoleEntry[];
  networkCalls: NetworkCall[];
  url?: string;
} | null {
  const consoleLogs: ConsoleEntry[] = [];
  const networkCalls: NetworkCall[] = [];
  let url: string | undefined;

  for (const answer of answers) {
    if (!answer) continue;
    const logs = answer.consoleLogs ?? [];
    const calls = answer.networkCalls ?? [];
    if (logs.length === 0 && calls.length === 0) continue;

    consoleLogs.push(...logs);
    networkCalls.push(...calls);
    url ??= answer.url;
  }

  if (consoleLogs.length === 0 && networkCalls.length === 0) return null;

  consoleLogs.sort((a, b) => a.timestamp - b.timestamp);
  networkCalls.sort((a, b) => a.timestamp - b.timestamp);

  return { consoleLogs, networkCalls, ...(url ? { url } : {}) };
}

// ── Reading failure out of a step ────────────────────────────────────────────

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

/**
 * Which band an HTTP status falls in. A `null` status is a request that never
 * got a response at all, which is a failure of the same weight as a 5xx and is
 * reported as one — the alternative is a call that looks fine because it has no
 * number to colour.
 */
export function statusClass(status: number | null): StatusClass {
  if (status == null || status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

/**
 * Did this one call fail?
 *
 * `statusClass` folds a missing status into `5xx` for colouring, which is right
 * for a rail tick and wrong for a filter: `worstStatus(calls) === '5xx'` is true
 * of a step where every call succeeded except one that never landed, and says
 * nothing about *which* call that was. Anything that needs the call itself —
 * the MCP payload deciding whose body to keep, the server listing what broke —
 * reads this instead, and reads the same rule the server does.
 */
export function callFailed(call: NetworkCall): boolean {
  return call.status === null || call.status >= 400;
}

/** The most severe status among a step's network calls, or `null` if it made none. */
export function worstStatus(calls: NetworkCall[] | undefined): StatusClass | null {
  const order: StatusClass[] = ['2xx', '3xx', '4xx', '5xx'];
  let worst: StatusClass | null = null;

  for (const call of calls ?? []) {
    const band = statusClass(call.status);
    if (worst === null || order.indexOf(band) > order.indexOf(worst)) worst = band;
  }

  return worst;
}

const LEVEL_SEVERITY: Record<ConsoleLevel, number> = {
  debug: 0,
  log: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** The most severe console level a step captured, or `null` if it captured none. */
export function worstLevel(logs: { level: ConsoleLevel }[] | undefined): ConsoleLevel | null {
  let worst: ConsoleLevel | null = null;
  for (const log of logs ?? []) {
    if (worst === null || LEVEL_SEVERITY[log.level] > LEVEL_SEVERITY[worst]) worst = log.level;
  }
  return worst;
}

/**
 * Did something go wrong during this step?
 *
 * This is the single definition of "failed", and the rail's red tick, the card's
 * crimson edge, the Errors filter and the library's error count all read it —
 * so a step cannot be a failure in one place and fine in another.
 */
export function stepFailed(step: Step): boolean {
  const status = worstStatus(step.networkCalls);
  if (status === '4xx' || status === '5xx') return true;
  return worstLevel(step.consoleLogs) === 'error';
}

/** How many steps of each type, for the library row's chips. */
export function countByType(steps: Step[]): Partial<Record<StepType, number>> {
  const counts: Partial<Record<StepType, number>> = {};
  for (const step of steps) counts[step.type] = (counts[step.type] ?? 0) + 1;
  return counts;
}

/** How many steps carry a failure. */
export function countFailures(steps: Step[]): number {
  return steps.reduce((total, step) => total + (stepFailed(step) ? 1 : 0), 0);
}
