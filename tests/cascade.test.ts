/**
 * The cascade join — and the claims it must refuse to make.
 *
 * The risk in this module is not that it draws the wrong box. It is that
 * putting a component in the same picture as a state change reads as *that
 * state change re-rendered it*, which is sometimes true, sometimes a
 * coincidence, and always plausible. So most of what is asserted below is about
 * the edge a render was **not** given.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCascade,
  hasCascade,
  parseRenderRef,
  type CascadeInput,
  type CascadeStep,
} from '../src/core/cascade/index.js';

function step(over: Partial<CascadeStep> = {}): CascadeStep {
  return {
    timestamp: 1_700_000_000_000,
    stepNumber: 1,
    type: 'click',
    action: 'Clicked Checkout',
    ...over,
  };
}

function input(over: Partial<CascadeInput> = {}): CascadeInput {
  return { steps: [step()], ...over };
}

/** The edge that lands on one component's render node. */
function edgeTo(cascade: NonNullable<ReturnType<typeof buildCascade>>, component: string) {
  const ref = cascade.layers.flat().find((node) => node.ref.endsWith(`/${component}`))?.ref;
  return cascade.edges.find((edge) => edge.to === ref);
}

describe('buildCascade', () => {
  it('returns null for a step the flow does not have', () => {
    // Not an empty cascade: "no such step" and "that step caused nothing" are
    // different answers and only the caller knows which sentence to show.
    expect(buildCascade(input(), 9)).toBeNull();
  });

  it('puts the interaction alone in layer 0', () => {
    const cascade = buildCascade(input(), 1)!;
    expect(cascade.layers[0]).toHaveLength(1);
    expect(cascade.layers[0][0]).toMatchObject({ kind: 'step', label: 'Clicked Checkout', layer: 0 });
  });
});

