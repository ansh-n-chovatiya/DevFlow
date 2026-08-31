/**
 * What the ARKG records about application state, and what it refuses to.
 *
 * Two claims are under test here and they pull in opposite directions. The
 * first is that a state key accumulates: the same `cart` key in the same store
 * has to be one node across every recording, or `change_count` — the only
 * number this node type exists to carry — never rises above 1 and answers
 * nothing. The second is that a `subscribes_to` edge says no more than was
 * seen: `subscribers` is a property of a *store*, so an edge from a component
 * to one of that store's keys would be a cross product wearing the clothes of
 * an observation. Most of what follows asserts one of those two things.
 *
 * `mcp-server/` is a second npm package with its own dependencies and no types,
 * so it is reached through a dynamic import of a file URL and given the shape
 * it is used at, exactly as `arkg.test.ts` does.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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

interface StateKey {
  id: string;
  key: string;
  storeId: string;
  storeKind: string;
  storeLabel: string | null;
  frequency: number;
  changeCount: number;
  lastObservedAt: number;
}

interface Architecture {
  totalFlows: number;
  totalComponents: number;
  topStateKeys?: { key: string; store: string; frequency: number; changeCount: number }[];
}

interface Arkg {
  openArkg(dbPath: string): Db;
  closeArkg(): void;
  ingestFlow(flowJson: unknown): void;
  ingestComponentPick(pick: unknown): void;
  getComponent(id: string): (Row & { edges: Row[] }) | null;
  getStateKeys(sinceMs?: number): StateKey[];
  getAppArchitecture(): Architecture | null;
  pruneOldObservations(retentionDays: number): number;
}

const MODULE_URL = new URL('../mcp-server/arkg.js', import.meta.url).href;
const arkg = (await import(/* @vite-ignore */ MODULE_URL)) as Arkg;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const HOST = 'shop.example.com';

type Json = Record<string, unknown>;

function source(name: string, file: string | null, line?: number): Json {
  return {
    name,
    status: file ? 'resolved' : 'unresolved',
    ...(file ? { source: file } : {}),
    ...(line ? { line } : {}),
  };
}

function step(over: Json = {}): Json {
  return {
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
    networkCalls: [],
    consoleLogs: [],
    ...over,
  };
}

/** One component, one step, and whatever state the case under test needs. */
function flow(over: Json = {}): Json {
  return {
    id: 'flow-1',
    name: 'Checkout',
    timestamp: NOW,
    startUrl: `https://${HOST}/cart`,
    react: { detected: true, components: { 'cart-1': source('CartButton', 'src/Cart.tsx', 12) } },
    steps: [step()],
    ...over,
  };
}

/** A `replace` at one path — the operation shape every case below is built from. */
function op(path: string): Json {
  return { op: 'replace', path, value: 1 };
}

/**
 * The store as one recording described it.
 *
 * `id` defaults to something different from the kind and the label on purpose:
 * it is stable for the life of one recording only, and every test that ingests
 * two recordings varies it, because a node keyed by it would be a new node per
 * Send and every count in this file would be 1.
 */
function store(over: Json = {}): Json {
  return { id: 's1', kind: 'redux', label: 'app', ...over };
}

