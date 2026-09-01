/**
 * Assembling what a recording knows about one failure, and refusing to know
 * more than that.
 *
 * Every way this module can be wrong is quiet. It throws at nothing, returns a
 * well-formed `Diagnosis[]` for every input, and each failure below is visible
 * only to a reader who already knows the answer:
 *
 *  1. **`unknown` for want of observations reads as `new`.** "We have never seen
 *     this fail" and "we have not seen this enough to say" are the two answers
 *     this module exists to separate, and they are one answer the moment the
 *     detail sentence stops saying which. A reader handed the first when the
 *     second is true concludes a working endpoint just broke and goes hunting
 *     for what changed today. Nothing about the output looks wrong.
 *  2. **A ref spelled differently from `core/causal`'s.** `evidenceFor` is a
 *     lookup, so a ref off by a step number or an index returns an empty array —
 *     which is exactly what a failure with genuinely no evidence returns. Every
 *     diagnosis in the flow loses its evidence at once and the shape stays
 *     valid. Hence the tests pinning the exact strings, including under the
 *     stale-`stepNumber` fallback that flips the whole flow to positional.
 *  3. **A component reported as a bare id.** `owner` is a hash of compiled
 *     source; a diagnosis carrying one the table could not resolve reads as a
 *     located component and cannot be looked up.
 *  4. **The graph asked with the wrong key, or asked about nothing.** A lookup
 *     with a lower-cased method or an unresolvable component id comes back
 *     null, which becomes "no observations" — an absence manufactured by the
 *     question rather than reported by the graph.
 *  5. **Evidence re-ordered.** The order is the causal engine's claim about
 *     nearness; re-sorting it here would be this module ranking evidence, which
 *     is the one thing it must not do.
 *
 * The fixtures are written by hand rather than produced by a recorder or by
 * `buildCausalGraph`: a fixture built by the code under test agrees with it by
 * construction, and the ref spelling is precisely what is being checked.
 */

import { describe, expect, it } from 'vitest';
import { MIN_HISTORY, diagnose } from '../src/core/diagnose/index.js';
import type { DiagnoseInputs, DiagnosisEvidence, HistoryFact } from '../src/core/diagnose/index.js';
import { pos1 } from '../src/core/react/positions.js';
import type {
  ClickStep,
  ComponentSource,
  ConsoleEntry,
  ElementRef,
  FlowPayload,
  FlowReact,
  NetworkCall,
  Step,
} from '../src/shared/types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const element = (owner?: string): ElementRef => ({
  tag: 'button',
  cssSelector: '#checkout',
  xpath: '/html/body/button',
  boundingBox: null,
  ...(owner !== undefined ? { react: { chain: [owner], owner } } : {}),
});

const step = (over: Partial<ClickStep> = {}): Step => ({
  type: 'click',
  url: 'https://shop.test/cart',
  timestamp: 1000,
  action: 'Clicked "Checkout"',
  element: element(),
  ...over,
});

const call = (over: Partial<NetworkCall> = {}): NetworkCall => ({
  method: 'POST',
  url: 'https://shop.test/api/cart?token=abc',
  requestHeaders: {},
  requestBody: null,
  status: 200,
  responseHeaders: {},
  responseBody: null,
  durationMs: 12,
  timestamp: 1010,
  ...over,
});

const entry = (over: Partial<ConsoleEntry> = {}): ConsoleEntry => ({
  level: 'log',
  args: ['ready'],
  timestamp: 1020,
  ...over,
});

const flow = (steps: Step[], react?: FlowReact): FlowPayload => ({
  schemaVersion: 1,
  id: 'flow-1',
  name: 'Checkout',
  timestamp: 900,
  steps,
  ...(react !== undefined ? { react } : {}),
});

const componentTable = (over: Record<string, ComponentSource> = {}): FlowReact => ({
  detected: true,
  components: {
    'c-1': {
      name: 'CartButton',
      status: 'resolved',
      source: 'src/components/CartButton.tsx',
      line: pos1(42),
    },
    ...over,
  },
});

const history = (over: Partial<HistoryFact> = {}): HistoryFact => ({
  kind: 'endpoint',
  id: 'ep-1',
  label: 'POST https://shop.test/api/cart',
  observations: 140,
  failureRate: 0.6,
  ...over,
});

const evidence = (over: Partial<DiagnosisEvidence> = {}): DiagnosisEvidence => ({
  ref: 'step:1',
  label: 'Clicked "Checkout"',
  basis: 'attributed',
  detail: 'Recorded while step 1 was the open step.',
  ...over,
});

