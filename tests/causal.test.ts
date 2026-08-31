import { describe, expect, it } from 'vitest';
import {
  buildCausalGraph,
  causesOf,
  effectsOf,
  eventRef,
  parseEventRef,
} from '../src/core/causal/index.js';
import type {
  CausalConsoleEntry,
  CausalGraph,
  CausalLink,
  CausalNetworkCall,
  CausalStep,
} from '../src/core/causal/index.js';
import type { FlowPayload } from '../src/shared/types.js';

const step = (over: Partial<CausalStep> = {}): CausalStep => ({
  timestamp: 1000,
  type: 'click',
  action: 'Clicked "Checkout"',
  url: 'https://shop.test/cart',
  ...over,
});

const call = (over: Partial<CausalNetworkCall> = {}): CausalNetworkCall => ({
  method: 'POST',
  url: 'https://shop.test/api/cart',
  status: 200,
  responseBody: null,
  timestamp: 1010,
  ...over,
});

const entry = (over: Partial<CausalConsoleEntry> = {}): CausalConsoleEntry => ({
  level: 'log',
  args: ['ready'],
  timestamp: 1020,
  ...over,
});

const withBasis = (links: CausalLink[], basis: CausalLink['basis']): CausalLink[] =>
  links.filter((link) => link.basis === basis);

const between = (graph: CausalGraph, from: string, to: string): CausalLink[] =>
  graph.links.filter((link) => link.from === from && link.to === to);

const positionOf = (graph: CausalGraph, ref: string): number =>
  graph.events.findIndex((event) => event.ref === ref);

// ── 1. The roadmap's acceptance case ─────────────────────────────────────────

describe('a click that triggers a fetch that logs an error', () => {
  const graph = buildCausalGraph({
    steps: [
      step({
        timestamp: 1000,
        networkCalls: [call({ status: 500, timestamp: 1010 })],
        consoleLogs: [
          entry({ level: 'error', args: ['Request to /api/cart failed with 500'], timestamp: 1020 }),
        ],
      }),
    ],
  });

  const click = eventRef('step', 1);
  const fetched = eventRef('network', 1, 1);
  const logged = eventRef('console', 1, 1);

  it('walks backwards from the log line to the click', () => {
    const links = causesOf(graph, logged);

    expect(links).toContainEqual(
      expect.objectContaining({ from: fetched, to: logged, basis: 'named', confidence: 'high' }),
    );
    expect(links).toContainEqual(
      expect.objectContaining({
        from: click,
        to: fetched,
        basis: 'attributed',
        confidence: 'medium',
      }),
    );
  });

  it('walks forwards from the click to the log line', () => {
    const links = effectsOf(graph, click);

    expect(links).toContainEqual(
      expect.objectContaining({ from: click, to: fetched, basis: 'attributed' }),
    );
    expect(links).toContainEqual(
      expect.objectContaining({ from: fetched, to: logged, basis: 'named' }),
    );
  });

  it('names every event it hands back', () => {
    expect(graph.events.map((event) => event.ref)).toEqual([click, fetched, logged]);
    expect(graph.events[1].label).toBe('POST /api/cart → 500');
  });
});

// ── 2. Containment is not causation ──────────────────────────────────────────

describe('a background poll recorded under a step', () => {
  const graph = buildCausalGraph({
    steps: [
      step({
        timestamp: 1000,
        networkCalls: [
          call({
            method: 'GET',
            url: 'https://shop.test/api/heartbeat',
            status: 200,
            responseBody: '{"ok":true}',
            timestamp: 1010,
          }),
        ],
        consoleLogs: [entry({ args: ['tick'], timestamp: 1015 })],
        state: [{ store: 'redux', patch: [{ path: '/session/online', value: true }] }],
      }),
    ],
  });

  it('is attributed to the step and nothing stronger', () => {
    const poll = eventRef('network', 1, 1);
    expect(between(graph, eventRef('step', 1), poll)).toEqual([
      expect.objectContaining({ basis: 'attributed', confidence: 'medium' }),
    ]);
  });

  it('says the evidence is containment, not proof', () => {
    const link = between(graph, eventRef('step', 1), eventRef('network', 1, 1))[0];
    expect(link.detail).toContain('containment, not proof');
    expect(link.detail).toContain('step 1 was the open step');
  });

  it('is never named or echoed', () => {
    expect(withBasis(graph.links, 'named')).toEqual([]);
    expect(withBasis(graph.links, 'echoed')).toEqual([]);
  });
});

