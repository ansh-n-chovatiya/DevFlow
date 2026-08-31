/**
 * What the graph calls unusual, and against what.
 *
 * The claim under test is that an anomaly is a deviation from the entity's
 * *own* history rather than from a number chosen in advance: the timing test
 * takes the mean and the σ of the entity's own sample window and asks whether
 * that window's p95 sits more than two of them above it. So most of what
 * follows is one entity and the shape of its distribution — a steady one, a
 * spiky one, one that never varied at all — and what the tool says about each.
 *
 * The other claim is about silence. An entity with too few observations is not
 * an anomaly and is not a clean bill of health either, and an empty array
 * cannot say which. `getAnomalyReport` is where the two are told apart, and
 * several tests below assert only that they stay apart.
 *
 * The failure-rate check is still a fixed threshold, because the graph keeps
 * one rolling rate per entity and a scalar has no distribution to take a σ of.
 * That is not a defect under test — it is a documented limit, and the test that
 * matters is that the tool says so rather than dressing a constant as a
 * baseline.
 *
 * `mcp-server/` is a second npm package with its own dependencies and no types,
 * so it is reached through a dynamic import of a file URL and given the shape
 * it is used at, exactly as `arkg.test.ts` does.
 */

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
  basis: string;
  value: number;
  detail: string;
}

interface AnomalyReport {
  minObservations: number;
  examined: number;
  tooNew: number;
  anomalies: Anomaly[];
}

interface Arkg {
  openArkg(dbPath: string): Db;
  closeArkg(): void;
  ingestFlow(flowJson: unknown): void;
  ingestComponentPick(pick: unknown): void;
  getAnomalies(sinceMs?: number): Anomaly[];
  getAnomalyReport(sinceMs?: number): AnomalyReport;
}

const MODULE_URL = new URL('../mcp-server/arkg.js', import.meta.url).href;
const arkg = (await import(/* @vite-ignore */ MODULE_URL)) as Arkg;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HOST = 'shop.example.com';
type Json = Record<string, unknown>;

/**
 * One component, observed once per timing sample.
 *
 * Picks are the shortest way to a window of a chosen shape: one sample per
 * observation, in the order given, which is exactly what `updateTimingStats`
 * stores until the window is full.
 */
function picks(samples: number[], over: Json = {}): void {
  for (const ms of samples) {
    arkg.ingestComponentPick({ id: 'cart-1', name: 'CartButton', sourceFile: 'src/Cart.tsx', timingMs: ms, ...over });
  }
}

/** The same, on an endpoint: one flow per call, so each is its own observation. */
function calls(samples: number[]): void {
  samples.forEach((ms, i) => {
    arkg.ingestFlow({
      id: `f${i}`,
      name: 'Checkout',
      startUrl: `https://${HOST}/cart`,
      react: { detected: true, components: {} },
      steps: [
        {
          type: 'click',
          url: `https://${HOST}/cart`,
          action: `s${i}`,
          element: { tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null },
          networkCalls: [{ url: `https://${HOST}/api/cart`, method: 'GET', status: 200, durationMs: ms }],
          consoleLogs: [],
        },
      ],
    });
  });
}

/** Thirty samples that rise gently: a well-behaved window with a p95 inside 2σ. */
const STEADY = Array.from({ length: 30 }, (_, i) => 100 + i);

/** Thirty samples with a tail broad enough to reach the 95th percentile. */
const SPIKY = [...Array.from({ length: 27 }, () => 10), 5000, 5000, 5000];

// ── Lifecycle ────────────────────────────────────────────────────────────────

function open(): Db {
  return arkg.openArkg(':memory:');
}

afterEach(() => {
  arkg.closeArkg();
});

// ── Not enough to say anything ───────────────────────────────────────────────

/**
 * "Nothing is wrong" and "nothing is known yet" are the same empty list and
 * very different answers, and the reason the report carries two counts beside
 * it. A caller that cannot tell them apart reports a graph two days old as a
 * healthy application.
 */
describe('an entity with too few observations', () => {
  it('is not an anomaly, and is not silence either', () => {
    open();
    picks(SPIKY.slice(0, 29));

    const report = arkg.getAnomalyReport();
    expect(report.anomalies).toEqual([]);
    expect(report.examined).toBe(0);
    expect(report.tooNew).toBe(1);
    expect(report.minObservations).toBe(30);
  });

  it('is told apart from an entity that was looked at and found fine', () => {
    open();
    picks(STEADY);

    const report = arkg.getAnomalyReport();
    expect(report.anomalies).toEqual([]);
    expect(report.examined).toBe(1);
    expect(report.tooNew).toBe(0);
  });

  it('becomes an anomaly on the observation that clears the bar', () => {
    open();
    picks(SPIKY.slice(0, 29));
    expect(arkg.getAnomalyReport().anomalies).toEqual([]);

    picks(SPIKY.slice(29));
    const report = arkg.getAnomalyReport();
    expect(report.examined).toBe(1);
    expect(report.tooNew).toBe(0);
    expect(report.anomalies.map((a) => a.issue)).toEqual(['timing_spike']);
  });

  /**
   * Frequency and window length are different counts. A component picked forty
   * times of which five were timed has been *examined* — the failure threshold
   * applied to it — and still has no distribution to take a σ of.
   */
  it('has no timing baseline while its window is short, however often it was seen', () => {
    open();
    picks([10, 10, 10, 10, 5000]);
    for (let i = 0; i < 30; i++) arkg.ingestComponentPick({ id: 'cart-1', name: 'CartButton', sourceFile: 'src/Cart.tsx' });

    const report = arkg.getAnomalyReport();
    expect(report.examined).toBe(1);
    expect(report.anomalies).toEqual([]);
  });
});

