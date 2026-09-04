/**
 * How long a replayed step is allowed to take.
 *
 * Both generators used to emit their actions back to back at their runner's
 * defaults — five seconds for a Playwright action, four for a Cypress query,
 * thirty for a whole Playwright test. Those are sized for a test somebody wrote
 * against an app they can start locally. A recorded flow is neither: it ran
 * against a real deployment, where a click frequently starts a fetch whose
 * result is what the *next* step needs, and where five seconds is an ordinary
 * amount of time for that to take. Replayed at the defaults, such a spec fails
 * on a page that is merely slow — which reads as "the export is broken" rather
 * than "give it another second".
 *
 * The steps carried `timestamp` the whole time. Nothing read it.
 *
 * A long timeout costs nothing when a step passes: both runners poll and
 * proceed the moment the element is ready, so the budget is only ever spent on
 * a step that was going to fail anyway.
 *
 * The floors matter more than the multiplier. A recorded gap is human think
 * time as much as it is the application's, so it is a poor estimator in both
 * directions: a 200ms gap does not mean the app is reliably ready in 200ms, and
 * a 40s pause usually means somebody answered the door. The floor covers the
 * first, the ceiling the second.
 *
 * Pure, like everything under `src/core/`.
 */

import type { Step } from '../../shared/types.js';

const GAP_MULTIPLIER = 2;

export const ACTION_FLOOR_MS = 15_000;
export const ACTION_CEILING_MS = 60_000;
export const NAVIGATION_FLOOR_MS = 30_000;
export const NAVIGATION_CEILING_MS = 120_000;

/** Headroom for the fixed cost of a run: browser launch, context, first paint. */
export const TEST_OVERHEAD_MS = 30_000;
export const TEST_FLOOR_MS = 60_000;

/** Below this a gap is noise, and a line stating it is noise in the spec. */
export const GAP_WORTH_STATING_MS = 1_000;

/**
 * The wait a step is replayed with, in milliseconds.
 *
 * `gapMs` is the time between the previous step and this one. It is untrusted
 * arithmetic on two recorded clocks — a flow read back from storage is not
 * guaranteed to carry both timestamps — so a non-finite result falls back to
 * the floor rather than propagating `NaN` into the emitted source. A spec
 * holding `{ timeout: NaN }` fails every step for a reason nobody would guess
 * from reading it.
 */
export function stepBudget(gapMs: number, floor: number, ceiling: number): number {
  if (!Number.isFinite(gapMs) || gapMs <= 0) return floor;
  const scaled = Math.ceil((gapMs * GAP_MULTIPLIER) / 1000) * 1000;
  return Math.min(ceiling, Math.max(floor, scaled));
}

/** The gap before each step, index-aligned with `steps`. The first is zero. */
export function gapsBefore(steps: Step[]): number[] {
  return steps.map((step, index) => {
    if (index === 0) return 0;
    const delta = step.timestamp - steps[index - 1].timestamp;
    return Number.isFinite(delta) && delta > 0 ? delta : 0;
  });
}

/** The budget for one step, given its kind. Navigation is allowed longer. */
export function budgetFor(step: Step, gapMs: number): number {
  return step.type === 'navigate'
    ? stepBudget(gapMs, NAVIGATION_FLOOR_MS, NAVIGATION_CEILING_MS)
    : stepBudget(gapMs, ACTION_FLOOR_MS, ACTION_CEILING_MS);
}

/**
 * Long enough for every step to spend its own budget.
 *
 * A runner's whole-test timeout kills the run while an individual step is still
 * legitimately waiting inside its own, and the failure it reports is the test
 * timeout — which points at the last step rather than at the slow one, and
 * reads as flakiness.
 */
export function testBudget(steps: Step[], gaps: number[]): number {
  const total = steps.reduce(
    (sum, step, index) => (step.type === 'note' ? sum : sum + budgetFor(step, gaps[index])),
    0,
  );
  return Math.max(TEST_FLOOR_MS, total + TEST_OVERHEAD_MS);
}

/** `2.4s`, for a comment. Whole seconds lose the distinction that matters. */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
