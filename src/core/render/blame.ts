/**
 * Turning two readings of a fiber tree into a statement about what re-rendered.
 *
 * The impure half — walking the tree, reading `memoizedProps`, deciding when to
 * sample — belongs to `injected/render.ts`. What is here is the judgement made
 * on what it saw: which components are worth reporting, in what order when the
 * budget cannot hold them all, and the one claim in this feature that can be
 * wrong in a way nobody notices.
 *
 * ## `wasted` is a claim about the observation, not about the app
 *
 * A wasted render — a component re-rendered and every value it was handed is
 * the value it already had — is the actionable finding here, and it is also the
 * easiest thing to assert falsely. It is only true if *everything* that could
 * have changed was looked at: the props, the component's own hook state, and
 * the contexts its fiber depended on. Miss any one of those and the tool
 * reports a component as needlessly re-rendering when in fact its own
 * `useState` moved, which sends a reader to delete a `memo()` that was doing
 * its job.
 *
 * So `wasted` is refused whenever the observation was cut. A `bounded`
 * observation is one where a value was too large or too circular to snapshot,
 * and "nothing changed" under a cut value is a statement about the cap. The
 * component is still reported — it did re-render, and that is a fact — but
 * without the claim the evidence does not support.
 *
 * ## What survives the budget, and why it is not the busiest
 *
 * The obvious order is most-changes-first. It is wrong here: a wasted render
 * has *no* changes by definition, so ordering by change count drops exactly the
 * findings this evaluator exists to surface, and does it silently on the steps
 * with the most going on — which are the steps somebody is looking at because
 * something is slow.
 *
 * Wasted renders therefore come first, then the rest by how much was observed
 * to change. Ties break on the component id so two runs over one recording
 * agree; nothing here reads a clock or a random.
 *
 * Pure — no DOM, no Chrome, no clock, no randomness.
 */

import type { RenderChange, StepRender } from '../../shared/types.js';

/** One key whose value differed between the two readings. */
export interface RenderSampleChange {
  key: string;
  before?: unknown;
  after?: unknown;
}

/**
 * What the walk saw of one component that re-rendered.
 *
 * Every component handed to `blame` re-rendered: the walk only emits one whose
 * `memoizedProps` reference changed between the readings. So the three lists
 * being empty is not "nothing happened" — it is a wasted render, which is the
 * whole point of passing it along rather than dropping it in the page.
 */
export interface RenderObservation {
  /** Component id, keyed as `FlowReact.components` keys it. */
  component: string;
  props: RenderSampleChange[];
  hooks: RenderSampleChange[];
  contexts: RenderSampleChange[];
  /** A value was cut at a snapshot cap, so what was compared is not the value. */
  bounded: boolean;
}

export interface RenderBudget {
  /** Components one step may report. */
  maxComponents: number;
  /** Changed props, hooks and contexts reported for one component, across all three. */
  maxChanges: number;
}

export interface BlameResult {
  renders: StepRender[];
  /** What the budget cost this step, in the words a reader needs. */
  note?: string;
}

/** Total observed changes, which is what the budget is spent on and sorted by. */
function changeCount(observed: RenderObservation): number {
  return observed.props.length + observed.hooks.length + observed.contexts.length;
}

/**
 * The changes of one component, capped across all three kinds together.
 *
 * Together rather than a cap each, because the reader's budget is one list and
 * a component with forty changed props and no hooks should not be given three
 * separate allowances it cannot use. Props first, then hooks, then contexts:
 * props are what a caller can act on without reading the component, and a
 * component whose props changed rarely needs its hook list to explain it.
 */
function capChanges(
  observed: RenderObservation,
  maxChanges: number,
): { props: RenderChange[]; hooks: RenderChange[]; contexts: RenderChange[]; dropped: number } {
  const budget = Math.max(0, maxChanges);
  let left = budget;

  const take = (changes: RenderSampleChange[]): RenderChange[] => {
    const kept = changes.slice(0, left);
    left -= kept.length;
    return kept.map((change) => ({
      key: change.key,
      ...('before' in change ? { before: change.before } : {}),
      ...('after' in change ? { after: change.after } : {}),
    }));
  };

  const props = take(observed.props);
  const hooks = take(observed.hooks);
  const contexts = take(observed.contexts);
  return { props, hooks, contexts, dropped: Math.max(0, changeCount(observed) - budget) };
}

/**
 * What re-rendered across one step, bounded to a budget.
 *
 * `observed` is every component the walk found with a changed props reference.
 * The order it arrives in is the walk's and carries no meaning, so this sorts
 * rather than trusting it.
 */
export function blame(
  observed: readonly RenderObservation[],
  budget: RenderBudget,
): BlameResult {
  if (!observed.length) return { renders: [] };

  /*
   * Wasted first, then by what was seen to change. See the header: sorting by
   * change count alone drops every wasted render, which is the one finding the
   * budget must not be allowed to eat.
   */
  const ranked = [...observed].sort((a, b) => {
    const wastedA = changeCount(a) === 0 && !a.bounded;
    const wastedB = changeCount(b) === 0 && !b.bounded;
    if (wastedA !== wastedB) return wastedA ? -1 : 1;
    if (changeCount(a) !== changeCount(b)) return changeCount(b) - changeCount(a);
    return a.component < b.component ? -1 : a.component > b.component ? 1 : 0;
  });

  const cap = Math.max(0, budget.maxComponents);
  const kept = ranked.slice(0, cap);

  const renders: StepRender[] = kept.map((entry) => {
    const { props, hooks, contexts, dropped } = capChanges(entry, budget.maxChanges);
    return {
      component: entry.component,
      ...(props.length ? { props } : {}),
      ...(hooks.length ? { hooks } : {}),
      ...(contexts.length ? { contexts } : {}),
      ...(dropped ? { moreChanges: dropped } : {}),
      // The refusal the header is about. An observation that was cut cannot
      // support "nothing changed", because the thing that changed may be under
      // the cut.
      ...(changeCount(entry) === 0 && !entry.bounded ? { wasted: true as const } : {}),
      ...(entry.bounded ? { bounded: true as const } : {}),
    };
  });

  const over = observed.length - kept.length;
  return {
    renders,
    ...(over > 0
      ? {
          note:
            `${over} more component${over === 1 ? '' : 's'} re-rendered than the ` +
            `${cap}-component budget for one step allows. Kept the wasted renders first, ` +
            'then the components with the most observed changes.',
        }
      : {}),
  };
}