/** No evidence, no history, so a test asserts only what it set up. */
const barren: DiagnoseInputs = { evidenceFor: () => [], historyFor: () => null };

const inputs = (over: Partial<DiagnoseInputs> = {}): DiagnoseInputs => ({ ...barren, ...over });

/**
 * Inputs that remember what they were asked.
 *
 * The questions are half of what is under test — a key the graph cannot answer
 * is indistinguishable from a graph with no answer.
 */
function recorder(): {
  inputs: DiagnoseInputs;
  evidenceAsked: string[];
  historyAsked: [string, string][];
} {
  const evidenceAsked: string[] = [];
  const historyAsked: [string, string][] = [];
  return {
    evidenceAsked,
    historyAsked,
    inputs: {
      evidenceFor: (ref) => {
        evidenceAsked.push(ref);
        return [];
      },
      historyFor: (kind, key) => {
        historyAsked.push([kind, key]);
        return null;
      },
    },
  };
}

// ── 1. What counts as a failure, and in what order ───────────────────────────

describe('the failures a recording carries', () => {
  it('reports one diagnosis per failure, network before console within a step', () => {
    const found = diagnose(
      flow([
        step({
          stepNumber: 1,
          networkCalls: [call({ status: 500 })],
          consoleLogs: [entry({ level: 'error', args: ['Checkout failed'] })],
        }),
      ]),
      barren,
      10,
    );

    expect(found.map((d) => d.kind)).toEqual(['network', 'console']);
    expect(found.map((d) => d.step)).toEqual([1, 1]);
  });

  it('keeps step order across steps', () => {
    const found = diagnose(
      flow([
        step({ stepNumber: 1, consoleLogs: [entry({ level: 'error', args: ['first'] })] }),
        step({ stepNumber: 2, networkCalls: [call({ status: 404 })] }),
      ]),
      barren,
      10,
    );

    expect(found.map((d) => [d.step, d.kind])).toEqual([
      [1, 'console'],
      [2, 'network'],
    ]);
  });

  it("reads core/flow's rule, so a request that never landed is a failure", () => {
    const found = diagnose(
      flow([step({ stepNumber: 1, networkCalls: [call({ status: null })] })]),
      barren,
      10,
    );

    expect(found).toHaveLength(1);
    expect(found[0].what).toBe('POST /api/cart?token=abc failed before a response');
  });

  it('says the status when there was one', () => {
    const found = diagnose(
      flow([step({ stepNumber: 1, networkCalls: [call({ status: 503 })] })]),
      barren,
      10,
    );

    expect(found[0].what).toBe('POST /api/cart?token=abc failed with 503');
  });

  it('ignores a call that succeeded and a log below error level', () => {
    const found = diagnose(
      flow([
        step({
          stepNumber: 1,
          networkCalls: [call({ status: 204 }), call({ status: 302 })],
          consoleLogs: [entry({ level: 'warn', args: ['slow'] }), entry({ level: 'log' })],
        }),
      ]),
      barren,
      10,
    );

    expect(found).toEqual([]);
  });

  it('returns [] for a flow with no failures and for a flow with no steps', () => {
    expect(diagnose(flow([step({ stepNumber: 1 })]), barren, 10)).toEqual([]);
    expect(diagnose(flow([]), barren, 10)).toEqual([]);
  });
});

// ── 2. `what`, in the recording's own words ──────────────────────────────────

describe('what broke, in one line', () => {
  it('takes the first line of the joined args and collapses its whitespace', () => {
    const found = diagnose(
      flow([
        step({
          stepNumber: 1,
          consoleLogs: [
            entry({
              level: 'error',
              args: ['TypeError:  cannot\tread', 'total\n    at Cart (cart.tsx:9)\n    at App'],
            }),
          ],
        }),
      ]),
      barren,
      10,
    );

    expect(found[0].what).toBe('TypeError: cannot read total');
  });

  it('caps a single-line error at 200 characters', () => {
    const found = diagnose(
      flow([
        step({ stepNumber: 1, consoleLogs: [entry({ level: 'error', args: ['x'.repeat(500)] })] }),
      ]),
      barren,
      10,
    );

    expect(found[0].what).toHaveLength(200);
    expect(found[0].what.endsWith('…')).toBe(true);
  });
});

// ── 3. The component, resolved or absent — never a bare id ───────────────────