describe('the render join', () => {
  const moved = {
    state: [{ store: 'store-1', patch: [{ path: '/cart/total', value: 49.99 }] }],
  };

  it('draws the strong edge when the component was observed reading the store', () => {
    const cascade = buildCascade(
      input({
        steps: [step({ ...moved, renders: [{ component: 'cmp-cart' }] })],
        stores: [{ id: 'store-1', label: 'CartContext', subscribers: ['cmp-cart'] }],
        componentNames: { 'cmp-cart': 'CartBadge' },
      }),
      1,
    )!;

    const edge = edgeTo(cascade, 'cmp-cart')!;
    expect(edge.basis).toBe('subscribed');
    expect(edge.confidence).toBe('high');
    // It hangs off the state change, not off the step. The ref shape is
    // `state:<step>/<store id>/<n>` — one event per key of the store — which is
    // `core/causal`'s and was measured rather than assumed.
    expect(edge.from).toBe('state:1/store-1/1');
    expect(edge.detail).toContain('its own fiber');
  });

  it('falls to a name match, and calls it a match rather than a sighting', () => {
    const cascade = buildCascade(
      input({
        steps: [
          step({
            ...moved,
            // No subscriber list on the store, but the component's own fiber
            // depended on a context whose value differed and whose name is the
            // store's.
            renders: [{ component: 'cmp-cart', contexts: [{ key: 'CartContext' }] }],
          }),
        ],
        stores: [{ id: 'store-1', label: 'CartContext' }],
      }),
      1,
    )!;

    const edge = edgeTo(cascade, 'cmp-cart')!;
    expect(edge.basis).toBe('named');
    expect(edge.confidence).toBe('medium');
    expect(edge.from).toBe('state:1/store-1/1');
    expect(edge.detail).toContain('Two contexts can share a name');
  });

  it('prefers the observed subscription over the name match when it has both', () => {
    const cascade = buildCascade(
      input({
        steps: [
          step({
            state: [
              { store: 'store-named', patch: [{ path: '/a', value: 1 }] },
              { store: 'store-subscribed', patch: [{ path: '/b', value: 2 }] },
            ],
            renders: [{ component: 'cmp', contexts: [{ key: 'NamedContext' }] }],
          }),
        ],
        stores: [
          { id: 'store-named', label: 'NamedContext' },
          { id: 'store-subscribed', label: 'Other', subscribers: ['cmp'] },
        ],
      }),
      1,
    )!;

    const edge = edgeTo(cascade, 'cmp')!;
    expect(edge.basis).toBe('subscribed');
    expect(edge.from).toBe('state:1/store-subscribed/2');
  });

  it('attaches to the STEP, not to a store that merely also moved', () => {
    /*
     * The assertion this whole module exists for. A component re-rendered, a
     * store moved, and there is no evidence connecting them — no subscription
     * and no shared name. Drawing an arrow from the store would be the tool
     * inventing the finding a reader came for.
     */
    const cascade = buildCascade(
      input({
        steps: [step({ ...moved, renders: [{ component: 'cmp-unrelated' }] })],
        stores: [{ id: 'store-1', label: 'CartContext', subscribers: ['cmp-somebody-else'] }],
      }),
      1,
    )!;

    const edge = edgeTo(cascade, 'cmp-unrelated')!;
    expect(edge.basis).toBe('sampled');
    expect(edge.confidence).toBe('low');
    expect(edge.from).toBe('step:1');
    expect(edge.detail).toContain('was not observed');
  });

  it('does not match a store whose label is absent against a context of any name', () => {
    const cascade = buildCascade(
      input({
        steps: [step({ ...moved, renders: [{ component: 'cmp', contexts: [{ key: 'Something' }] }] })],
        stores: [{ id: 'store-1' }],
      }),
      1,
    )!;
    expect(edgeTo(cascade, 'cmp')!.basis).toBe('sampled');
  });

  it('ignores a subscribed store that did not move in this step', () => {
    // Subscribing to a store that stayed still explains nothing about a render.
    const cascade = buildCascade(
      input({
        steps: [step({ renders: [{ component: 'cmp' }] })],
        stores: [{ id: 'store-1', subscribers: ['cmp'] }],
      }),
      1,
    )!;
    const edge = edgeTo(cascade, 'cmp')!;
    expect(edge.basis).toBe('sampled');
    expect(edge.from).toBe('step:1');
  });

  it('names the component the way a person reads it', () => {
    const cascade = buildCascade(
      input({
        steps: [step({ renders: [{ component: 'cmp-a' }] })],
        componentNames: { 'cmp-a': 'CheckoutButton' },
      }),
      1,
    )!;
    expect(cascade.layers.flat().find((n) => n.kind === 'render')?.label).toBe('CheckoutButton');
  });

  it('carries wasted and bounded onto the node, and never both claims at once', () => {
    const cascade = buildCascade(
      input({ steps: [step({ renders: [{ component: 'a', wasted: true }, { component: 'b', bounded: true }] })] }),
      1,
    )!;
    const nodes = cascade.layers.flat().filter((node) => node.kind === 'render');
    expect(nodes.find((n) => n.ref.endsWith('/a'))?.wasted).toBe(true);
    expect(nodes.find((n) => n.ref.endsWith('/b'))?.bounded).toBe(true);
    // `blame.ts` refuses `wasted` on a cut observation, and nothing here adds it.
    expect(nodes.find((n) => n.ref.endsWith('/b'))?.wasted).toBeUndefined();
  });
});

