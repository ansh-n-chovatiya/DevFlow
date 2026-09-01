/**
 * The `caused_by` edge, and the links it refuses to write.
 *
 * `buildCausalGraph` links events *inside one recording* — `net:1.0` caused
 * `log:1.0` — and those refs are meaningless in a graph that accumulates across
 * recordings. So the claim under test is a projection: a causal link reaches
 * the graph only when both of its ends land on a node the ARKG keys stably, and
 * a link with an end that lands nowhere is dropped rather than given a node
 * invented to hold it. One more is dropped for a second reason — a step and one
 * of its calls is the pair `calls` already draws, out of the same fact — and
 * the test for that is the one that goes red on a graph counting a single
 * observation twice.
 *
 * The other claim is that the evidence survives the trip: a `followed` link and
 * a `named` one between the same two nodes are two different claims and must
 * never come back as one.
 *
 * The builder is mocked so that each case can name its own links, but only the
 * builder: `parseEventRef` is the real one, because the ref syntax belongs to
 * `core/causal` and a test that mocked its reader too would be asserting this
 * file's guess at the grammar. The last three cases drop the mock entirely.
 *
 * `mcp-server/` is a second npm package with its own dependencies and no types,
 * so it is reached through a dynamic import of a file URL and given the shape
 * it is used at, exactly as `arkg.test.ts` does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── The mocked builder ───────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/**
 * Hoisted, because `vi.mock` is: the factory runs before this file's top-level
 * code, so the links each test wants have to be reachable through a box that
 * already exists. `build` of null and `parser` of false are the two
 * installed-bundle-without-the-symbol cases, both of which the ingestion has to
 * survive; `actual` is the real builder, kept so the last cases can drive the
 * whole thing end to end rather than against refs written out by hand.
 */
const causal = vi.hoisted(() => ({
  build: null as null | ((flow: Json) => unknown),
  actual: null as null | ((flow: Json) => unknown),
  format: null as null | ((kind: string, step: number, index?: number | string) => string),
  parser: true,
}));

vi.mock('../mcp-server/core.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  causal.actual = actual.buildCausalGraph as (flow: Json) => unknown;
  causal.format = actual.eventRef as (kind: string, step: number, index?: number | string) => string;
  return {
    ...actual,
    get buildCausalGraph() {
      return causal.build ?? undefined;
    },
    get parseEventRef() {
      return causal.parser ? actual.parseEventRef : undefined;
    },
  };
});

// ── The module under test ────────────────────────────────────────────────────

type Row = Record<string, string | number | null>;

interface Statement {
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
  run(...params: unknown[]): unknown;
}

interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
}

interface CausalEdge {
  effect: { type: string; id: string };
  cause: { type: string; id: string };
  basis: string;
  confidence: string;
  frequency: number;
}

interface Arkg {
  openArkg(dbPath: string): Db;
  closeArkg(): void;
  ingestFlow(flowJson: unknown): void;
  getComponent(id: string): (Row & { edges: Row[] }) | null;
  getCausalEdges(nodeType: string, nodeId: string): CausalEdge[];
}

const MODULE_URL = new URL('../mcp-server/arkg.js', import.meta.url).href;
const arkg = (await import(/* @vite-ignore */ MODULE_URL)) as Arkg;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const HOST = 'shop.example.com';

/**
 * One recording with one of everything a causal link can name: a step with a
 * React owner, a network call, a console error, and a store that moved.
 *
 * No ref is written out by hand anywhere below. The numbering inside one is the
 * module's and it has already changed once while this was being written — a
 * base, a separator — so a fixture quoting `net:1.0` would be a test agreeing
 * with the code about a grammar neither of them owns, and both would go quietly
 * wrong together. `REF` reads the refs back off the real builder and `ref()`
 * composes an unresolvable one with the module's own formatter.
 */
