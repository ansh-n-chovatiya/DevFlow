import { describe, expect, it } from 'vitest';
import { preferResolution, type Resolution } from '../src/core/locate/adapter.js';
import { pos1 } from '../src/core/locate/positions.js';

const declared: Resolution = {
  kind: 'declared',
  name: 'Counter',
  source: 'src/Counter.svelte',
  line: pos1(5),
};
const searchable: Resolution = {
  kind: 'searchable',
  name: 'Counter',
  fnSource: 'function Counter(){ return null }',
};
const absent: Resolution = {
  kind: 'absent',
  reason: 'stripped-by-build',
  detail: 'This production build removed the element-to-component link.',
};

describe('preferResolution', () => {
  /*
   * The whole reason `declared` is an arm of its own. Svelte's `__svelte_meta`
   * and Vue's `type.__file` are the runtime handing over the answer; searching
   * the bundle for it instead spends a fetch, a map decode and a search to
   * arrive somewhere less certain. Measured: the dev SFC map has no segment on
   * declaration lines at all, so the search can lose to a fact already in hand.
   */
  it('prefers what the runtime declared over what could be searched for', () => {
    expect(preferResolution(searchable, declared)).toBe(declared);
    expect(preferResolution(declared, searchable)).toBe(declared);
  });

  it('prefers a searchable function over an absence', () => {
    expect(preferResolution(absent, searchable)).toBe(searchable);
    expect(preferResolution(searchable, absent)).toBe(searchable);
  });

  /*
   * Ties keep the incumbent rather than the newcomer. Two `declared` answers
   * for one element means two runtimes both claim it — a React island inside a
   * Vue page — and silently swapping which one wins per call would make the
   * component a step is attributed to depend on walk order.
   */
  it('keeps the first answer when both rank equally', () => {
    const other: Resolution = { ...declared, name: 'Other' };
    expect(preferResolution(declared, other)).toBe(declared);
  });
});

describe('the absent arm', () => {
  /*
   * A silence reads as "this element has no component", which is false. The
   * three reasons are told apart because they have three different fixes, and
   * `not-hydrated` is the one that fixes itself.
   */
  it('carries a reason a reader can act on', () => {
    expect(absent.kind === 'absent' && absent.reason).toBe('stripped-by-build');
    expect(absent.kind === 'absent' && absent.detail.length).toBeGreaterThan(0);
  });
});