function stateFlow(stores: Json[], deltasPerStep: Json[][], over: Json = {}): Json {
  return flow({
    state: { read: true, stores },
    steps: deltasPerStep.map((deltas, i) => step({ action: `s${i}`, state: deltas })),
    ...over,
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function open(): Db {
  return arkg.openArkg(':memory:');
}

function openFile(): { db: Db; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'devflow-arkg-state-'));
  tmpDirs.push(dir);
  const path = join(dir, 'arkg.db');
  return { db: arkg.openArkg(path), path };
}

afterEach(() => {
  arkg.closeArkg();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function rows(db: Db, sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...params);
}

function one(db: Db, sql: string, ...params: unknown[]): Row {
  const row = db.prepare(sql).get(...params);
  expect(row, `no row for: ${sql}`).toBeDefined();
  return row!;
}

const keys = (db: Db): Row[] => rows(db, 'SELECT * FROM arkg_state_keys ORDER BY key_name');
const stores = (db: Db): Row[] => rows(db, 'SELECT * FROM arkg_state_stores');
const subscriptions = (db: Db): Row[] =>
  rows(db, "SELECT * FROM arkg_edges WHERE type = 'subscribes_to'");

// ── The flow that carries no state ───────────────────────────────────────────

/**
 * The whole feature has to be invisible to every recording made before it, and
 * to every recording that could not read state. Those are the only two shapes
 * anybody's database currently holds.
 */
describe('a flow with no state', () => {
  it('writes no state rows and no state edges', () => {
    const db = open();
    arkg.ingestFlow(flow());

    expect(stores(db)).toEqual([]);
    expect(keys(db)).toEqual([]);
    expect(subscriptions(db)).toEqual([]);
    // …and the rest of the graph is what it always was: maps_to, and nothing else.
    expect(rows(db, 'SELECT type FROM arkg_edges').map((e) => e.type)).toEqual(['maps_to']);
  });

  it('writes nothing when state capture ran but read nothing', () => {
    const db = open();
    arkg.ingestFlow(flow({ state: { read: false, stores: [], note: 'No store recognised.' } }));

    expect(stores(db)).toEqual([]);
    expect(keys(db)).toEqual([]);
  });

  /**
   * `read: false` with a store list is the shape that catches a guard written
   * on `stores.length` instead of on `read` — a recording that saw a store
   * described but never actually read it.
   */
  it('writes nothing when read is false even though stores were named', () => {
    const db = open();
    arkg.ingestFlow(flow({ state: { read: false, stores: [store({ subscribers: ['cart-1'] })] } }));

    expect(stores(db)).toEqual([]);
    expect(subscriptions(db)).toEqual([]);
  });

  it('is unbothered by a state block with nothing usable in it', () => {
    const db = open();
    expect(() => arkg.ingestFlow(flow({ state: { read: true, stores: [] } }))).not.toThrow();
    expect(() => arkg.ingestFlow(flow({ id: 'f2', state: { read: true } }))).not.toThrow();
    expect(() =>
      arkg.ingestFlow(
        stateFlow([store()], [[{ store: 'nonexistent-store', patch: [op('/cart')] }]], { id: 'f3' }),
      ),
    ).not.toThrow();

    expect(keys(db)).toEqual([]);
  });
});

// ── Identity across recordings ───────────────────────────────────────────────

describe('the same key in the same store, seen twice', () => {
  /**
   * The defect this is written against is keying the node by
   * `StateStoreRef.id`, which is documented stable for the life of *one*
   * recording. That would make two rows here, both with frequency 1 and
   * change_count 1, and the node type would accumulate nothing at all — so the
   * two recordings deliberately disagree about the store's own id.
   */
  it('is one node counting both recordings', () => {
    const db = open();
    arkg.ingestFlow(stateFlow([store({ id: 's1' })], [[{ store: 's1', patch: [op('/cart')] }]]));
    arkg.ingestFlow(
      stateFlow([store({ id: 's-99' })], [[{ store: 's-99', patch: [op('/cart/items/0')] }]], {
        id: 'flow-2',
      }),
    );

    const all = keys(db);
    expect(all).toHaveLength(1);
    expect(all[0].key_name).toBe('cart');
    expect(all[0].frequency).toBe(2);
    expect(all[0].change_count).toBe(2);
    expect(stores(db)).toHaveLength(1);
  });

  it('keeps two stores apart when the app labelled them differently', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow(
        [store({ id: 'a', label: 'app' }), store({ id: 'b', label: 'cart' })],
        [[{ store: 'a', patch: [op('/cart')] }, { store: 'b', patch: [op('/cart')] }]],
      ),
    );

    // One key name, two stores, so two nodes: `cart` in the app store is not
    // `cart` in the cart store.
    expect(keys(db)).toHaveLength(2);
    expect(stores(db)).toHaveLength(2);
  });

  it('keeps two kinds apart under one label', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow(
        [store({ id: 'a', kind: 'redux', label: 'app' }), store({ id: 'b', kind: 'zustand', label: 'app' })],
        [[{ store: 'a', patch: [op('/cart')] }, { store: 'b', patch: [op('/cart')] }]],
      ),
    );

    expect(keys(db)).toHaveLength(2);
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

/**
 * The place a state write is most likely to be wrong, because it is the one
 * that is wrong silently: outside the content-hash guard, `change_count` rises
 * by one on every press of Send and the graph reports a key as changing five
 * times as often as the one beside it because somebody hit the button five
 * times.
 */
describe('re-sending one recording', () => {
  it('counts its state once', () => {
    const db = open();
    const recording = stateFlow(
      [store({ subscribers: ['cart-1'] })],
      [[{ store: 's1', patch: [op('/cart')] }]],
    );

    arkg.ingestFlow(recording);
    arkg.ingestFlow(recording);
    arkg.ingestFlow(recording);

    const key = one(db, 'SELECT * FROM arkg_state_keys');
    expect(key.frequency).toBe(1);
    expect(key.change_count).toBe(1);
    expect(one(db, 'SELECT * FROM arkg_state_stores').frequency).toBe(1);
    expect(one(db, 'SELECT * FROM arkg_state_stores').change_count).toBe(1);
    expect(subscriptions(db).map((e) => e.frequency)).toEqual([1]);
  });

  it('accumulates again when the steps really did change', () => {
    const db = open();
    arkg.ingestFlow(stateFlow([store()], [[{ store: 's1', patch: [op('/cart')] }]]));
    arkg.ingestFlow(
      stateFlow([store()], [
        [{ store: 's1', patch: [op('/cart')] }],
        [{ store: 's1', patch: [op('/cart')] }],
      ]),
    );

    const key = one(db, 'SELECT * FROM arkg_state_keys');
    expect(key.frequency).toBe(2);
    expect(key.change_count).toBe(3);
  });
});

// ── change_count ─────────────────────────────────────────────────────────────

describe('change_count', () => {
  /**
   * The number the node type exists for. It counts *steps whose patch touched
   * this key* — not steps, not operations — so a five-step recording in which
   * `auth` moved once must not report `auth` as changing five times.
   */
  it('counts only the steps whose patch touched the key', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow([store()], [
        [{ store: 's1', patch: [op('/cart/items/0')] }],
        [{ store: 's1', patch: [op('/cart/total')] }],
        [{ store: 's1', patch: [op('/auth/user')] }],
      ]),
    );

    const all = keys(db);
    expect(all.map((k) => [k.key_name, k.change_count])).toEqual([
      ['auth', 1],
      ['cart', 2],
    ]);
    // Both keys were observed in one recording, however often they moved.
    expect(all.map((k) => k.frequency)).toEqual([1, 1]);
  });

  it('counts a step that touched one key three times as one step', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow([store()], [
        [{ store: 's1', patch: [op('/cart/items/0'), op('/cart/items/1'), op('/cart/total')] }],
      ]),
    );

    expect(one(db, 'SELECT * FROM arkg_state_keys').change_count).toBe(1);
  });

  it('is 0 for a key of a store that was described but never moved', () => {
    const db = open();
    arkg.ingestFlow(stateFlow([store({ subscribers: ['cart-1'] })], []));

    // Nothing names a key, so there is no key node — but the store is on file,
    // observed, with nothing having changed in it.
    expect(keys(db)).toEqual([]);
    const only = one(db, 'SELECT * FROM arkg_state_stores');
    expect(only.frequency).toBe(1);
    expect(only.change_count).toBe(0);
  });

  it('ignores a delta whose patch is empty', () => {
    const db = open();
    arkg.ingestFlow(stateFlow([store()], [[{ store: 's1', patch: [] }]]));

    expect(keys(db)).toEqual([]);
    expect(one(db, 'SELECT change_count FROM arkg_state_stores').change_count).toBe(0);
  });
});