function flow(over: Json = {}): Json {
  return {
    id: 'flow-1',
    name: 'Checkout',
    timestamp: NOW,
    startUrl: `https://${HOST}/cart`,
    react: {
      detected: true,
      components: { 'cart-1': { name: 'CartButton', status: 'resolved', source: 'src/Cart.tsx', line: 12 } },
    },
    state: { read: true, stores: [{ id: 's1', kind: 'redux', label: 'app', subscribers: [] }] },
    steps: [
      {
        type: 'click',
        url: `https://${HOST}/cart`,
        timestamp: NOW,
        action: 'Clicked "Buy"',
        element: {
          tag: 'button',
          cssSelector: 'button',
          xpath: '/button',
          boundingBox: null,
          react: { chain: ['cart-1'], owner: 'cart-1' },
        },
        networkCalls: [{ url: `https://${HOST}/api/cart`, method: 'GET', status: 200, durationMs: 10, timestamp: NOW }],
        consoleLogs: [{ level: 'error', text: 'boom', args: ['boom'], timestamp: NOW + 5 }],
        state: [{ store: 's1', patch: [{ op: 'replace', path: '/cart', value: 'sku-42-blue-xl' }] }],
      },
    ],
    ...over,
  };
}

function link(from: string, to: string, basis: string, confidence: string): Json {
  return { from, to, basis, confidence, detail: `${from} → ${to}` };
}

/**
 * A chosen link list over the real event list.
 *
 * The events are the module's own, because the step numbering lives in them —
 * a ref names step 1, not `steps[0]` — and a fixture making its own events up
 * would be free to number them the way this file guessed. Only the links are
 * dictated, which is the part each case is about.
 */
function links(...list: Json[]): void {
  causal.build = (flowJson) => ({
    events: (causal.actual!(flowJson) as { events: unknown[] }).events,
    links: list,
  });
}

interface Event {
  ref: string;
  kind: string;
}

/** The refs the real builder gives this fixture, by kind, in its own order. */
function refsOf(flowJson: Json): Record<string, string[]> {
  const events = (causal.actual!(flowJson) as { events: Event[] }).events;
  const out: Record<string, string[]> = { step: [], network: [], console: [], state: [] };
  for (const event of events) out[event.kind]?.push(event.ref);
  return out;
}

const REF = refsOf(flow());

/** A ref for something that is not there, written by the module's formatter. */
const ref = (kind: string, step: number, index?: number | string): string =>
  causal.format!(kind, step, index);

/** The link every case that wants a written edge uses: a step moved a store. */
const MOVED_THE_STORE: [string, string] = [REF.step[0], REF.state[0]];

// ── Lifecycle ────────────────────────────────────────────────────────────────

function open(): Db {
  return arkg.openArkg(':memory:');
}

beforeEach(() => {
  causal.build = null;
  causal.parser = true;
});

afterEach(() => {
  arkg.closeArkg();
});

function rows(db: Db, sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...params);
}

const causalEdges = (db: Db): Row[] =>
  rows(db, "SELECT * FROM arkg_edges WHERE type LIKE 'caused_by:%' ORDER BY type");

const allEdges = (db: Db): Row[] => rows(db, 'SELECT * FROM arkg_edges');

// ── Nothing to say ───────────────────────────────────────────────────────────

/**
 * Four ways a recording yields no causal edge, and none of them may cost the
 * recording the rest of what it had to say. The first is every flow ingested
 * before this existed; the second and third are every copy of the server
 * package whose bundled `core.js` predates the module.
 */
describe('a flow with no causal links', () => {
  it('writes no caused_by edges and leaves the rest of the ingestion alone', () => {
    const db = open();
    links();
    arkg.ingestFlow(flow());

    expect(causalEdges(db)).toEqual([]);
    expect(rows(db, 'SELECT * FROM arkg_components')).toHaveLength(1);
    expect(rows(db, 'SELECT * FROM arkg_api_endpoints')).toHaveLength(1);
  });

  it('ingests normally when the bundle has no builder in it at all', () => {
    const db = open();
    expect(() => arkg.ingestFlow(flow())).not.toThrow();

    expect(causalEdges(db)).toEqual([]);
    expect(rows(db, 'SELECT * FROM arkg_components')).toHaveLength(1);
  });

  /**
   * A bundle carrying the builder and not its ref reader is the same answer.
   * Splitting a ref here instead would be a second copy of a syntax only one
   * module owns, and it would be the copy nobody notices going stale.
   */
  it('writes nothing rather than parsing a ref itself when the reader is absent', () => {
    const db = open();
    causal.parser = false;
    links(link(...MOVED_THE_STORE, 'attributed', 'medium'));

    expect(() => arkg.ingestFlow(flow())).not.toThrow();
    expect(causalEdges(db)).toEqual([]);
    expect(rows(db, 'SELECT * FROM arkg_state_stores')).toHaveLength(1);
  });

  it('keeps everything else a recording said when the builder throws', () => {
    const db = open();
    causal.build = () => {
      throw new Error('unparseable');
    };

    expect(() => arkg.ingestFlow(flow())).not.toThrow();
    expect(causalEdges(db)).toEqual([]);
    expect(rows(db, 'SELECT * FROM arkg_components')).toHaveLength(1);
  });
});