describe('the component a step was attributed to', () => {
  const failing = (owner?: string): Step =>
    step({
      stepNumber: 1,
      element: element(owner),
      consoleLogs: [entry({ level: 'error', args: ['boom'] })],
    });

  it('resolves the owner id through the flow table', () => {
    const found = diagnose(flow([failing('c-1')], componentTable()), barren, 10);

    expect(found[0].component).toStrictEqual({
      id: 'c-1',
      name: 'CartButton',
      source: 'src/components/CartButton.tsx',
      line: 42,
    });
  });

  it('is absent, rather than a bare id, when the table cannot resolve it', () => {
    const found = diagnose(flow([failing('c-missing')], componentTable()), barren, 10);

    // The key is absent, not present and undefined: an optional field this
    // module could not fill must not read as a field it filled with nothing.
    expect(Object.keys(found[0])).not.toContain('component');
    expect(JSON.stringify(found[0])).not.toContain('c-missing');
  });

  it('is carried by a network failure too, which is still asked about as an endpoint', () => {
    const asked = recorder();
    const found = diagnose(
      flow(
        [
          step({
            stepNumber: 1,
            element: element('c-1'),
            networkCalls: [call({ status: 500 })],
          }),
        ],
        componentTable(),
      ),
      asked.inputs,
      10,
    );

    // The step is where the request was made from, so the component is worth
    // naming; what the graph knows about a failing request is still the
    // endpoint's history, not the component's.
    expect(found[0].component?.name).toBe('CartButton');
    expect(asked.historyAsked).toEqual([
      ['endpoint', 'POST https://shop.test/api/cart?token=abc'],
    ]);
  });

  it('is absent when the flow carries no React data at all', () => {
    expect(diagnose(flow([failing('c-1')]), barren, 10)[0].component).toBeUndefined();
  });

  it('is absent when the step touched no element with an owner', () => {
    expect(diagnose(flow([failing()], componentTable()), barren, 10)[0].component).toBeUndefined();
  });

  it('drops a resolved entry whose name is empty, which is a bare id in a table row', () => {
    const table = componentTable({ 'c-2': { name: '   ', status: 'not-found' } });

    expect(diagnose(flow([failing('c-2')], table), barren, 10)[0].component).toBeUndefined();
  });

  it('omits the source and line the table does not carry', () => {
    const table = componentTable({ 'c-3': { name: 'Anonymous', status: 'not-found' } });

    // `toStrictEqual`, not `toEqual`: a `source: undefined` key is a hole the
    // shape does not admit to having, and `toEqual` cannot see one.
    expect(diagnose(flow([failing('c-3')], table), barren, 10)[0].component).toStrictEqual({
      id: 'c-3',
      name: 'Anonymous',
    });
  });
});

// ── 4. The refs, which have to be `core/causal`'s ────────────────────────────

describe('the event refs evidence is looked up by', () => {
  it('asks with `net:<step>.<n>` and `log:<step>.<n>`, indexed over every event of the step', () => {
    const asked = recorder();
    diagnose(
      flow([
        step({
          stepNumber: 3,
          // The failing call is second and the failing log third: a ref counts
          // positions in the recording, not failures.
          networkCalls: [call({ status: 200 }), call({ status: 500 })],
          consoleLogs: [
            entry({ level: 'log' }),
            entry({ level: 'warn' }),
            entry({ level: 'error', args: ['boom'] }),
          ],
        }),
      ]),
      asked.inputs,
      10,
    );

    expect(asked.evidenceAsked).toEqual(['net:3.2', 'log:3.3']);
  });

  it('uses the stamped step numbers while they are all distinct', () => {
    const asked = recorder();
    diagnose(
      flow([
        step({ stepNumber: 7, networkCalls: [call({ status: 500 })] }),
        step({ stepNumber: 9, networkCalls: [call({ status: 500 })] }),
      ]),
      asked.inputs,
      10,
    );

    expect(asked.evidenceAsked).toEqual(['net:7.1', 'net:9.1']);
  });

  it('falls back to position for the whole flow when stamped numbers collide', () => {
    const collided = (): Step[] => [
      step({ stepNumber: 4, networkCalls: [call({ status: 500 })] }),
      step({ stepNumber: 4, networkCalls: [call({ status: 500 })] }),
    ];
    const asked = recorder();
    diagnose(flow(collided()), asked.inputs, 10);

    // Not `net:4.1` twice — two events under one ref is a lookup that cannot be
    // right for both, and `core/causal` renumbers the flow rather than mint it.
    expect(asked.evidenceAsked).toEqual(['net:1.1', 'net:2.1']);
    // And the reported step number agrees with the ref, so a reader following
    // one to the other lands in the same place.
    expect(diagnose(flow(collided()), barren, 10).map((d) => d.step)).toEqual([1, 2]);
  });

  it('numbers an unstamped flow from one', () => {
    const asked = recorder();
    diagnose(flow([step({ networkCalls: [call({ status: 500 })] })]), asked.inputs, 10);

    expect(asked.evidenceAsked).toEqual(['net:1.1']);
  });
});