// ── JSON Pointer ─────────────────────────────────────────────────────────────

describe('the pointer a patch names its key with', () => {
  /**
   * RFC 6901 escapes `/` as `~1` and `~` as `~0`, and the replacements are
   * ordered: `~1` first, then `~0`. The two obvious cases — a key called `a/b`
   * and a key called `m~n` — come out right in *either* order, which is why the
   * third is here. `~01` is how a key literally called `~1` is written; done in
   * the right order it decodes to `~1`, and in the wrong order `~0` becomes `~`
   * first and the result decodes on to `/` — a key separator the app never had.
   */
  it('un-escapes ~1 and ~0, in that order', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow([store()], [
        [{ store: 's1', patch: [op('/a~1b'), op('/m~0n'), op('/~01/deeper')] }],
      ]),
    );

    expect(keys(db).map((k) => k.key_name).sort()).toEqual(['a/b', 'm~n', '~1']);
  });

  it('takes the first segment, however deep the pointer goes', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow([store()], [[{ store: 's1', patch: [op('/queries/todos/data/0/title')] }]]),
    );

    expect(one(db, 'SELECT key_name FROM arkg_state_keys').key_name).toBe('queries');
  });

  /**
   * The empty pointer replaced the whole store: every key changed and none was
   * named. Charging it to the keys already on file would credit keys it may
   * have deleted and miss the ones it added, so it is counted on the store and
   * on no key — which is why `cart` below still says it changed once.
   */
  it('charges an op at the empty pointer to the store and to no key', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow([store()], [
        [{ store: 's1', patch: [op('/cart')] }],
        [{ store: 's1', patch: [{ op: 'replace', path: '', value: {} }] }],
      ]),
    );

    const all = keys(db);
    expect(all).toHaveLength(1);
    expect(all[0].key_name).toBe('cart');
    expect(all[0].change_count).toBe(1);
    // The store moved in both steps, and that is where the whole-store replace
    // is visible at all.
    expect(one(db, 'SELECT change_count FROM arkg_state_stores').change_count).toBe(2);
  });

  it('mints nothing from a path that is not a pointer', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow([store()], [[{ store: 's1', patch: [{ op: 'replace', path: 'cart', value: 1 }] }]]),
    );

    expect(keys(db)).toEqual([]);
    expect(one(db, 'SELECT change_count FROM arkg_state_stores').change_count).toBe(1);
  });
});