// ── The σ test ───────────────────────────────────────────────────────────────

describe('a p95 measured against the entity own window', () => {
  it('says nothing about a window whose p95 sits inside its own spread', () => {
    open();
    picks(STEADY);

    expect(arkg.getAnomalies()).toEqual([]);
  });

  it('reports a p95 more than 2σ above the window mean, and shows the working', () => {
    open();
    picks(SPIKY);

    const anomalies = arkg.getAnomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ type: 'component', issue: 'timing_spike', basis: 'baseline' });
    // A sentence a reader can check: 27 samples at 10ms and 3 at 5000ms give a
    // mean of 509 and a σ of 1497, and 5000 is three of them above it.
    expect(anomalies[0].detail).toContain('p95=5000ms');
    expect(anomalies[0].detail).toContain('3.0σ above its own baseline');
    expect(anomalies[0].detail).toContain('mean=509ms');
    expect(anomalies[0].detail).toContain('σ=1497ms');
    expect(anomalies[0].detail).toContain('30 recent observations');
  });

  it('measures an endpoint against its own window too', () => {
    open();
    calls(SPIKY);

    const anomalies = arkg.getAnomalies();
    expect(anomalies.map((a) => a.issue)).toEqual(['timing_spike']);
    expect(anomalies[0].type).toBe('api_endpoint');
    expect(anomalies[0].detail).toContain('σ above its own baseline');
  });

  /**
   * The same p95 against two different histories. An endpoint that has always
   * been slow is not deviating from anything, which is the whole difference
   * between a baseline and the constant this used to compare against.
   */
  it('does not report a slow entity that has always been that slow', () => {
    open();
    picks(Array.from({ length: 30 }, (_, i) => 5000 + i));

    expect(arkg.getAnomalies()).toEqual([]);
  });

  /**
   * σ of zero is a distribution with no width, and every deviation from one is
   * infinite. Reporting them would put every perfectly steady entity in the
   * graph at the top of the answer, so a window that never moved reports
   * nothing — it is examined, and it is not an anomaly.
   */
  it('reports nothing for a window with no variance at all', () => {
    open();
    picks(Array.from({ length: 30 }, () => 42));

    const report = arkg.getAnomalyReport();
    expect(report.examined).toBe(1);
    expect(report.anomalies).toEqual([]);
  });

  /**
   * A p95 ignores the top five per cent of its window by construction, so this
   * fires on a broad slow tail and not on one call that once took a second.
   * Stated here because it is a limit of the test, not an accident of it.
   */
  it('is deaf to a lone outlier', () => {
    open();
    picks([...Array.from({ length: 29 }, () => 10), 5000]);

    expect(arkg.getAnomalies()).toEqual([]);
  });
});

// ── The threshold that is not a baseline ─────────────────────────────────────

describe('the failure rate', () => {
  /**
   * The honest limit, asserted rather than described. There is one rolling rate
   * per entity and no distribution of past rates, so this check is a constant —
   * and an answer that let a reader take it for a σ test would be the "guessed
   * edge presented as a known one" failure in another shape.
   */
  it('is reported as a threshold and never described as a baseline', () => {
    open();
    for (let i = 0; i < 30; i++) {
      arkg.ingestComponentPick({ id: 'a', name: 'Flaky', sourceFile: 'src/Flaky.tsx', failed: true });
    }

    const anomalies = arkg.getAnomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ issue: 'high_failure_rate', basis: 'threshold' });
    expect(anomalies[0].detail).toContain('above a fixed 10% threshold');
    expect(anomalies[0].detail).toContain('a threshold and not a baseline');
    expect(anomalies[0].detail).not.toContain('σ above');
    expect(anomalies[0].detail).not.toContain('baseline (');
  });

  it('and the timing test beside it is the one labelled a baseline', () => {
    open();
    picks(SPIKY, { failed: true });

    const anomalies = arkg.getAnomalies();
    const basisFor = Object.fromEntries(anomalies.map((a) => [a.issue, a.basis]));
    expect(basisFor).toEqual({ high_failure_rate: 'threshold', timing_spike: 'baseline' });
  });
});

// ── The shape callers already have ───────────────────────────────────────────

describe('getAnomalies', () => {
  it('is the report list, so nothing reading it has to change', () => {
    open();
    picks(SPIKY);

    expect(arkg.getAnomalies()).toEqual(arkg.getAnomalyReport().anomalies);
  });

  it('is a safe no-op with no database open, report and all', () => {
    expect(arkg.getAnomalies()).toEqual([]);
    expect(arkg.getAnomalyReport()).toEqual({
      minObservations: 30,
      examined: 0,
      tooNew: 0,
      anomalies: [],
    });
  });
});