// ── The projection ───────────────────────────────────────────────────────────

describe('which links reach the graph', () => {
  it('projects a step onto its component and a state event onto its store', () => {
    const db = open();
    links(link(...MOVED_THE_STORE, 'attributed', 'medium'));
    arkg.ingestFlow(flow());

    const edges = causalEdges(db);
    expect(edges).toHaveLength(1);
    // from is the effect and to is the cause, so the type reads as a sentence.
    expect(edges[0].from_node_type).toBe('state_store');
    expect(edges[0].to_node_type).toBe('component');
    expect(edges[0].to_node_id).toBe('cart-1');
    // The store, never one of its keys: a patch names a key, but the node a
    // causal link lands on is the one the recording keyed stably.
    expect(
      rows(db, "SELECT * FROM arkg_edges WHERE from_node_type = 'state_key' OR to_node_type = 'state_key'"),
    ).toEqual([]);
  });

  it('projects a network event onto its endpoint', () => {
    const db = open();
    links(link(REF.network[0], REF.state[0], 'echoed', 'high'));
    arkg.ingestFlow(flow());

    const edges = causalEdges(db);
    expect(edges).toHaveLength(1);
    expect(edges[0].from_node_type).toBe('state_store');
    expect(edges[0].to_node_type).toBe('api_endpoint');
  });

  /**
   * The pair the graph already draws. `calls` is built from the recorder having
   * filed this call under this step, and `attributed` is a second name for that
   * same fact — so a `caused_by` row beside it would let a reader add two
   * frequencies and get a number nothing observed.
   */
  it('writes no caused_by for a step and its own call, which calls already says', () => {
    const db = open();
    links(link(REF.step[0], REF.network[0], 'attributed', 'medium'));
    arkg.ingestFlow(flow());

    expect(causalEdges(db)).toEqual([]);
    expect(rows(db, "SELECT * FROM arkg_edges WHERE type = 'calls'")).toHaveLength(1);
  });

  /**
   * The case the whole projection exists for. A console entry's identity is a
   * message string and this graph keys no such node, so a link with a `log:`
   * end is dropped — not landed on a node invented to hold it, and not folded
   * through into an edge between the two events either side of it, which is a
   * transitive claim nothing observed.
   */
  it('writes nothing for a link whose end has no stable node', () => {
    const db = open();
    links(
      link(REF.network[0], REF.console[0], 'echoed', 'high'),
      link(REF.console[0], REF.state[0], 'followed', 'medium'),
      link(REF.step[0], REF.console[0], 'named', 'high'),
    );
    arkg.ingestFlow(flow());

    expect(causalEdges(db)).toEqual([]);
    const types = new Set(allEdges(db).flatMap((e) => [e.from_node_type, e.to_node_type]));
    expect([...types].sort()).toEqual(['api_endpoint', 'component', 'source_file']);
  });

  it('drops a ref naming a step, a call or a delta the recording does not have', () => {
    const db = open();
    links(
      link(ref('step', 9), REF.state[0], 'attributed', 'medium'),
      link(ref('network', 1, 7), REF.state[0], 'echoed', 'high'),
      // A store the recording never described.
      link(REF.step[0], ref('state', 1, 'nosuch/1'), 'attributed', 'medium'),
      link('sketch:1', REF.state[0], 'attributed', 'medium'),
    );
    arkg.ingestFlow(flow());

    expect(causalEdges(db)).toEqual([]);
  });

  it('writes no self-loop when both ends land on one node', () => {
    const db = open();
    const twoCalls = flow({
      steps: [
        {
          ...(flow().steps as Json[])[0],
          networkCalls: [
            { url: `https://${HOST}/api/cart/1`, method: 'GET', status: 200, durationMs: 10, timestamp: NOW },
            { url: `https://${HOST}/api/cart/2`, method: 'GET', status: 200, durationMs: 10, timestamp: NOW },
          ],
        },
      ],
    });
    const calls = refsOf(twoCalls).network;
    links(link(calls[0], calls[1], 'followed', 'low'));
    arkg.ingestFlow(twoCalls);

    // Both URLs normalise to one endpoint pattern, so the link is one node
    // twice — and a node did not cause itself.
    expect(rows(db, 'SELECT * FROM arkg_api_endpoints')).toHaveLength(1);
    expect(causalEdges(db)).toEqual([]);
  });
});