// ── 5. Evidence, passed through ──────────────────────────────────────────────

describe('the evidence the causal walk found', () => {
  const links = [
    evidence({ ref: 'net:1.1', basis: 'followed', label: 'POST /api/cart → 500' }),
    evidence({ ref: 'step:1', basis: 'attributed' }),
  ];

  it('arrives in the order given and leaves in it', () => {
    const found = diagnose(
      flow([step({ stepNumber: 1, consoleLogs: [entry({ level: 'error', args: ['boom'] })] })]),
      inputs({ evidenceFor: () => links }),
      10,
    );

    expect(found[0].evidence.map((e) => e.basis)).toEqual(['followed', 'attributed']);
    expect(found[0].evidence).toEqual(links);
  });

  it('copies rather than aliases what the caller handed over', () => {
    const found = diagnose(
      flow([step({ stepNumber: 1, networkCalls: [call({ status: 500 })] })]),
      inputs({ evidenceFor: () => links }),
      10,
    );

    expect(found[0].evidence).not.toBe(links);
  });

  it('treats an empty list as ordinary rather than an error', () => {
    const found = diagnose(
      flow([step({ stepNumber: 1, networkCalls: [call({ status: 500 })] })]),
      barren,
      10,
    );

    expect(found[0].evidence).toEqual([]);
    expect(found[0].what).toBe('POST /api/cart?token=abc failed with 500');
  });
});

// ── 6. What the graph is asked ───────────────────────────────────────────────

describe('the question put to the graph', () => {
  it('asks about the endpoint as `METHOD url`, uppercased, for a network failure', () => {
    const asked = recorder();
    diagnose(
      flow([
        step({
          stepNumber: 1,
          networkCalls: [call({ method: 'get', url: 'https://s.test/a', status: 500 })],
        }),
      ]),
      asked.inputs,
      10,
    );

    expect(asked.historyAsked).toEqual([['endpoint', 'GET https://s.test/a']]);
  });

  it('asks about the component id for a console error attributed to one', () => {
    const asked = recorder();
    diagnose(
      flow(
        [
          step({
            stepNumber: 1,
            element: element('c-1'),
            consoleLogs: [entry({ level: 'error', args: ['boom'] })],
          }),
        ],
        componentTable(),
      ),
      asked.inputs,
      10,
    );

    expect(asked.historyAsked).toEqual([['component', 'c-1']]);
  });

  it('asks nothing when the console error resolved to no component', () => {
    const asked = recorder();
    diagnose(
      flow([
        step({
          stepNumber: 1,
          element: element('c-missing'),
          consoleLogs: [entry({ level: 'error', args: ['boom'] })],
        }),
      ]),
      asked.inputs,
      10,
    );

    expect(asked.historyAsked).toEqual([]);
  });

  it("carries the graph's answer through untouched", () => {
    const fact = history({ observations: 140, failureRate: 0.6 });
    const found = diagnose(
      flow([step({ stepNumber: 1, networkCalls: [call({ status: 500 })] })]),
      inputs({ historyFor: () => fact }),
      10,
    );

    expect(found[0].history).toEqual(fact);
  });
});

// ── 7. Standing — the four outcomes, and the two that must not merge ─────────

