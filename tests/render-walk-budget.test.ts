// @vitest-environment jsdom
/**
 * What a render sample costs, and the claim `RENDER_NODE_CAP` makes.
 *
 * The first of the two walks per step runs synchronously inside the user's
 * gesture — `onStateInteraction` listens in the capture phase, ahead of React's
 * own root listener — so this number is not a memory budget or a token budget.
 * It is click latency on every interaction of every page being recorded, and
 * the reverted `v3.2.0` engine failed here specifically: it walked the whole
 * tree on every commit against a <2% CPU NFR.
 *
 * ## What is asserted, and what would be dishonest to assert
 *
 * Two different things, and only one of them is a stopwatch.
 *
 * The **bound** is exact and deterministic: whatever the tree, the walk visits
 * no more than the cap, so the work is a function of the cap and not of the
 * app. That is the property the design rests on and it is asserted as an
 * equality, not a timing.
 *
 * The **ceiling** is a tripwire, deliberately loose. A wall-clock assertion
 * tight enough to be a benchmark is an assertion that fails on a loaded CI box
 * and teaches everyone to re-run it, which is worse than no gate. This one is
 * an order of magnitude above what the walk costs, so it stays quiet on a slow
 * machine and goes red on an accidental O(n²) — a nested scan, a per-fiber
 * snapshot, a `return`-chain climb per node. That is the regression it exists
 * to catch; the honest reading of a green run here is "not quadratic", not
 * "fast".
 *
 * jsdom fibers are plain objects and a real React tree's are not, so this
 * measures the walk's own shape and never the browser's. It is the reason the
 * ceiling is where it is rather than at the real budget.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleRenders } from '../src/injected/render.js';
import { RENDER_NODE_CAP } from '../src/shared/constants.js';

/** A component function, distinct per name, as the walk expects to find one. */
function componentFn(name: string): () => null {
  const fn = (): null => null;
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

interface Node {
  type: unknown;
  memoizedProps: Record<string, unknown>;
  memoizedState?: unknown;
  dependencies?: unknown;
  child: Node | null;
  sibling: Node | null;
  return?: Node | null;
  alternate?: Node | null;
  stateNode?: unknown;
}

/**
 * A tree far larger than the cap, shaped like an app rather than like a list.
 *
 * Wide and shallow on purpose: a deep chain would be walked by any
 * implementation in linear time, and it is the breadth-first queue — the part
 * that can quietly become quadratic if siblings are rescanned — that this is
 * built to exercise.
 */
function bigTree(components: number): Node {
  const root: Node = { type: null, memoizedProps: {}, child: null, sibling: null };

  let head: Node | null = null;
  for (let i = components; i > 0; i--) {
    const node: Node = {
      type: componentFn(`Component${i}`),
      // Eight props each, which is more than most components carry and is what
      // the per-key reference read is paid on.
      memoizedProps: Object.fromEntries(
        Array.from({ length: 8 }, (_, k) => [`prop${k}`, { value: k }]),
      ),
      memoizedState: null,
      dependencies: null,
      child: null,
      sibling: head,
    };
    node.return = root;
    head = node;
  }
  root.child = head;

  const fiberRoot = { current: root };
  root.stateNode = fiberRoot;
  return root;
}

function mount(root: Node): void {
  const el = document.createElement('div');
  el.id = 'root';
  document.body.append(el);
  (el as unknown as Record<string, unknown>)['__reactContainer$abc'] = root;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('what one sample is allowed to cost', () => {
  /**
   * The property the whole design rests on: the work is a function of the cap,
   * not of the page. An app with fifty thousand fibers pays exactly what an app
   * with two thousand pays.
   */
  it('reads no more components than the cap, whatever the page is holding', () => {
    mount(bigTree(RENDER_NODE_CAP * 4));
    const sample = sampleRenders(RENDER_NODE_CAP);

    expect(sample.capped).toBe(true);
    expect(sample.entries.length).toBeLessThanOrEqual(RENDER_NODE_CAP);
  });

  it('does not claim it was cut when the tree fitted', () => {
    // Comfortably under, so the walk finishes and has nothing to warn about.
    mount(bigTree(Math.floor(RENDER_NODE_CAP / 3)));
    const sample = sampleRenders(RENDER_NODE_CAP);

    expect(sample.capped).toBe(false);
    expect(sample.entries).toHaveLength(Math.floor(RENDER_NODE_CAP / 3));
  });

  /**
   * The tripwire. See the header for why it is loose: this goes red on a walk
   * that has become quadratic, and stays quiet on a machine that is merely
   * busy.
   */
  it('stays linear in the cap rather than in the tree', () => {
    mount(bigTree(RENDER_NODE_CAP * 8));

    const started = performance.now();
    for (let i = 0; i < 10; i++) sampleRenders(RENDER_NODE_CAP);
    const perSample = (performance.now() - started) / 10;

    expect(perSample).toBeLessThan(120);
  });

  /**
   * The same walk over a tree eight times larger costs the same, because the
   * cap and not the tree decides. A walk that scanned siblings repeatedly, or
   * climbed `return` per node, would show the growth here even when the
   * absolute ceiling above still passed on a fast machine.
   */
  it('costs the same on a tree eight times the size', () => {
    const timeOn = (components: number): number => {
      document.body.innerHTML = '';
      mount(bigTree(components));
      // One untimed pass first, so neither measurement pays for the JIT warming
      // up on a code path the other has already run.
      sampleRenders(RENDER_NODE_CAP);
      const started = performance.now();
      for (let i = 0; i < 10; i++) sampleRenders(RENDER_NODE_CAP);
      return (performance.now() - started) / 10;
    };

    const small = timeOn(RENDER_NODE_CAP);
    const large = timeOn(RENDER_NODE_CAP * 8);

    // Eight times the tree for well under twice the time. Generous, for the
    // header's reason — a quadratic walk would be up by a factor of eight.
    expect(large).toBeLessThan(Math.max(small, 1) * 4);
  });
});