// ── subscribes_to ────────────────────────────────────────────────────────────

/**
 * The honesty test, and the reason this edge points where it does.
 *
 * `subscribers` is a property of a store: a component is on the list because
 * its own fiber depended on the store. Crossing that list with the store's keys
 * would give `CartButton` an edge to `auth` on the strength of nothing, and a
 * reader could not tell that edge from one somebody observed. So the edge is
 * component → store, at the granularity it was seen at.
 */
describe('the subscribes_to edge', () => {
  const twoKeys = (over: Json = {}) =>
    stateFlow(
      [store({ subscribers: ['cart-1'] })],
      [[{ store: 's1', patch: [op('/cart'), op('/auth')] }]],
      over,
    );

  it('points at the store, not at each of the store’s keys', () => {
    const db = open();
    arkg.ingestFlow(twoKeys());

    // Two keys were observed; had the subscriber been crossed with them there
    // would be two edges here, and both would claim more than was seen.
    expect(keys(db)).toHaveLength(2);
    const edges = subscriptions(db);
    expect(edges).toHaveLength(1);
    expect(edges[0].from_node_type).toBe('component');
    expect(edges[0].from_node_id).toBe('cart-1');
    expect(edges[0].to_node_type).toBe('state_store');
    expect(edges[0].to_node_id).toBe(one(db, 'SELECT id FROM arkg_state_stores').id);
    // Nothing anywhere in the graph claims a component reads a particular key.
    expect(rows(db, "SELECT * FROM arkg_edges WHERE to_node_type = 'state_key'")).toEqual([]);
  });

  it('accumulates on the edge across two recordings', () => {
    const db = open();
    arkg.ingestFlow(twoKeys());
    arkg.ingestFlow(twoKeys({ id: 'flow-2' }));

    expect(subscriptions(db).map((e) => e.frequency)).toEqual([2]);
  });

  it('draws one edge per component however often the store lists it', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow([store({ subscribers: ['cart-1', 'cart-1'] })], [[{ store: 's1', patch: [op('/cart')] }]]),
    );

    expect(subscriptions(db).map((e) => e.frequency)).toEqual([1]);
  });

  /**
   * Two of the recording's stores can be one node — two contexts the page gave
   * the same displayName — and a subscriber on both of them read that one node
   * once, not twice.
   */
  it('counts a subscriber once when two of the flow’s stores are one node', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow(
        [store({ id: 'a', subscribers: ['cart-1'] }), store({ id: 'b', subscribers: ['cart-1'] })],
        [[{ store: 'a', patch: [op('/cart')] }]],
      ),
    );

    expect(stores(db)).toHaveLength(1);
    expect(subscriptions(db).map((e) => e.frequency)).toEqual([1]);
    // …and the store itself was observed once, for the same reason.
    expect(one(db, 'SELECT frequency FROM arkg_state_stores').frequency).toBe(1);
  });

  /**
   * An edge from a node that does not exist is unreachable from `getComponent`,
   * which is the only way anything reads these — so a subscriber the recording
   * never described is dropped rather than written against a dangling id.
   */
  it('skips a subscriber the graph has no component row for', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow([store({ subscribers: ['cart-1', 'never-heard-of'] })], [[{ store: 's1', patch: [op('/cart')] }]]),
    );

    expect(subscriptions(db).map((e) => e.from_node_id)).toEqual(['cart-1']);
  });

  /**
   * A component's id in a flow is not necessarily the row it lands on — a pick
   * may have created that row first — and an edge written against the id as it
   * arrived would point at nothing the moment the two were joined.
   */
  it('is written against the row the component landed on, not the id it arrived under', () => {
    const db = open();
    arkg.ingestComponentPick({ name: 'CartButton', sourceFile: 'src/Cart.tsx', sourceLine: 12 });
    arkg.ingestFlow(
      stateFlow([store({ subscribers: ['cart-1'] })], [[{ store: 's1', patch: [op('/cart')] }]]),
    );

    const component = one(db, 'SELECT id FROM arkg_components');
    expect(subscriptions(db).map((e) => e.from_node_id)).toEqual([component.id]);
    expect(arkg.getComponent('cart-1')!.id).toBe(component.id);
  });

  it('comes back from getComponent with the component’s other edges', () => {
    open();
    arkg.ingestFlow(
      stateFlow([store({ subscribers: ['cart-1'] })], [[{ store: 's1', patch: [op('/cart')] }]]),
    );

    const component = arkg.getComponent('cart-1')!;
    expect(component.edges.map((e) => e.type).sort()).toEqual(['maps_to', 'subscribes_to']);
  });
});