// ── 3. `named` ───────────────────────────────────────────────────────────────

describe('named', () => {
  const graph = buildCausalGraph({
    steps: [
      step({
        networkCalls: [call({ timestamp: 1010 })],
        consoleLogs: [
          entry({ args: ['fetching /api/cart now'], timestamp: 1020 }),
          entry({ args: ['unrelated chatter'], timestamp: 1030 }),
        ],
      }),
    ],
  });

  it('fires on the log line that contains the request path', () => {
    expect(between(graph, eventRef('network', 1, 1), eventRef('console', 1, 1))).toEqual([
      expect.objectContaining({ basis: 'named', confidence: 'high' }),
    ]);
  });

  it('does not fire on an unrelated log line in the same step', () => {
    expect(between(graph, eventRef('network', 1, 1), eventRef('console', 1, 2))).toEqual([]);
    expect(withBasis(graph.links, 'named')).toHaveLength(1);
  });

  it('does not treat a bare slash as naming anything', () => {
    const rooted = buildCausalGraph({
      steps: [
        step({
          networkCalls: [call({ url: 'https://shop.test/', timestamp: 1010 })],
          consoleLogs: [entry({ args: ['navigated to /'], timestamp: 1020 })],
        }),
      ],
    });
    expect(withBasis(rooted.links, 'named')).toEqual([]);
  });
});

// ── 4 & 5. `echoed`, and the discriminating-value rule ───────────────────────

describe('echoed', () => {
  it('does not fire on a trivial scalar the patch happened to write', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [
            call({
              status: 200,
              responseBody: '{"ok":true,"count":0,"note":"","state":"ok","retries":42}',
              timestamp: 1010,
            }),
          ],
          state: [
            {
              store: 'redux',
              patch: [
                { path: '/cart/ok', value: true },
                { path: '/cart/count', value: 0 },
                { path: '/cart/note', value: '' },
                { path: '/cart/state', value: 'ok' },
                { path: '/cart/retries', value: 42 },
              ],
            },
          ],
        }),
      ],
    });

    expect(withBasis(graph.links, 'echoed')).toEqual([]);
  });

  it('fires on an identifier that appears in both the body and the patch', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [
            call({
              status: 200,
              responseBody: '{"orderId":"ord_8f31c0a2","total":1299}',
              timestamp: 1010,
            }),
          ],
          state: [
            {
              store: 'redux',
              patch: [{ path: '/checkout/order', value: { id: 'ord_8f31c0a2', total: 1299 } }],
            },
          ],
        }),
      ],
    });

    const links = between(graph, eventRef('network', 1, 1), eventRef('state', 1, 'redux/1'));
    expect(links).toEqual([expect.objectContaining({ basis: 'echoed', confidence: 'high' })]);
    expect(links[0].detail).toContain('ord_8f31c0a2');
  });

  it('reads values, never keys', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [
            call({ status: 200, responseBody: '{"orderNumber":"none"}', timestamp: 1010 }),
          ],
          state: [{ store: 'redux', patch: [{ path: '/checkout/orderNumber', value: 7 }] }],
        }),
      ],
    });

    expect(withBasis(graph.links, 'echoed')).toEqual([]);
  });
});

// ── 6. `followed`, and the deduplication ─────────────────────────────────────