describe('layout', () => {
  it('takes layers from causal distance rather than a fixed order of kinds', () => {
    /*
     * A recording where the request fired and the store moved on its response
     * must not be drawn "state, then network" just because that is the tidy
     * order. `effectsOf` walks the evidence; the columns follow it.
     */
    const cascade = buildCascade(
      input({
        steps: [
          step({
            networkCalls: [
              { method: 'POST', url: 'https://api.example.com/checkout', status: 500, timestamp: 1 },
            ],
            consoleLogs: [
              { level: 'error', args: ['POST https://api.example.com/checkout 500'], timestamp: 2 },
            ],
          }),
        ],
      }),
      1,
    )!;

    const network = cascade.layers.flat().find((node) => node.kind === 'network')!;
    const console_ = cascade.layers.flat().find((node) => node.kind === 'console')!;
    // The console line echoes the request, so it sits one further out than it.
    expect(console_.layer).toBeGreaterThan(network.layer);
  });

  it('keeps wasted renders when a layer overflows, and says how many it cut', () => {
    const renders = [
      ...Array.from({ length: 10 }, (_, i) => ({ component: `busy-${i}`, props: [{ key: 'x' }] })),
      { component: 'zzz-wasted', wasted: true },
    ];
    const cascade = buildCascade(input({ steps: [step({ renders })] }), 1, {
      maxPerLayer: 3,
      maxDepth: 6,
    })!;

    const drawn = cascade.layers.flat().filter((node) => node.kind === 'render');
    // Ordering by "how much happened" would drop this one, because a wasted
    // render has no changes by definition — which is exactly the finding.
    expect(drawn.some((node) => node.wasted)).toBe(true);
    expect(cascade.dropped).toBeGreaterThan(0);
    expect(cascade.notes.join(' ')).toContain('did not fit');
  });

  it('drops edges that would point into a node the budget cut', () => {
    const cascade = buildCascade(
      input({ steps: [step({ renders: Array.from({ length: 8 }, (_, i) => ({ component: `c${i}` })) })] }),
      1,
      { maxPerLayer: 2, maxDepth: 6 },
    )!;
    const drawn = new Set(cascade.layers.flat().map((node) => node.ref));
    for (const edge of cascade.edges) {
      expect(drawn.has(edge.from)).toBe(true);
      expect(drawn.has(edge.to)).toBe(true);
    }
  });

  it('draws the same picture twice for one recording', () => {
    const flow = input({
      steps: [step({ renders: [{ component: 'b' }, { component: 'a' }, { component: 'c' }] })],
    });
    const first = buildCascade(flow, 1)!;
    const second = buildCascade(flow, 1)!;
    expect(first.layers.flat().map((n) => n.ref)).toEqual(second.layers.flat().map((n) => n.ref));
  });
});

describe('what the picture refuses to claim', () => {
  it('always carries the sampling caveat and the absent-arrow caveat', () => {
    const cascade = buildCascade(input({ steps: [step({ renders: [{ component: 'a' }] })] }), 1)!;
    const notes = cascade.notes.join(' ');
    expect(notes).toContain('sampled twice per interaction');
    expect(notes).toContain('An arrow is evidence, not a mechanism');
  });

  it('says so when a component observation was cut', () => {
    const cascade = buildCascade(
      input({ steps: [step({ renders: [{ component: 'a', bounded: true }] })] }),
      1,
    )!;
    expect(cascade.notes.join(' ')).toContain('statement about the cap');
  });

  it('says so when a store snapshot was cut', () => {
    const cascade = buildCascade(
      input({
        steps: [step({ state: [{ store: 's', patch: [{ path: '/a', value: 1 }], bounded: true }] })],
      }),
      1,
    )!;
    expect(cascade.notes.join(' ')).toContain('below the cut reads here as no change');
  });

  it('explains a flow with no stores rather than letting the shape imply a cause', () => {
    const cascade = buildCascade(input({ steps: [step({ renders: [{ component: 'a' }] })] }), 1)!;
    expect(cascade.notes.join(' ')).toContain('no state stores');
    expect(cascade.notes.join(' ')).toContain('absence of an observation');
  });
});

describe('hasCascade', () => {
  it('is false for a step where nothing observable happened', () => {
    // A click on a link that navigated, with no store, request or re-render
    // seen. Offering a graph of it is worse than not offering one.
    expect(hasCascade(step())).toBe(false);
  });

  it('is true as soon as any one of the four is present', () => {
    expect(hasCascade(step({ renders: [{ component: 'a' }] }))).toBe(true);
    expect(hasCascade(step({ state: [{ store: 's', patch: [] }] }))).toBe(true);
    expect(hasCascade(step({ networkCalls: [{ method: 'GET', url: '/a', status: 200, timestamp: 1 }] }))).toBe(true);
    expect(hasCascade(step({ consoleLogs: [{ level: 'error', args: ['x'], timestamp: 1 }] }))).toBe(true);
  });
});

describe('parseRenderRef', () => {
  it('reads back what renderRef wrote, including a component id with a slash', () => {
    expect(parseRenderRef('render:3/cmp-a')).toEqual({ step: 3, component: 'cmp-a' });
    expect(parseRenderRef('render:1/a/b')).toEqual({ step: 1, component: 'a/b' });
  });

  it('is null for anything else, including the causal refs it sits beside', () => {
    expect(parseRenderRef('step:1')).toBeNull();
    expect(parseRenderRef('net:1.2')).toBeNull();
    expect(parseRenderRef('render:x/a')).toBeNull();
  });
});
