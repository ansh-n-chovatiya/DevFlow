/**
 * The Accumulating Runtime Knowledge Graph, against a real SQLite database.
 *
 * The graph's whole claim is that `frequency`, `failure_rate` and the timing
 * percentiles mean something — that they are counts of what the application
 * did, not counts of what the person driving the extension did. Every number
 * downstream is derived from them: the anomaly thresholds, the ordering in
 * `get_app_architecture`, the baseline a regression is measured against. So
 * most of what is covered here is arithmetic and the conditions it runs under,
 * not the SQL.
 *
 * `mcp-server/` is a second npm package with its own dependencies and no types,
 * so it is reached through a dynamic import of a file URL and given the shape
 * it is used at. `better-sqlite3` resolves from `mcp-server/node_modules`.
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

interface Anomaly {
  type: string;
  id: string;
  name: string;
  issue: string;
  value: number;
  detail: string;
}

interface Architecture {
  totalFlows: number;
  lastSeen: string | null;
  topComponents: {
    id: string;
    name: string;
    source: string | null;
    frequency: number;
    calls: { endpoint: string; frequency: number; failureRate: number }[];
  }[];
  topEndpoints: { id: string; name: string; frequency: number; timingP50Ms: number | null }[];
}

interface Arkg {
  openArkg(dbPath: string): Db;
  closeArkg(): void;
  ingestFlow(flowJson: unknown): void;
  ingestComponentPick(pick: unknown): void;
  getComponent(id: string): (Row & { edges: Row[] }) | null;
  getComponentHistory(id: string, sinceMs?: number): Row[];
  getAnomalies(sinceMs?: number): Anomaly[];
  getBlastRadius(sourceFile: string, lineStart?: number, lineEnd?: number): Row[];
  getAppArchitecture(): Architecture | null;
  pruneOldObservations(retentionDays: number): number;
}

const MODULE_URL = new URL('../mcp-server/arkg.js', import.meta.url).href;
const arkg = (await import(/* @vite-ignore */ MODULE_URL)) as Arkg;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const HOST = 'shop.example.com';

type Json = Record<string, unknown>;

/** A resolved entry in the flow's React component table. */
function source(name: string, file: string | null, line?: number): Json {
  return {
    name,
    status: file ? 'resolved' : 'unresolved',
    ...(file ? { source: file } : {}),
    ...(line ? { line } : {}),
  };
}

function netCall(url: string, over: Json = {}): Json {
  return { url, method: 'GET', status: 200, durationMs: 10, ...over };
}

function step(over: Json = {}): Json {
  return {
    type: 'click',
    url: `https://${HOST}/cart`,
    timestamp: NOW,
    action: 'Clicked "Buy"',
    element: { tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null },
    networkCalls: [],
    consoleLogs: [],
    ...over,
  };
}

function flow(over: Json = {}): Json {
  return {
    id: 'flow-1',
    name: 'Checkout',
    timestamp: NOW,
    startUrl: `https://${HOST}/cart`,
    steps: [step()],
    react: { detected: true, components: {} },
    ...over,
  };
}

/**
 * A flow with one component, one step and one network call the component owns —
 * the smallest shape that produces every node type and every edge type at once.
 */