describe('followed', () => {
  it('does not fire when every call before the error succeeded', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [
            call({ method: 'GET', url: 'https://shop.test/api/ok', status: 200, timestamp: 1010 }),
          ],
          consoleLogs: [entry({ level: 'error', args: ['boom'], timestamp: 1030 })],
        }),
      ],
    });

    expect(withBasis(graph.links, 'followed')).toEqual([]);
  });

  it('reaches past a call that succeeded to the one that failed', () => {
    // The failure is *behind* a success, so a rule that simply remembers the
    // last call rather than the last failing one names the wrong request.
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [
            call({
              method: 'GET',
              url: 'https://shop.test/api/broken',
              status: 500,
              timestamp: 1010,
            }),
            call({ method: 'GET', url: 'https://shop.test/api/ok', status: 200, timestamp: 1020 }),
          ],
          consoleLogs: [entry({ level: 'error', args: ['boom'], timestamp: 1030 })],
        }),
      ],
    });

    const links = withBasis(graph.links, 'followed');
    expect(links).toEqual([
      expect.objectContaining({
        from: eventRef('network', 1, 1),
        to: eventRef('console', 1, 1),
        confidence: 'low',
      }),
    ]);
    expect(links[0].detail).toContain('ordering alone');
  });

  it('links the nearest failed call, not the one behind it', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [
            call({ url: 'https://shop.test/api/one', status: 500, timestamp: 1010 }),
            call({ url: 'https://shop.test/api/two', status: 503, timestamp: 1020 }),
          ],
          consoleLogs: [entry({ level: 'error', args: ['boom'], timestamp: 1030 })],
        }),
      ],
    });

    expect(withBasis(graph.links, 'followed')).toEqual([
      expect.objectContaining({ from: eventRef('network', 1, 2) }),
    ]);
  });

  it('does not fire for a log line that is not an error', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [call({ url: 'https://shop.test/api/x', status: 500, timestamp: 1010 })],
          consoleLogs: [entry({ level: 'warn', args: ['retrying'], timestamp: 1030 })],
        }),
      ],
    });

    expect(withBasis(graph.links, 'followed')).toEqual([]);
  });

  it('yields to `named` rather than doubling the same pair', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [call({ status: 500, timestamp: 1010 })],
          consoleLogs: [entry({ level: 'error', args: ['GET /api/cart failed'], timestamp: 1020 })],
        }),
      ],
    });

    const pair = between(graph, eventRef('network', 1, 1), eventRef('console', 1, 1));
    expect(pair).toHaveLength(1);
    expect(pair[0].basis).toBe('named');
  });
});

// ── 7. Direction ─────────────────────────────────────────────────────────────

describe('direction', () => {
  it('never points backwards', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          timestamp: 1000,
          networkCalls: [call({ status: 500, timestamp: 1010 })],
          consoleLogs: [entry({ level: 'error', args: ['/api/cart failed'], timestamp: 1020 })],
          state: [{ store: 'redux', patch: [{ path: '/cart/id', value: 'cart_9d81ff' }] }],
        }),
        step({
          timestamp: 2000,
          action: 'Typed "ada@" into Email',
          type: 'input',
          networkCalls: [
            call({ url: 'https://shop.test/api/validate', status: 200, timestamp: 2010 }),
          ],
          consoleLogs: [entry({ args: ['/api/validate ok'], timestamp: 2020 })],
        }),
      ],
    });

    expect(graph.links.length).toBeGreaterThan(0);
    for (const link of graph.links) {
      expect(positionOf(graph, link.from)).toBeGreaterThanOrEqual(0);
      expect(positionOf(graph, link.from)).toBeLessThan(positionOf(graph, link.to));
    }
  });

  it('orders a request before a log line that shares its millisecond', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [call({ status: 500, timestamp: 1010 })],
          consoleLogs: [entry({ level: 'error', args: ['/api/cart blew up'], timestamp: 1010 })],
        }),
      ],
    });

    const fetched = eventRef('network', 1, 1);
    const logged = eventRef('console', 1, 1);
    expect(positionOf(graph, fetched)).toBeLessThan(positionOf(graph, logged));
    expect(between(graph, fetched, logged)).toEqual([expect.objectContaining({ basis: 'named' })]);
    expect(between(graph, logged, fetched)).toEqual([]);
  });

  it('keeps a step at the head of its own step, however its buffer is stamped', () => {
    const graph = buildCausalGraph({
      steps: [
        step({ timestamp: 1000, consoleLogs: [entry({ args: ['earlier'], timestamp: 900 })] }),
      ],
    });

    expect(between(graph, eventRef('step', 1), eventRef('console', 1, 1))).toEqual([
      expect.objectContaining({ basis: 'attributed' }),
    ]);
    expect(positionOf(graph, eventRef('step', 1))).toBe(0);
  });
});