describe('standing', () => {
  const withHistory = (fact: HistoryFact | null) =>
    diagnose(
      flow([step({ stepNumber: 1, networkCalls: [call({ status: 500 })] })]),
      inputs({ historyFor: () => fact }),
      10,
    )[0];

  it('is chronic at or above a fifth of the observations', () => {
    const found = withHistory(history({ observations: 140, failureRate: 0.6 }));

    expect(found.standing).toBe('chronic');
    expect(found.standingDetail).toContain('60%');
    expect(found.standingDetail).toContain('140 observations');
  });

  it('is chronic exactly at the threshold', () => {
    expect(withHistory(history({ observations: 10, failureRate: 0.2 })).standing).toBe('chronic');
  });

  it('is new at or below one in twenty', () => {
    const found = withHistory(history({ observations: 140, failureRate: 0.014 }));

    expect(found.standing).toBe('new');
    expect(found.standingDetail).toContain('1.4%');
    expect(found.standingDetail).toContain('140 observations');
  });

  it('is new exactly at the threshold', () => {
    expect(withHistory(history({ observations: 40, failureRate: 0.05 })).standing).toBe('new');
  });

  it('refuses the band between the two rather than inventing a third label', () => {
    const found = withHistory(history({ observations: 140, failureRate: 0.12 }));

    expect(found.standing).toBe('unknown');
    expect(found.standingDetail).toContain('12%');
    expect(found.standingDetail).toContain('neither');

    // A percentage rounded into the band it is being excluded from is a sentence
    // arguing with its own number.
    expect(withHistory(history({ observations: 140, failureRate: 0.199 })).standingDetail).toContain(
      '19.9%',
    );
  });

  it('is unknown below the observation floor, and names the floor', () => {
    const found = withHistory(history({ observations: 3, failureRate: 1 }));

    expect(found.standing).toBe('unknown');
    expect(found.standingDetail).toContain('3 observations');
    expect(found.standingDetail).toContain(String(MIN_HISTORY));
    // A 100% failure rate over three observations is arithmetic, not a reading,
    // and must not leak out as one.
    expect(found.standingDetail).not.toContain('100%');
  });

  it('is unknown with zero observations when the graph has never seen this', () => {
    const found = withHistory(null);

    expect(found.standing).toBe('unknown');
    expect(Object.keys(found)).not.toContain('history');
    expect(found.standingDetail).toContain('0 observations');
    expect(found.standingDetail).toContain(String(MIN_HISTORY));
  });

  it('counts a single observation in the singular', () => {
    expect(withHistory(history({ observations: 1, failureRate: 0 })).standingDetail).toContain(
      '1 observation ',
    );
  });

  /*
   * The test this module exists for. `new` says the graph has watched this work
   * and it has now stopped; a too-few-observations `unknown` says the graph has
   * no opinion at all. Collapse the two and a reader goes hunting for today's
   * regression on an endpoint nobody has ever measured.
   */
  it('keeps a too-few-observations unknown distinguishable from a new', () => {
    const scarce = withHistory(history({ observations: 3, failureRate: 0 }));
    const plenty = withHistory(history({ observations: 200, failureRate: 0 }));

    expect(scarce.standing).toBe('unknown');
    expect(plenty.standing).toBe('new');
    expect(scarce.standingDetail).not.toBe(plenty.standingDetail);

    // The scarce one names the floor it fell short of and offers no reading.
    expect(scarce.standingDetail).toContain('3 observations');
    expect(scarce.standingDetail).toContain(`${MIN_HISTORY} are needed`);
    expect(scarce.standingDetail).not.toContain('departure');

    // The plentiful one gives the rate it is a departure from, and never implies
    // the graph is short of evidence.
    expect(plenty.standingDetail).toContain('0% of 200 observations');
    expect(plenty.standingDetail).toContain('departure');
    expect(plenty.standingDetail).not.toContain('are needed');

    // Both rates are 0, so the sentence is the only thing separating them.
    expect(scarce.history?.failureRate).toBe(plenty.history?.failureRate);
  });
});

// ── 8. The limit ─────────────────────────────────────────────────────────────

describe('the limit', () => {
  const three = (): FlowPayload =>
    flow([
      step({ stepNumber: 1, networkCalls: [call({ status: 500 }), call({ status: 404 })] }),
      step({ stepNumber: 2, networkCalls: [call({ status: 500 })] }),
    ]);

  it('caps the returned array and keeps the first ones', () => {
    expect(diagnose(three(), barren, 10)).toHaveLength(3);
    expect(diagnose(three(), barren, 2).map((d) => d.step)).toEqual([1, 1]);
  });

  it('returns nothing for a limit of zero or less', () => {
    expect(diagnose(three(), barren, 0)).toEqual([]);
    expect(diagnose(three(), barren, -1)).toEqual([]);
  });

  it('does not ask the caller about failures it is not returning', () => {
    const asked = recorder();
    diagnose(three(), asked.inputs, 1);

    expect(asked.evidenceAsked).toEqual(['net:1.1']);
    expect(asked.historyAsked).toHaveLength(1);
  });
});