function fullFlow(over: Json = {}): Json {
  return flow({
    react: { detected: true, components: { 'cart-1': source('CartButton', 'src/Cart.tsx', 12) } },
    steps: [
      step({
        element: {
          tag: 'button',
          cssSelector: 'button',
          xpath: '/button',
          boundingBox: null,
          react: { chain: ['cart-1'], owner: 'cart-1' },
        },
        networkCalls: [netCall(`https://${HOST}/api/cart/42`)],
      }),
    ],
    ...over,
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function open(): Db {
  return arkg.openArkg(':memory:');
}

/** A file-backed database, for the cases that have to survive a close. */
function openFile(): { db: Db; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'devflow-arkg-'));
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

// ── Schema ───────────────────────────────────────────────────────────────────

describe('the schema', () => {
  it('creates every table, and creating them again is a no-op', () => {
    const { path } = openFile();
    arkg.ingestFlow(fullFlow());
    arkg.closeArkg();

    const db = arkg.openArkg(path);

    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_named_flows').n).toBe(1);
    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_components').n).toBe(1);
    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_source_files').n).toBe(1);
    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_api_endpoints').n).toBe(1);
  });

  it('returns the same connection however many times it is opened', () => {
    expect(open()).toBe(open());
  });

  /**
   * `CREATE TABLE IF NOT EXISTS` will not add a column to a table that already
   * exists, so a database created before `timing_samples` was on the edges
   * table would throw on the first write that named it. Dropping the column is
   * how that older database is simulated.
   */
  it('adds columns an older database was created without', () => {
    const { db, path } = openFile();
    db.exec('ALTER TABLE arkg_edges DROP COLUMN timing_samples');
    db.exec('ALTER TABLE arkg_named_flows DROP COLUMN content_hash');
    arkg.closeArkg();

    const migrated = arkg.openArkg(path);
    const edgeColumns = rows(migrated, 'PRAGMA table_info(arkg_edges)').map((c) => c.name);
    const flowColumns = rows(migrated, 'PRAGMA table_info(arkg_named_flows)').map((c) => c.name);

    expect(edgeColumns).toContain('timing_samples');
    expect(flowColumns).toContain('content_hash');
    expect(() => arkg.ingestFlow(fullFlow())).not.toThrow();
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe('ingesting the same flow twice', () => {
  it('counts it once', () => {
    const db = open();
    arkg.ingestFlow(fullFlow());
    arkg.ingestFlow(fullFlow());

    expect(one(db, 'SELECT frequency FROM arkg_components WHERE id = ?', 'cart-1').frequency).toBe(1);
    expect(one(db, 'SELECT frequency FROM arkg_api_endpoints').frequency).toBe(1);
    expect(one(db, 'SELECT frequency FROM arkg_source_files').frequency).toBe(1);
    expect(rows(db, 'SELECT frequency FROM arkg_edges').map((e) => e.frequency)).toEqual([1, 1]);
  });

  it('does not inflate the failure rate of an endpoint that failed once', () => {
    const db = open();
    const failing = fullFlow({
      steps: [step({ networkCalls: [netCall(`https://${HOST}/api/cart/42`, { status: 500 })] })],
    });

    arkg.ingestFlow(failing);
    arkg.ingestFlow(failing);
    arkg.ingestFlow(failing);

    const endpoint = one(db, 'SELECT frequency, failure_rate FROM arkg_api_endpoints');
    expect(endpoint.frequency).toBe(1);
    expect(endpoint.failure_rate).toBe(1);
  });

  it('still refreshes the flow node, so a rename and a re-send both land', () => {
    const db = open();
    arkg.ingestFlow(fullFlow());
    const before = one(db, 'SELECT last_observed_at FROM arkg_named_flows').last_observed_at as number;

    arkg.ingestFlow(fullFlow({ name: 'Checkout, renamed' }));

    const after = one(db, 'SELECT name, step_count, last_observed_at FROM arkg_named_flows');
    expect(after.name).toBe('Checkout, renamed');
    expect(after.step_count).toBe(1);
    expect(after.last_observed_at as number).toBeGreaterThanOrEqual(before);
  });

  /**
   * The guard is the flow id *plus* its content, so editing a recording in the
   * viewer and sending it again is a second observation — which it is.
   */
  it('accumulates again when the steps themselves changed', () => {
    const db = open();
    arkg.ingestFlow(fullFlow());
    arkg.ingestFlow(fullFlow({ steps: [step(), step({ action: 'Clicked "Pay"' })] }));

    expect(one(db, 'SELECT frequency FROM arkg_components WHERE id = ?', 'cart-1').frequency).toBe(2);
    expect(one(db, 'SELECT step_count FROM arkg_named_flows').step_count).toBe(2);
  });

  it('counts two different recordings of the same interaction twice', () => {
    const db = open();
    arkg.ingestFlow(fullFlow());
    arkg.ingestFlow(fullFlow({ id: 'flow-2' }));

    expect(one(db, 'SELECT frequency FROM arkg_components WHERE id = ?', 'cart-1').frequency).toBe(2);
    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_named_flows').n).toBe(2);
  });
});

// ── URL normalisation ────────────────────────────────────────────────────────

describe('endpoint identity', () => {
  function ingestCall(id: string, url: string) {
    arkg.ingestFlow(flow({ id, steps: [step({ action: id, networkCalls: [netCall(url)] })] }));
  }

  it('collapses numeric ids onto one node', () => {
    const db = open();
    ingestCall('f1', `https://${HOST}/api/users/42`);
    ingestCall('f2', `https://${HOST}/api/users/99`);

    const endpoint = one(db, 'SELECT url_pattern, frequency FROM arkg_api_endpoints');
    expect(endpoint.url_pattern).toBe(`${HOST}/api/users/:id`);
    expect(endpoint.frequency).toBe(2);
  });

  /**
   * The case that matters. A UUID-keyed API left uncollapsed grows one node per
   * record, so `frequency` never rises above 1 on any of them and the graph
   * accumulates nothing at all.
   */
  it('collapses UUIDs onto one node', () => {
    const db = open();
    ingestCall('f1', `https://${HOST}/api/orders/6ba7b810-9dad-11d1-80b4-00c04fd430c8`);
    ingestCall('f2', `https://${HOST}/api/orders/3F2504E0-4F89-11D3-9A0C-0305E82C3301`);

    const endpoint = one(db, 'SELECT url_pattern, frequency FROM arkg_api_endpoints');
    expect(endpoint.url_pattern).toBe(`${HOST}/api/orders/:id`);
    expect(endpoint.frequency).toBe(2);
  });

  it('collapses object ids, hashes and slug-hashes', () => {
    const db = open();
    ingestCall('f1', `https://${HOST}/api/docs/507f1f77bcf86cd799439011`);
    ingestCall('f2', `https://${HOST}/api/docs/deadbeefcafe0123`);
    ingestCall('f3', `https://${HOST}/api/orders/checkout-a3f9c2b1d7e4`);

    const patterns = rows(db, 'SELECT url_pattern FROM arkg_api_endpoints ORDER BY url_pattern')
      .map((r) => r.url_pattern);
    expect(patterns).toEqual([`${HOST}/api/docs/:id`, `${HOST}/api/orders/:id`]);
  });

  it('leaves real route words alone', () => {
    const db = open();
    ingestCall('f1', `https://${HOST}/api/users/settings`);
    ingestCall('f2', `https://${HOST}/api/users/notification-preferences`);
    ingestCall('f3', `https://${HOST}/api/v2/oauth2/authorize`);

    const patterns = rows(db, 'SELECT url_pattern FROM arkg_api_endpoints ORDER BY url_pattern')
      .map((r) => r.url_pattern);
    expect(patterns).toEqual([
      `${HOST}/api/users/notification-preferences`,
      `${HOST}/api/users/settings`,
      `${HOST}/api/v2/oauth2/authorize`,
    ]);
  });

  it('drops the query string, which is where the cardinality hides', () => {
    const db = open();
    ingestCall('f1', `https://${HOST}/api/search?q=shoes&page=1`);
    ingestCall('f2', `https://${HOST}/api/search?q=hats&page=9`);

    expect(one(db, 'SELECT url_pattern, frequency FROM arkg_api_endpoints').frequency).toBe(2);
  });

  it('normalises a relative URL too, which never parses as one', () => {
    const db = open();
    ingestCall('f1', '/api/users/42');
    ingestCall('f2', '/api/users/77?cache=0');

    const endpoint = one(db, 'SELECT url_pattern, frequency FROM arkg_api_endpoints');
    expect(endpoint.url_pattern).toBe('/api/users/:id');
    expect(endpoint.frequency).toBe(2);
  });

  it('keeps the method apart, so a GET and a DELETE are two endpoints', () => {
    const db = open();
    ingestCall('f1', `https://${HOST}/api/users/42`);
    arkg.ingestFlow(flow({
      id: 'f2',
      steps: [step({ networkCalls: [netCall(`https://${HOST}/api/users/42`, { method: 'DELETE' })] })],
    }));

    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_api_endpoints').n).toBe(2);
  });
});

// ── Timing ───────────────────────────────────────────────────────────────────

describe('timing percentiles', () => {
  it('accumulate on a node across observations', () => {
    const db = open();
    for (const ms of [10, 20, 30, 40]) {
      arkg.ingestComponentPick({ id: 'cart-1', name: 'CartButton', timingMs: ms });
    }

    const comp = one(db, 'SELECT frequency, timing_p50_ms, timing_p95_ms, timing_samples FROM arkg_components');
    expect(comp.frequency).toBe(4);
    expect(JSON.parse(comp.timing_samples as string)).toEqual([10, 20, 30, 40]);
    expect(comp.timing_p50_ms).toBe(20);
    expect(comp.timing_p95_ms).toBe(40);
  });

  it('accumulate on an endpoint across flows', () => {
    const db = open();
    [10, 20, 900].forEach((ms, i) => {
      arkg.ingestFlow(flow({
        id: `f${i}`,
        steps: [step({ action: `s${i}`, networkCalls: [netCall(`https://${HOST}/api/cart`, { durationMs: ms })] })],
      }));
    });

    const endpoint = one(db, 'SELECT timing_p50_ms, timing_p95_ms FROM arkg_api_endpoints');
    expect(endpoint.timing_p50_ms).toBe(20);
    expect(endpoint.timing_p95_ms).toBe(900);
  });

  /**
   * An edge keeps its own window. Before it did, p50 and p95 were computed from
   * the first sample on insert and never moved again, so every `calls` edge in
   * the graph reported the latency of the first time anybody recorded it.
   */
  it('accumulate on an edge, not just on the endpoint it points at', () => {
    const db = open();
    [10, 20, 900].forEach((ms, i) => {
      arkg.ingestFlow(fullFlow({
        id: `f${i}`,
        steps: [
          step({
            action: `s${i}`,
            element: {
              tag: 'button',
              cssSelector: 'button',
              xpath: '/button',
              boundingBox: null,
              react: { chain: ['cart-1'], owner: 'cart-1' },
            },
            networkCalls: [netCall(`https://${HOST}/api/cart`, { durationMs: ms })],
          }),
        ],
      }));
    });

    const edge = one(db, "SELECT frequency, timing_p50_ms, timing_p95_ms, timing_samples FROM arkg_edges WHERE type = 'calls'");
    expect(edge.frequency).toBe(3);
    expect(JSON.parse(edge.timing_samples as string)).toEqual([10, 20, 900]);
    expect(edge.timing_p50_ms).toBe(20);
    expect(edge.timing_p95_ms).toBe(900);
  });

  it('are left null when nothing timed the call', () => {
    const db = open();
    arkg.ingestFlow(flow({
      steps: [step({ networkCalls: [netCall(`https://${HOST}/api/cart`, { durationMs: null })] })],
    }));

    expect(one(db, 'SELECT timing_p50_ms FROM arkg_api_endpoints').timing_p50_ms).toBeNull();
  });
});

// ── Failure rate ─────────────────────────────────────────────────────────────

describe('the failure rate', () => {
  it('is exactly 0 or 1 on a first observation', () => {
    const db = open();
    arkg.ingestComponentPick({ id: 'a', name: 'A', failed: true });
    arkg.ingestComponentPick({ id: 'b', name: 'B', failed: false });

    expect(one(db, "SELECT failure_rate FROM arkg_components WHERE id = 'a'").failure_rate).toBe(1);
    expect(one(db, "SELECT failure_rate FROM arkg_components WHERE id = 'b'").failure_rate).toBe(0);
  });

  it('rolls forward over the window', () => {
    const db = open();
    const rate = () => one(db, 'SELECT failure_rate FROM arkg_components').failure_rate as number;
    const pick = (failed: boolean) => arkg.ingestComponentPick({ id: 'a', name: 'A', failed });

    pick(true);
    expect(rate()).toBeCloseTo(1, 10);
    pick(false);
    expect(rate()).toBeCloseTo(0.5, 10);
    pick(false);
    expect(rate()).toBeCloseTo(1 / 3, 10);
    pick(true);
    expect(rate()).toBeCloseTo(0.5, 10);
  });

  it('stays at 1 while everything keeps failing', () => {
    const db = open();
    for (let i = 0; i < 10; i++) arkg.ingestComponentPick({ id: 'a', name: 'A', failed: true });

    expect(one(db, 'SELECT failure_rate FROM arkg_components').failure_rate).toBeCloseTo(1, 10);
  });

  it('counts a network call with no status as a failure', () => {
    const db = open();
    arkg.ingestFlow(flow({
      steps: [step({ networkCalls: [netCall(`https://${HOST}/api/cart`, { status: null })] })],
    }));

    expect(one(db, 'SELECT failure_rate FROM arkg_api_endpoints').failure_rate).toBe(1);
  });
});

// ── Edges ────────────────────────────────────────────────────────────────────

describe('the renders edge', () => {
  /**
   * The chain is stored outermost first (`core/react/fiber.ts` reverses a
   * nearest-first walk to make it so), and `renders(A, B)` reads "A renders
   * inside B" — so the deeper component is always the `from`. Getting this
   * backwards would invert every hierarchy the graph reports.
   */
  it('points from the deeper component to the one containing it', () => {
    const db = open();
    arkg.ingestFlow(flow({
      steps: [
        step({
          element: {
            tag: 'button',
            cssSelector: 'button',
            xpath: '/button',
            boundingBox: null,
            react: { chain: ['App', 'CheckoutPage', 'CartButton'], owner: 'CartButton' },
          },
        }),
      ],
    }));

    const edges = rows(db, "SELECT from_node_id, to_node_id FROM arkg_edges WHERE type = 'renders' ORDER BY id");
    expect(edges).toEqual([
      { from_node_id: 'CheckoutPage', to_node_id: 'App' },
      { from_node_id: 'CartButton', to_node_id: 'CheckoutPage' },
    ]);
  });

  it('emits nothing for a chain of one', () => {
    const db = open();
    arkg.ingestFlow(flow({
      steps: [
        step({
          element: {
            tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null,
            react: { chain: ['CartButton'], owner: 'CartButton' },
          },
        }),
      ],
    }));

    expect(one(db, "SELECT COUNT(*) AS n FROM arkg_edges WHERE type = 'renders'").n).toBe(0);
  });
});

describe('the maps_to and calls edges', () => {
  it('link a component to its file and to the endpoint it called', () => {
    const db = open();
    arkg.ingestFlow(fullFlow());

    const edges = rows(db, 'SELECT type, from_node_type, from_node_id, to_node_type FROM arkg_edges ORDER BY type');
    expect(edges).toEqual([
      { type: 'calls', from_node_type: 'component', from_node_id: 'cart-1', to_node_type: 'api_endpoint' },
      { type: 'maps_to', from_node_type: 'component', from_node_id: 'cart-1', to_node_type: 'source_file' },
    ]);
  });

  it('skips the calls edge when the step names no owner', () => {
    const db = open();
    arkg.ingestFlow(flow({
      react: { detected: true, components: { 'cart-1': source('CartButton', 'src/Cart.tsx', 12) } },
      steps: [step({ networkCalls: [netCall(`https://${HOST}/api/cart`)] })],
    }));

    expect(one(db, "SELECT COUNT(*) AS n FROM arkg_edges WHERE type = 'calls'").n).toBe(0);
  });
});

// ── Queries ──────────────────────────────────────────────────────────────────

describe('getComponent', () => {
  it('returns the node with every edge that touches it', () => {
    open();
    arkg.ingestFlow(fullFlow());

    const comp = arkg.getComponent('cart-1');
    expect(comp?.display_name).toBe('CartButton');
    expect(comp?.edges).toHaveLength(2);
  });

  it('returns null for a component nobody has observed', () => {
    open();
    expect(arkg.getComponent('nope')).toBeNull();
  });
});

describe('getComponentHistory', () => {
  /**
   * It walks edges, and an edge records the flow that *created* it — a second
   * flow re-observing the same edge does not overwrite `flow_id`. So a flow
   * reaches the history by way of an edge it was the first to draw, which is
   * why the second flow here calls a different endpoint.
   */
  it('names every flow the component appeared in', () => {
    open();
    arkg.ingestFlow(fullFlow());
    arkg.ingestFlow(fullFlow({
      id: 'flow-2',
      name: 'Cart',
      steps: [
        step({
          element: {
            tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null,
            react: { chain: ['cart-1'], owner: 'cart-1' },
          },
          networkCalls: [netCall(`https://${HOST}/api/checkout`)],
        }),
      ],
    }));

    const history = arkg.getComponentHistory('cart-1');
    expect(history.map((f) => f.id).sort()).toEqual(['flow-1', 'flow-2']);
  });

  it('honours the since bound', () => {
    open();
    arkg.ingestFlow(fullFlow());

    expect(arkg.getComponentHistory('cart-1', 0)).toHaveLength(1);
    expect(arkg.getComponentHistory('cart-1', Date.now() + 60_000)).toEqual([]);
  });

  it('is empty for an unknown component and for an empty graph', () => {
    open();
    expect(arkg.getComponentHistory('nope')).toEqual([]);
  });
});

describe('getBlastRadius', () => {
  function twoComponentsInOneFile() {
    arkg.ingestFlow(flow({
      react: {
        detected: true,
        components: {
          'header-1': source('Header', 'src/App.tsx', 10),
          'footer-1': source('Footer', 'src/App.tsx', 200),
        },
      },
    }));
  }

  it('names every component mapped to the file', () => {
    open();
    twoComponentsInOneFile();

    expect(arkg.getBlastRadius('src/App.tsx').map((c) => c.display_name).sort())
      .toEqual(['Footer', 'Header']);
  });

  it('narrows to a line range', () => {
    open();
    twoComponentsInOneFile();

    expect(arkg.getBlastRadius('src/App.tsx', 1, 50).map((c) => c.display_name)).toEqual(['Header']);
    expect(arkg.getBlastRadius('src/App.tsx', 150, 250).map((c) => c.display_name)).toEqual(['Footer']);
  });

  it('is empty for a file the graph has never seen', () => {
    open();
    expect(arkg.getBlastRadius('src/Nothing.tsx')).toEqual([]);
  });
});

describe('getAnomalies', () => {
  it('is empty on an empty graph', () => {
    open();
    expect(arkg.getAnomalies()).toEqual([]);
  });

  it('says nothing before there are enough observations to say it with', () => {
    open();
    for (let i = 0; i < 29; i++) arkg.ingestComponentPick({ id: 'a', name: 'Flaky', failed: true });

    expect(arkg.getAnomalies()).toEqual([]);
  });

  it('reports a component that keeps failing', () => {
    open();
    for (let i = 0; i < 30; i++) {
      arkg.ingestComponentPick({ id: 'a', name: 'Flaky', sourceFile: 'src/Flaky.tsx', failed: true });
    }

    const anomalies = arkg.getAnomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ type: 'component', issue: 'high_failure_rate', name: 'Flaky' });
    expect(anomalies[0].detail).toContain('100.0% failure rate');
  });

  it('reports an endpoint whose p95 has run away from its p50', () => {
    open();
    for (let i = 0; i < 30; i++) {
      arkg.ingestFlow(flow({
        id: `f${i}`,
        steps: [
          step({
            action: `s${i}`,
            networkCalls: [netCall(`https://${HOST}/api/cart`, { durationMs: i < 27 ? 10 : 5000 })],
          }),
        ],
      }));
    }

    const anomalies = arkg.getAnomalies();
    expect(anomalies.map((a) => a.issue)).toEqual(['timing_spike']);
    expect(anomalies[0].detail).toContain('p95=5000ms');
  });

  it('ignores observations older than the window asked for', () => {
    const db = open();
    for (let i = 0; i < 30; i++) arkg.ingestComponentPick({ id: 'a', name: 'Flaky', failed: true });
    db.prepare('UPDATE arkg_components SET last_observed_at = ?').run(NOW);

    expect(arkg.getAnomalies()).toEqual([]);
    expect(arkg.getAnomalies(0)).toHaveLength(1);
  });
});

describe('getAppArchitecture', () => {
  it('is null until a flow has been ingested', () => {
    open();
    expect(arkg.getAppArchitecture()).toBeNull();
  });

  it('summarises the components, their calls and the busiest endpoints', () => {
    open();
    arkg.ingestFlow(fullFlow());

    const arch = arkg.getAppArchitecture()!;
    expect(arch.totalFlows).toBe(1);
    expect(arch.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(arch.topComponents).toHaveLength(1);
    expect(arch.topComponents[0]).toMatchObject({ name: 'CartButton', source: 'src/Cart.tsx', frequency: 1 });
    expect(arch.topComponents[0].calls[0].endpoint).toBe(`GET ${HOST}/api/cart/:id`);
    expect(arch.topEndpoints[0]).toMatchObject({ name: `GET ${HOST}/api/cart/:id`, frequency: 1 });
  });

  it('orders components by how often they were observed', () => {
    open();
    arkg.ingestComponentPick({ id: 'rare', name: 'Rare' });
    for (let i = 0; i < 5; i++) arkg.ingestComponentPick({ id: 'hot', name: 'Hot' });
    arkg.ingestFlow(flow());

    expect(arkg.getAppArchitecture()!.topComponents.map((c) => c.name)).toEqual(['Hot', 'Rare']);
  });
});

// ── Pruning ──────────────────────────────────────────────────────────────────

describe('pruneOldObservations', () => {
  /** Backdate everything, so the next prune is guaranteed to reach it. */
  function backdate(db: Db, days = 90) {
    const old = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const table of ['arkg_components', 'arkg_api_endpoints', 'arkg_source_files', 'arkg_named_flows']) {
      db.prepare(`UPDATE ${table} SET last_observed_at = ?`).run(old);
    }
  }

  it('removes stale nodes and the edges that pointed at them', () => {
    const db = open();
    arkg.ingestFlow(fullFlow());
    backdate(db);

    expect(arkg.pruneOldObservations(30)).toBe(2);

    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_components').n).toBe(0);
    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_api_endpoints').n).toBe(0);
    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_source_files').n).toBe(0);
    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_named_flows').n).toBe(0);
    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_edges').n).toBe(0);
  });

  it('leaves everything alone when nothing is old enough', () => {
    const db = open();
    arkg.ingestFlow(fullFlow());

    expect(arkg.pruneOldObservations(30)).toBe(0);
    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_edges').n).toBe(2);
  });

  it('is a no-op on an empty graph', () => {
    open();
    expect(arkg.pruneOldObservations(30)).toBe(0);
  });

  /**
   * Ids are only unique within their own table — a source file's id is its
   * path. Matching an edge on the id alone let the pruning of a component cut
   * the edges of an unrelated file that happened to share the string.
   */
  it('does not cut an edge belonging to a node of a different type', () => {
    const db = open();
    arkg.ingestFlow(flow({
      react: {
        detected: true,
        components: {
          collide: source('Stale', 'src/Stale.tsx', 1),
          keeper: source('Keeper', 'collide', 2),
        },
      },
    }));

    const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE arkg_components SET last_observed_at = ? WHERE id = ?').run(old, 'collide');

    expect(arkg.pruneOldObservations(30)).toBe(1);

    const survivors = rows(db, 'SELECT from_node_id, to_node_id FROM arkg_edges');
    expect(survivors).toEqual([{ from_node_id: 'keeper', to_node_id: 'collide' }]);
  });

  it('prunes a large graph in one pass', () => {
    const db = open();
    for (let i = 0; i < 600; i++) {
      arkg.ingestComponentPick({ id: `c${i}`, name: `C${i}`, sourceFile: `src/C${i}.tsx` });
    }
    backdate(db);

    expect(arkg.pruneOldObservations(30)).toBe(600);
    expect(one(db, 'SELECT COUNT(*) AS n FROM arkg_components').n).toBe(0);
  });
});

// ── The closed database ──────────────────────────────────────────────────────

describe('with no database open', () => {
  it('every entry point is a safe no-op rather than a throw', () => {
    expect(() => arkg.ingestFlow(fullFlow())).not.toThrow();
    expect(() => arkg.ingestComponentPick({ name: 'A' })).not.toThrow();
    expect(arkg.getComponent('a')).toBeNull();
    expect(arkg.getComponentHistory('a')).toEqual([]);
    expect(arkg.getAnomalies()).toEqual([]);
    expect(arkg.getBlastRadius('src/A.tsx')).toEqual([]);
    expect(arkg.getAppArchitecture()).toBeNull();
    expect(arkg.pruneOldObservations(30)).toBe(0);
  });
});