// ── 8. A step does not cause the next step ───────────────────────────────────

describe('steps', () => {
  const graph = buildCausalGraph({
    steps: [
      step({ timestamp: 1000, networkCalls: [call({ timestamp: 1010 })] }),
      step({ timestamp: 2000, action: 'Clicked "Pay"', consoleLogs: [entry({ timestamp: 2010 })] }),
      step({ timestamp: 3000, action: 'Clicked "Done"' }),
    ],
  });

  it('are never chained to each other', () => {
    const kindOf = (ref: string): string | undefined =>
      graph.events.find((event) => event.ref === ref)?.kind;

    for (const link of graph.links) {
      expect([kindOf(link.from), kindOf(link.to)]).not.toEqual(['step', 'step']);
    }
  });

  it('leaves nothing in a later step downstream of an earlier one', () => {
    expect(effectsOf(graph, eventRef('step', 1)).map((link) => link.to)).toEqual([
      eventRef('network', 1, 1),
    ]);
    expect(causesOf(graph, eventRef('console', 2, 1)).map((link) => link.from)).toEqual([
      eventRef('step', 2),
    ]);
  });
});

// ── 9. A cycle must not hang the walk ────────────────────────────────────────

describe('a cyclic links array', () => {
  const a = eventRef('step', 1);
  const b = eventRef('network', 1, 1);
  const c = eventRef('console', 1, 1);

  const ring = (from: string, to: string): CausalLink => ({
    from,
    to,
    basis: 'attributed',
    confidence: 'medium',
    detail: 'hand-built',
  });

  const graph: CausalGraph = {
    events: [
      { ref: a, kind: 'step', label: 'a', step: 1, timestamp: 1000 },
      { ref: b, kind: 'network', label: 'b', step: 1, timestamp: 1010 },
      { ref: c, kind: 'console', label: 'c', step: 1, timestamp: 1020 },
    ],
    links: [ring(a, b), ring(b, c), ring(c, a)],
  };

  it('does not hang, and reports each link once', () => {
    expect(causesOf(graph, c)).toHaveLength(3);
    expect(effectsOf(graph, a)).toHaveLength(3);
  });
});

// ── 10. A ref that names nothing ─────────────────────────────────────────────

describe('a ref that names no event', () => {
  // Two hops deep, so that `maxDepth` has something to stop short of.
  const graph = buildCausalGraph({
    steps: [
      step({
        networkCalls: [call({ status: 500, timestamp: 1010 })],
        consoleLogs: [entry({ level: 'error', args: ['/api/cart failed'], timestamp: 1020 })],
      }),
    ],
  });

  it('answers with an empty array rather than throwing', () => {
    expect(causesOf(graph, eventRef('step', 99))).toEqual([]);
    expect(effectsOf(graph, eventRef('step', 99))).toEqual([]);
    expect(causesOf(graph, 'not-a-ref-at-all')).toEqual([]);
    expect(effectsOf(graph, '')).toEqual([]);
  });

  it('answers the same way for a depth that admits no hop', () => {
    expect(effectsOf(graph, eventRef('step', 1), 0)).toEqual([]);
    expect(causesOf(graph, eventRef('console', 1, 1), 0)).toEqual([]);
  });

  it('counts a depth in hops', () => {
    // Step 1 reaches the call and the log directly, and the log again through
    // the call — one more hop than a depth of 1 may take.
    expect(effectsOf(graph, eventRef('step', 1), 1).map((link) => link.to)).toEqual([
      eventRef('network', 1, 1),
      eventRef('console', 1, 1),
    ]);
    expect(effectsOf(graph, eventRef('step', 1), 2)).toHaveLength(3);
  });
});

// ── Refs ─────────────────────────────────────────────────────────────────────

