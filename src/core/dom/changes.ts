/**
 * Turning what a MutationObserver saw into a statement about what one
 * interaction did to the document.
 *
 * The impure half — attaching the observer, deciding when the window opens and
 * closes, reading a selector or an attribute value off a live node — belongs to
 * `content/index.ts`, which is the only place that has a DOM. What is here is
 * the judgement made on what it saw: which changes are worth the recording's
 * budget, in what order when the budget cannot hold them all, and what the step
 * says about the ones it dropped.
 *
 * ## Two budgets, and they bound different things
 *
 * The reverted v3.2.0 attempt pushed every `MutationRecord` on the document
 * into an array with no cap and no throttle. Replacing that needs two numbers,
 * not one, because there are two costs and they are not the same cost:
 *
 *   - `recording.domMutationCap` bounds the **work**: how many records one
 *     step's observer will look at before it disconnects itself. That is
 *     enforced in the observer callback, where the work is, and it is why a
 *     page running a sixty-frames-a-second transition costs a recording the cap
 *     rather than the page.
 *   - `recording.domMaxChanges` bounds the **recording**: how many distinct
 *     changes one step may print. That is enforced here, after folding, and it
 *     is a far smaller number because a hundred records are very often one
 *     fact.
 *
 * A single number could not do both. Set low enough to keep a step readable it
 * would stop watching after a dozen records, and the first attribute the page
 * animated would end the window; set high enough to watch a real interaction it
 * would print four hundred lines.
 *
 * ## What survives the budget, and why it is not the busiest
 *
 * By kind, then by when it was first seen — never by count. Two reasons, and
 * the first is the one that matters:
 *
 * A count is a measure of how *noisy* something was, not of how *interesting*.
 * The dialog that mounted is one record; the CSS transition that ran on the
 * button behind it is sixty. Ordering by count puts the transition first and
 * spends the whole budget on it, and it does that worst on exactly the steps
 * somebody opened because something happened — which is the same trap
 * `core/render/blame.ts` documents for wasted renders, in a different tree.
 *
 * Within a kind, first-seen order is temporal order: mutation records arrive in
 * the order the mutations happened, so the first structural change after a
 * click is the one most likely to *be* what the click did. Nothing here sorts
 * on the content of a change, so two runs over one recording agree.
 *
 * Pure — no DOM, no Chrome, no clock, no randomness.
 */

import type { DomChange, DomChangeKind } from '../../shared/types.js';

/**
 * One folded group of mutations, as the observer saw it.
 *
 * `count` is how many records folded in and is at least one. `attribute` is the
 * bare attribute name, carried separately from `what` — which holds the name
 * *and* the value it settled at — because the ranking below needs to recognise
 * `style` and parsing it back out of a formatted string is the kind of thing
 * that works until an attribute value contains an `=`.
 */
export interface DomObservation {
  kind: DomChangeKind;
  where: string;
  what?: string;
  /** Only on an `attribute` observation, and then always. */
  attribute?: string;
  count: number;
}

export interface DomChangeBudget {
  /** Distinct changes one step may report. */
  maxChanges: number;
}

export interface DomChangePlan {
  changes: DomChange[];
  /** Distinct changes that were observed and did not fit. Absent when none. */
  more?: number;
}

/**
 * The order the budget is spent in. Lower is kept first.
 *
 * Structure before content before styling, which is the order of how much a
 * change tells a reader who was not watching. A dialog that mounted or a row
 * that vanished is the interaction's effect; the text an element settled on is
 * usually the same effect seen from closer up; an attribute is the app's own
 * bookkeeping, and `style` is the half of that bookkeeping a transition writes
 * sixty times a second while telling nobody anything.
 *
 * `style` is singled out rather than attributes in general because the two are
 * not the same thing at all: `aria-expanded`, `disabled` and `hidden` are the
 * whole story of a menu, a form or a modal, and demoting them with `style`
 * would lose the story to the noise it is being distinguished from.
 */
function rank(observed: DomObservation): number {
  if (observed.kind === 'added' || observed.kind === 'removed') return 0;
  if (observed.kind === 'text') return 1;
  return observed.attribute === 'style' ? 3 : 2;
}

/**
 * What one step reports of what it saw, bounded to a budget.
 *
 * `observed` arrives folded and in first-seen order — the observer folds
 * because folding is what keeps the callback cheap, and the order is the order
 * each group was *first* seen, not last. The sort below is stable, so
 * first-seen order survives inside each rank.
 */
export function planDomChanges(
  observed: readonly DomObservation[],
  budget: DomChangeBudget,
): DomChangePlan {
  if (!observed.length) return { changes: [] };

  const ranked = [...observed].sort((a, b) => rank(a) - rank(b));

  const cap = Math.max(0, budget.maxChanges);
  const kept = ranked.slice(0, cap);

  const changes: DomChange[] = kept.map((entry) => ({
    kind: entry.kind,
    where: entry.where,
    ...(entry.what ? { what: entry.what } : {}),
    // One record is what a reader assumes, so saying it costs tokens to
    // confirm what absence already says.
    ...(entry.count > 1 ? { count: entry.count } : {}),
  }));

  const over = observed.length - kept.length;
  return { changes, ...(over > 0 ? { more: over } : {}) };
}