// ── Queries ──────────────────────────────────────────────────────────────────

describe('getStateKeys', () => {
  it('is empty on a graph that has never read state', () => {
    open();
    arkg.ingestFlow(flow());
    expect(arkg.getStateKeys()).toEqual([]);
  });

  it('reports the busiest key first, with the store it belongs to', () => {
    open();
    arkg.ingestFlow(
      stateFlow([store()], [
        [{ store: 's1', patch: [op('/auth')] }],
        [{ store: 's1', patch: [op('/cart')] }],
        [{ store: 's1', patch: [op('/cart')] }],
      ]),
    );

    const found = arkg.getStateKeys();
    expect(found.map((k) => k.key)).toEqual(['cart', 'auth']);
    expect(found[0]).toMatchObject({ storeKind: 'redux', storeLabel: 'app', changeCount: 2, frequency: 1 });
    // The store id is the join back to whatever subscribes_to points at.
    expect(found[0].storeId).toBe(found[1].storeId);
  });

  it('honours the since bound', () => {
    open();
    arkg.ingestFlow(stateFlow([store()], [[{ store: 's1', patch: [op('/cart')] }]]));

    expect(arkg.getStateKeys(0)).toHaveLength(1);
    expect(arkg.getStateKeys(Date.now() + 60_000)).toEqual([]);
  });

  it('is a safe no-op with no database open', () => {
    expect(arkg.getStateKeys()).toEqual([]);
  });
});