describe('eventRef', () => {
  it('formats the four shapes', () => {
    expect(eventRef('step', 3)).toBe('step:3');
    // The index a caller passes is written down as given. It is the *builder*
    // that counts from one — see `eventRef` — so this is the formatter alone.
    expect(eventRef('network', 3, 1)).toBe('net:3.1');
    expect(eventRef('console', 3, 2)).toBe('log:3.2');
    expect(eventRef('state', 3, 'redux:0/1')).toBe('state:3/redux:0/1');
  });

  it('counts from one, like every other number a reader of this project sees', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [
            call({ url: 'https://api.example.com/a' }),
            call({ url: 'https://api.example.com/b' }),
          ],
          consoleLogs: [entry({ args: ['first'] })],
          state: [{ store: 'redux', patch: [{ path: '/a', value: 1 }] }],
        }),
      ],
    });

    /*
     * `net:1.0` beside "step 1" is the same one-character misreading that
     * `Pos0`/`Pos1` exists to make impossible, and a ref is a string, so there
     * is no type here to catch it. This is the gate instead: the first call of
     * the first step is `net:1.1`, and the *second* is `net:1.2` — which is
     * what fails if the indices are shifted rather than merely renamed.
     */
    const refs = graph.events.map((event) => event.ref);
    expect(refs).toContain('net:1.1');
    expect(refs).toContain('net:1.2');
    expect(refs).toContain('log:1.1');
    expect(refs).toContain('state:1/redux/1');
    expect(refs.some((ref) => /\.0$|\/0$/.test(ref))).toBe(false);
  });

  it('round-trips through parseEventRef', () => {
    expect(parseEventRef('step:3')).toEqual({ kind: 'step', step: 3 });
    expect(parseEventRef('net:3.1')).toEqual({ kind: 'network', step: 3, index: 1 });
    expect(parseEventRef('log:3.2')).toEqual({ kind: 'console', step: 3, index: 2 });
    expect(parseEventRef('state:3/redux:0')).toEqual({
      kind: 'state',
      step: 3,
      index: 'redux:0',
    });
  });

  it('refuses a string that is not a ref', () => {
    expect(parseEventRef('cart:3')).toBeNull();
    expect(parseEventRef('step:')).toBeNull();
    expect(parseEventRef('step:03')).toBeNull();
  });
});

// ── The input shape ──────────────────────────────────────────────────────────

describe('the flow it accepts', () => {
  it('takes a FlowPayload without a cast', () => {
    // The assertion is the compile: `CausalFlow` is the narrowest shape that
    // works, so a payload on its way to the MCP server is already one.
    const payload: FlowPayload = {
      schemaVersion: 1,
      id: 'flow_1',
      name: 'Checkout',
      timestamp: 1000,
      steps: [
        {
          type: 'click',
          url: 'https://shop.test/cart',
          timestamp: 1000,
          stepNumber: 1,
          action: 'Clicked "Checkout"',
          element: { tag: 'button', cssSelector: '#pay', xpath: '/html', boundingBox: null },
          networkCalls: [
            {
              method: 'POST',
              url: 'https://shop.test/api/cart',
              requestHeaders: {},
              requestBody: null,
              status: 500,
              responseHeaders: {},
              responseBody: null,
              durationMs: 12,
              timestamp: 1010,
            },
          ],
          consoleLogs: [{ level: 'error', args: ['/api/cart failed'], timestamp: 1020 }],
          state: [{ store: 'redux', patch: [{ op: 'replace', path: '/cart/id', value: 1 }] }],
        },
      ],
    };

    expect(buildCausalGraph(payload).events).toHaveLength(4);
  });
});

// ── Labels ───────────────────────────────────────────────────────────────────

describe('labels', () => {
  it('identify each kind in one line', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          action: 'Clicked "Checkout"',
          networkCalls: [call({ method: 'GET', url: 'https://shop.test/api/cart?id=7' })],
          consoleLogs: [entry({ level: 'error', args: ['boom', 'again'] })],
          state: [
            {
              store: 'redux',
              patch: [
                { path: '/cart/items/0', value: 1 },
                { path: '/session/token', value: 'x' },
              ],
            },
          ],
        }),
      ],
    });

    expect(graph.events.map((event) => event.label)).toEqual([
      'Clicked "Checkout"',
      'GET /api/cart?id=7 → 200',
      'error: boom again',
      'redux: cart, session',
    ]);
  });
});
