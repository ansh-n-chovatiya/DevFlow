/**
 * What a CI regression report is allowed to claim.
 *
 * Almost every case here is about a *refusal*, because the failure that matters
 * in a regression gate is never a missing finding — it is a confident one. Two
 * in particular:
 *
 *   - a wire comparison run in mocked mode, which would be the recording
 *     measured against its own fixtures and would agree perfectly forever;
 *   - a live run whose collector wrote nothing, which compared against the
 *     recording marks every endpoint as never called and reads as a total
 *     outage on a branch that is fine.
 *
 * The third is `runVerdict`, which extends `core/replay`'s rule — everything
 * unrecognised resolves *away* from passing — from one report to a set of them.
 * A gate that says yes when it does not know is worse than no gate.
 */

import { describe, expect, it } from 'vitest';
import type { ReplayVerdict } from '../src/core/replay/index.js';
import type { FlowRun, ObservedCall } from '../src/core/regression/index.js';
import {
  compareWire,
  endpointKey,
  implicatedFiles,
  renderRegressionReport,
  runVerdict,
} from '../src/core/regression/index.js';

const verdict = (over: Partial<ReplayVerdict> = {}): ReplayVerdict => ({
  status: 'passed',
  failures: [],
  ran: 1,
  ...over,
});

const call = (over: Partial<ObservedCall> = {}): ObservedCall => ({
  method: 'GET',
  url: 'https://app.test/api/cart',
  status: 200,
  durationMs: 100,
  ...over,
});

const flowRun = (over: Partial<FlowRun> = {}): FlowRun => ({
  flowId: 'flow-1',
  flowName: 'Checkout',
  verdict: verdict(),
  calls: [],
  recorded: [],
  ...over,
});

describe('endpointKey', () => {
  it('ignores the query, so one endpoint is one row across two runs', () => {
    expect(endpointKey({ method: 'get', url: 'https://a.test/api/cart?page=2' }))
      .toBe(endpointKey({ method: 'GET', url: 'https://a.test/api/cart?page=9' }));
  });

  it('keeps a relative or malformed URL comparable as itself', () => {
    expect(endpointKey({ method: 'POST', url: '/api/x?y=1' })).toBe('POST /api/x');
  });
});

describe('compareWire', () => {
  it('compares nothing in mocked mode, because the responses are the recording’s own', () => {
    const run = flowRun({
      recorded: [call({ status: 200, durationMs: 10 })],
      calls: [call({ status: 500, durationMs: 900 })],
    });
    expect(compareWire(run, 'mocked')).toEqual([]);
  });

  it('compares nothing in live mode when the run observed no wire at all', () => {
    // The dangerous case: an empty observation compared against a recording
    // marks every endpoint "only-then" and reads as a total outage.
    const run = flowRun({ recorded: [call(), call({ url: 'https://app.test/api/user' })], calls: [] });
    expect(compareWire(run, 'live')).toEqual([]);
  });

  it('reports a status that changed', () => {
    const run = flowRun({
      recorded: [call({ status: 200 })],
      calls: [call({ status: 500 })],
    });
    const [change] = compareWire(run, 'live');
    expect(change).toMatchObject({ kind: 'status' });
    expect(change.detail).toContain('answered 500');
    expect(change.detail).toContain('answered 200 when this flow was recorded');
  });

  it('needs both an absolute and a relative bar before it calls something slower', () => {
    // 40ms → 60ms is 50% worse and nobody cares; 8000 → 8400 is 400ms worse and
    // nobody cares either. Both bars keep the report to what a person would act on.
    const small = flowRun({
      recorded: [call({ durationMs: 40 })],
      calls: [call({ durationMs: 60 })],
    });
    const large = flowRun({
      recorded: [call({ durationMs: 8000 })],
      calls: [call({ durationMs: 8400 })],
    });
    const real = flowRun({
      recorded: [call({ durationMs: 100 })],
      calls: [call({ durationMs: 400 })],
    });

    expect(compareWire(small, 'live')).toEqual([]);
    expect(compareWire(large, 'live')).toEqual([]);
    expect(compareWire(real, 'live').map((c) => c.kind)).toEqual(['slower']);
  });

  it('prints the numbers a finding cleared its bar with', () => {
    const run = flowRun({
      recorded: [call({ durationMs: 100 })],
      calls: [call({ durationMs: 400 })],
    });
    expect(compareWire(run, 'live')[0].detail).toContain('100ms → 400ms');
    expect(compareWire(run, 'live')[0].detail).toContain('+300%');
  });

  it('names an endpoint only one side called', () => {
    const run = flowRun({
      recorded: [call({ url: 'https://app.test/api/old' })],
      calls: [call({ url: 'https://app.test/api/new' })],
    });
    expect(compareWire(run, 'live').map((c) => c.kind).sort()).toEqual(['only-now', 'only-then']);
  });
});