describe('getAppArchitecture', () => {
  /**
   * The summary is token-budgeted and read by callers written before any of
   * this existed, so a graph with no state has to serialise exactly as it did:
   * the field is absent, not empty.
   */
  it('says nothing about state keys when none have been observed', () => {
    open();
    arkg.ingestFlow(flow());

    expect(Object.keys(arkg.getAppArchitecture()!)).not.toContain('topStateKeys');
  });

  it('names the busiest keys once there are some', () => {
    open();
    arkg.ingestFlow(
      stateFlow([store()], [
        [{ store: 's1', patch: [op('/cart')] }],
        [{ store: 's1', patch: [op('/cart')] }],
        [{ store: 's1', patch: [op('/auth')] }],
      ]),
    );

    const arch = arkg.getAppArchitecture()!;
    expect(arch.topStateKeys).toEqual([
      { key: 'cart', store: 'redux app', frequency: 1, changeCount: 2 },
      { key: 'auth', store: 'redux app', frequency: 1, changeCount: 1 },
    ]);
  });

  it('is bounded, however many keys the app has', () => {
    open();
    arkg.ingestFlow(
      stateFlow([store()], [
        [{ store: 's1', patch: Array.from({ length: 30 }, (_, i) => op(`/k${i}`)) }],
      ]),
    );

    expect(arkg.getStateKeys()).toHaveLength(30);
    expect(arkg.getAppArchitecture()!.topStateKeys).toHaveLength(8);
  });
});

// ── Migration and pruning ────────────────────────────────────────────────────

describe('a database created before state was a node type', () => {
  /**
   * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that exists, but a
   * *new* table is exactly the case it does handle — so an older database picks
   * these up on the next open, and everything already in it is untouched.
   */
  it('gains the tables on the next open, keeping what it held', () => {
    const { db, path } = openFile();
    arkg.ingestFlow(flow());
    db.exec('DROP TABLE arkg_state_stores');
    db.exec('DROP TABLE arkg_state_keys');
    arkg.closeArkg();

    const migrated = arkg.openArkg(path);
    expect(one(migrated, 'SELECT COUNT(*) AS n FROM arkg_state_keys').n).toBe(0);
    expect(one(migrated, 'SELECT COUNT(*) AS n FROM arkg_components').n).toBe(1);

    // The flow it already held still hashes the same, so re-sending it is still
    // a re-send and its component is still one observation.
    arkg.ingestFlow(flow());
    expect(one(migrated, 'SELECT frequency FROM arkg_components').frequency).toBe(1);

    expect(() =>
      arkg.ingestFlow(stateFlow([store()], [[{ store: 's1', patch: [op('/cart')] }]], { id: 'f2' })),
    ).not.toThrow();
    expect(one(migrated, 'SELECT COUNT(*) AS n FROM arkg_state_keys').n).toBe(1);
  });
});

describe('pruneOldObservations', () => {
  it('takes stale state nodes and their edges with it', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow([store({ subscribers: ['cart-1'] })], [[{ store: 's1', patch: [op('/cart')] }]]),
    );

    const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
    for (const table of ['arkg_components', 'arkg_source_files', 'arkg_named_flows', 'arkg_state_stores', 'arkg_state_keys']) {
      db.prepare(`UPDATE ${table} SET last_observed_at = ?`).run(old);
    }

    // The count is components and endpoints, as it always was.
    expect(arkg.pruneOldObservations(30)).toBe(1);
    expect(stores(db)).toEqual([]);
    expect(keys(db)).toEqual([]);
    expect(subscriptions(db)).toEqual([]);
  });

  it('leaves state nodes alone while they are current', () => {
    const db = open();
    arkg.ingestFlow(
      stateFlow([store({ subscribers: ['cart-1'] })], [[{ store: 's1', patch: [op('/cart')] }]]),
    );

    expect(arkg.pruneOldObservations(30)).toBe(0);
    expect(keys(db)).toHaveLength(1);
    expect(subscriptions(db)).toHaveLength(1);
  });
});