// ── The evidence ─────────────────────────────────────────────────────────────

describe('basis and confidence', () => {
  it('survive onto the row and come back off it', () => {
    const db = open();
    links(link(...MOVED_THE_STORE, 'named', 'high'));
    arkg.ingestFlow(flow());

    expect(causalEdges(db)[0].type).toBe('caused_by:named:high');

    const edges = arkg.getCausalEdges('component', 'cart-1');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ basis: 'named', confidence: 'high' });
    expect(edges[0].cause).toEqual({ type: 'component', id: 'cart-1' });
    expect(edges[0].effect.type).toBe('state_store');
  });

  /**
   * The failure this shape exists to prevent: two links between one pair of
   * nodes, one of them evidence and one of them a guess. Folded into a single
   * row, either would wear the other's basis — a guessed edge presented as a
   * known one.
   */
  it('keep a named link and a followed one apart between the same two nodes', () => {
    open();
    links(link(...MOVED_THE_STORE, 'named', 'high'));
    arkg.ingestFlow(flow());
    links(link(...MOVED_THE_STORE, 'followed', 'low'));
    arkg.ingestFlow(flow({ id: 'flow-2' }));

    const edges = arkg.getCausalEdges('component', 'cart-1');
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => `${e.basis}/${e.confidence}`).sort()).toEqual(['followed/low', 'named/high']);
    expect(edges.every((e) => e.frequency === 1)).toBe(true);
  });

  it('refuses a basis or a confidence that would not survive the type', () => {
    const db = open();
    links(
      link(...MOVED_THE_STORE, 'made:up', 'high'),
      link(...MOVED_THE_STORE, 'named', 'very high'),
      { from: MOVED_THE_STORE[0], to: MOVED_THE_STORE[1], confidence: 'high' },
    );
    arkg.ingestFlow(flow());

    expect(causalEdges(db)).toEqual([]);
  });

  /**
   * `getComponent` lists relations, one row each; a causal edge is one row per
   * kind of evidence, so it is asked for by name instead. A reader counting a
   * component's edges must not find one store there twice because two sorts of
   * evidence pointed at it.
   */
  it('stay out of the structural edge list and answer to getCausalEdges', () => {
    open();
    links(link(...MOVED_THE_STORE, 'attributed', 'medium'));
    arkg.ingestFlow(flow());

    const types = (arkg.getComponent('cart-1')?.edges ?? []).map((e) => e.type).sort();
    expect(types).toEqual(['calls', 'maps_to']);
    expect(arkg.getCausalEdges('component', 'cart-1')).toHaveLength(1);
  });
});

// ── Accumulation ─────────────────────────────────────────────────────────────

describe('re-sending one recording', () => {
  /**
   * The same guard `ingestState` sits behind. A causal edge's frequency is how
   * many recordings showed one thing following from another, and pressing Send
   * twice on one recording is not a second showing — so a `caused_by` write
   * outside the content-hash guard would report the same evidence twice.
   */
  it('counts its causal edges once', () => {
    const db = open();
    links(link(...MOVED_THE_STORE, 'attributed', 'medium'));
    arkg.ingestFlow(flow());
    arkg.ingestFlow(flow());
    arkg.ingestFlow(flow());

    const edges = causalEdges(db);
    expect(edges).toHaveLength(1);
    expect(edges[0].frequency).toBe(1);
  });

  it('counts a genuinely new recording again', () => {
    const db = open();
    links(link(...MOVED_THE_STORE, 'attributed', 'medium'));
    arkg.ingestFlow(flow());
    arkg.ingestFlow(flow({ id: 'flow-2' }));

    expect(causalEdges(db)[0].frequency).toBe(2);
  });
});

// ── Against the real builder ─────────────────────────────────────────────────

/**
 * Every case above writes its own links, which is a test agreeing with the code
 * about a grammar neither of them owns. These hand the fixture to the real
 * `buildCausalGraph` and check what comes out the other end, so a change to the
 * step numbering or to the shape of a state ref fails here rather than quietly
 * writing nothing for ever.
 */