describe('runVerdict', () => {
  it('is inconclusive with no flows, rather than clean', () => {
    expect(runVerdict([])).toBe('inconclusive');
  });

  it('resolves away from clean when any flow could not be read', () => {
    expect(runVerdict([flowRun(), flowRun({ verdict: verdict({ status: 'unreadable' }) })]))
      .toBe('inconclusive');
    expect(runVerdict([flowRun(), flowRun({ verdict: verdict({ status: 'no-tests', ran: 0 }) })]))
      .toBe('inconclusive');
  });

  it('prefers inconclusive to regressed when it holds both', () => {
    // A run it could not read is a run whose failures it also cannot trust.
    expect(runVerdict([
      flowRun({ verdict: verdict({ status: 'failed' }) }),
      flowRun({ verdict: verdict({ status: 'unreadable' }) }),
    ])).toBe('inconclusive');
  });

  it('is clean only when every flow passed', () => {
    expect(runVerdict([flowRun(), flowRun()])).toBe('clean');
    expect(runVerdict([flowRun(), flowRun({ verdict: verdict({ status: 'failed' }) })])).toBe('regressed');
  });
});

describe('implicatedFiles', () => {
  it('shortlists only files the graph has watched code run in, and counts the rest', () => {
    const result = implicatedFiles({
      changed: ['src/Cart.tsx', 'src/Never.tsx', 'README.md'],
      prefix: '',
      observed: ['src/Cart.tsx'],
    });
    expect(result).toEqual({ implicated: ['src/Cart.tsx'], unseen: 2 });
  });

  it('strips the repository prefix so a monorepo path can match a source map’s', () => {
    const result = implicatedFiles({
      changed: ['apps/web/src/Cart.tsx'],
      prefix: 'apps/web',
      observed: ['src/Cart.tsx'],
    });
    expect(result.implicated).toEqual(['src/Cart.tsx']);
  });

  it('counts a file outside the project as unseen rather than matching it loosely', () => {
    const result = implicatedFiles({
      changed: ['services/api/handler.ts'],
      prefix: 'apps/web',
      observed: ['src/Cart.tsx'],
    });
    expect(result).toEqual({ implicated: [], unseen: 1 });
  });
});

describe('renderRegressionReport', () => {
  const report = (over: Partial<Parameters<typeof renderRegressionReport>[0]> = {}) =>
    renderRegressionReport({
      mode: 'mocked',
      runs: [flowRun()],
      changedFiles: 0,
      implicated: [],
      unseen: 0,
      observedRenders: false,
      ...over,
    });

  it('names the mode on the first line, because every other line depends on it', () => {
    expect(report().split('\n')[0]).toContain('(mocked mode');
    expect(report({ mode: 'live' }).split('\n')[0]).toContain('(live mode');
  });

  it('says what a pass proves, differently for each mode, on every report', () => {
    expect(report()).toContain('mocked out of this run by construction');
    expect(report({ mode: 'live' })).toContain('against what this branch actually');
  });

  it('says re-renders are not compared, and why, rather than omitting them silently', () => {
    const text = report();
    expect(text).toContain('Re-render counts and state changes are not compared');
    expect(text).toContain('registers in a headed Chromium and does not register in Playwright’s headless');
  });

  it('explains an empty run instead of reporting a clean one', () => {
    const text = report({ runs: [] });
    expect(text).toContain('inconclusive');
    expect(text).toContain('has to be committed to the repository');
  });

  it('says the wire was not observed rather than that nothing was called', () => {
    const text = report({ mode: 'live', runs: [flowRun({ recorded: [call()], calls: [] })] });
    expect(text).toContain('the wire was not observed');
    expect(text).toContain('not a run in which nothing was called');
  });

  it('calls the changed-file list a shortlist and counts what it did not implicate', () => {
    const text = report({ changedFiles: 40, implicated: ['src/Cart.tsx'], unseen: 39 });
    expect(text).toContain('Of 40 changed files, 1 is a file DevFlow has watched code run in');
    expect(text).toContain('39 changed files were not implicated');
    expect(text).toContain('a shortlist to read first, not a cause');
  });
});
