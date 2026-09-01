/**
 * The judgement made on two readings of a fiber tree.
 *
 * Two claims, and the first is the one worth the file. **`wasted` must never be
 * asserted on an observation that was cut**: a component reported as needlessly
 * re-rendering when in fact its own state moved sends a reader to delete a
 * `memo()` that was doing its job, and a bounded value is exactly the case
 * where "nothing changed" is a statement about the cap rather than about the
 * app. The second: the budget must not eat the wasted renders, which is what
 * the obvious most-changes-first ordering does — silently, and worst on the
 * busiest steps, which are the steps somebody is looking at because something
 * is slow.
 */

import { describe, expect, it } from 'vitest';
import { blame, type RenderObservation } from '../src/core/render/index.js';

const BUDGET = { maxComponents: 25, maxChanges: 8 };

function observed(over: Partial<RenderObservation> = {}): RenderObservation {
  return { component: 'c1', props: [], hooks: [], contexts: [], bounded: false, ...over };
}

describe('what re-rendered, and what it is worth saying about it', () => {
  it('says nothing at all when nothing re-rendered', () => {
    // Not an empty list of empty entries: a step where nothing re-rendered
    // carries no renders, the way a step where no store moved carries no state.
    expect(blame([], BUDGET)).toEqual({ renders: [] });
  });

  it('reports the changed props, hooks and contexts it was given', () => {
    const { renders } = blame(
      [
        observed({
          props: [{ key: 'items', before: 1, after: 2 }],
          hooks: [{ key: 'hook 1', before: false, after: true }],
          contexts: [{ key: 'ThemeContext', before: 'light', after: 'dark' }],
        }),
      ],
      BUDGET,
    );

    expect(renders).toEqual([
      {
        component: 'c1',
        props: [{ key: 'items', before: 1, after: 2 }],
        hooks: [{ key: 'hook 1', before: false, after: true }],
        contexts: [{ key: 'ThemeContext', before: 'light', after: 'dark' }],
      },
    ]);
    // Nothing here is wasted: three things changed.
    expect(renders[0].wasted).toBeUndefined();
  });

  it('calls a render wasted when it saw everything and nothing had moved', () => {
    const { renders } = blame([observed()], BUDGET);
    expect(renders).toEqual([{ component: 'c1', wasted: true }]);
  });
});

describe('the claim that must not be made on a cut observation', () => {
  /**
   * The failure this whole file exists for.
   *
   * A bounded observation is one where a value was too large or too circular to
   * snapshot, so it was never compared. "Nothing changed" under a value nobody
   * looked at is a claim about the cap. The component is still reported — it
   * did re-render — but the claim the evidence cannot carry is withheld.
   */
  it('refuses wasted on a bounded observation, and still reports the render', () => {
    const { renders } = blame([observed({ bounded: true })], BUDGET);
    expect(renders).toEqual([{ component: 'c1', bounded: true }]);
    expect(renders[0].wasted).toBeUndefined();
  });

  it('keeps wasted for the unbounded component beside the bounded one', () => {
    const { renders } = blame(
      [observed({ component: 'cut', bounded: true }), observed({ component: 'clean' })],
      BUDGET,
    );
    const byId = Object.fromEntries(renders.map((r) => [r.component, r]));
    expect(byId.clean.wasted).toBe(true);
    expect(byId.cut.wasted).toBeUndefined();
  });
});

describe('what survives the budget', () => {
  /**
   * Ordering by change count is the obvious rule and it is the wrong one: a
   * wasted render has no changes by definition, so most-changes-first drops
   * every one of them first. This is the test that goes red on that ordering.
   */
  it('keeps the wasted renders when the component budget cannot hold everything', () => {
    const busy = Array.from({ length: 30 }, (_, i) =>
      observed({ component: `busy-${i}`, props: [{ key: 'x', before: i, after: i + 1 }] }),
    );
    const { renders, note } = blame([...busy, observed({ component: 'wasteful' })], {
      maxComponents: 5,
      maxChanges: 8,
    });

    expect(renders).toHaveLength(5);
    expect(renders[0]).toEqual({ component: 'wasteful', wasted: true });
    expect(note).toContain('26 more components re-rendered');
  });

  it('orders the rest by how much was observed to change', () => {
    const { renders } = blame(
      [
        observed({ component: 'one', props: [{ key: 'a' }] }),
        observed({
          component: 'three',
          props: [{ key: 'a' }, { key: 'b' }],
          hooks: [{ key: 'hook 1' }],
        }),
        observed({ component: 'two', props: [{ key: 'a' }], hooks: [{ key: 'hook 1' }] }),
      ],
      BUDGET,
    );
    expect(renders.map((r) => r.component)).toEqual(['three', 'two', 'one']);
  });

  it('breaks a tie on the component id, so two runs over one recording agree', () => {
    const { renders } = blame(
      [observed({ component: 'b' }), observed({ component: 'a' }), observed({ component: 'c' })],
      BUDGET,
    );
    expect(renders.map((r) => r.component)).toEqual(['a', 'b', 'c']);
  });

  it('counts the changes it dropped rather than showing eight and implying that was all', () => {
    const { renders } = blame(
      [
        observed({
          props: Array.from({ length: 10 }, (_, i) => ({ key: `p${i}` })),
          hooks: [{ key: 'hook 1' }],
        }),
      ],
      { maxComponents: 25, maxChanges: 8 },
    );

    expect(renders[0].props).toHaveLength(8);
    // Props first, so the hook loses to them and is counted rather than shown.
    expect(renders[0].hooks).toBeUndefined();
    expect(renders[0].moreChanges).toBe(3);
    // Eleven changes were seen; a component with changes is never wasted.
    expect(renders[0].wasted).toBeUndefined();
  });

  it('says how many components the step could not report', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      observed({ component: `c${i}`, props: [{ key: 'x' }] }),
    );
    const { note } = blame(many, { maxComponents: 3, maxChanges: 8 });
    expect(note).toContain('5 more components re-rendered');
    expect(note).toContain('3-component budget');
  });

  it('says nothing about a budget that was not spent', () => {
    expect(blame([observed()], BUDGET).note).toBeUndefined();
  });
});