describe('the module that actually finds the links', () => {
  /** A failed request, an error log naming its path, and a store that moved. */
  function failingFlow(): Json {
    const base = flow();
    const first = (base.steps as Json[])[0];
    return {
      ...base,
      steps: [
        {
          ...first,
          networkCalls: [
            { url: `https://${HOST}/api/cart`, method: 'GET', status: 500, durationMs: 10, timestamp: NOW },
          ],
          consoleLogs: [
            { level: 'error', text: 'failed /api/cart', args: ['failed /api/cart'], timestamp: NOW + 5 },
          ],
        },
      ],
    };
  }

  it('lands its step attribution on the store and nothing at all on the log', () => {
    const db = open();
    causal.build = causal.actual!;
    arkg.ingestFlow(failingFlow());

    /*
     * The builder finds five links here: the step attributed to its call, its
     * log and its delta, and the log named and followed from the failed
     * request. Three of them end on the console entry and one is the pair
     * `calls` already draws, so one survives.
     */
    expect(causalEdges(db).map((e) => `${e.type} ${e.from_node_type}<-${e.to_node_type}`)).toEqual([
      'caused_by:attributed:medium state_store<-component',
    ]);

    const causes = arkg.getCausalEdges('component', 'cart-1');
    expect(causes).toHaveLength(1);
    expect(causes[0].cause.id).toBe('cart-1');
    expect(causes[0].effect.type).toBe('state_store');
  });

  /**
   * The other pair that survives, and the one no other edge in this graph can
   * express: the value this patch wrote came back in that response.
   */
  it('lands an echoed response on the endpoint that returned it', () => {
    const db = open();
    causal.build = causal.actual!;
    const echoing = failingFlow();
    const step = (echoing.steps as Json[])[0];
    // Long enough for the module to treat it as identifying — a short value
    // appears in half the bodies an app sends and is not evidence of anything.
    (step.networkCalls as Json[])[0].responseBody = JSON.stringify({ sku: 'sku-42-blue-xl' });
    arkg.ingestFlow(echoing);

    const echoed = causalEdges(db).filter((e) => String(e.type).includes('echoed'));
    expect(echoed).toHaveLength(1);
    expect(echoed[0].from_node_type).toBe('state_store');
    expect(echoed[0].to_node_type).toBe('api_endpoint');
  });

  it('counts one recording once through the real builder too', () => {
    const db = open();
    causal.build = causal.actual!;
    arkg.ingestFlow(failingFlow());
    arkg.ingestFlow(failingFlow());

    expect(causalEdges(db).every((e) => e.frequency === 1)).toBe(true);
  });

  /**
   * The projection is many-to-one, and that is where a single observation gets
   * counted twice.
   *
   * Every delta of one store lands on that store's one node, so a response
   * echoed into two keys of one store is two links and one fact: that
   * endpoint's body reached that store, seen once. The step's `attributed`
   * links collapse the same way. `frequency` is how many recordings showed the
   * thing, so both edges here have to read 1 off a single recording — a 2 is a
   * number no reader could arrive at from the recordings on disk.
   */
  it('counts one recording once when two of its links land on one edge', () => {
    const db = open();
    causal.build = causal.actual!;

    const echoing = flow();
    const step = (echoing.steps as Json[])[0];
    (step.networkCalls as Json[])[0].responseBody = JSON.stringify({
      a: 'sku-42-blue-xl',
      b: 'tok-99-green-lg',
    });
    // Two deltas, one store: two `echoed` links and two `attributed` ones, onto
    // one `state_store` node either way.
    step.state = [
      { store: 's1', patch: [{ op: 'replace', path: '/cart', value: 'sku-42-blue-xl' }] },
      { store: 's1', patch: [{ op: 'replace', path: '/auth', value: 'tok-99-green-lg' }] },
    ];
    arkg.ingestFlow(echoing);

    const edges = causalEdges(db);
    // Both bases survive as their own rows — collapsing is per edge, not across
    // the evidence — and neither counts the one recording twice.
    expect(edges.map((e) => e.type).sort()).toEqual([
      'caused_by:attributed:medium',
      'caused_by:echoed:high',
    ]);
    expect(edges.map((e) => e.frequency)).toEqual([1, 1]);
  });
});
