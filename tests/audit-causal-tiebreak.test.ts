/**
 * report.md §3.3 P1: two racing candidates for one effect both read
 * `confidence: 'high'`, though `src/core/causal/index.ts`'s own comment on
 * `named` already names the case as ambiguous. ADR 0007 rules out fixing this
 * by stamping a chosen cause onto the event — the fix has to stay inside
 * derivation, so both racing candidates lose the claim to certainty rather
 * than one of them winning it.
 */

import { describe, expect, it } from 'vitest';
import { buildCausalGraph, eventRef } from '../src/core/causal/index.js';
import type {
  CausalConsoleEntry,
  CausalGraph,
  CausalLink,
  CausalNetworkCall,
  CausalStep,
} from '../src/core/causal/index.js';

const step = (over: Partial<CausalStep> = {}): CausalStep => ({
  timestamp: 1000,
  type: 'click',
  action: 'Clicked "Checkout"',
  url: 'https://shop.test/cart',
  ...over,
});

const call = (over: Partial<CausalNetworkCall> = {}): CausalNetworkCall => ({
  method: 'GET',
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

// ── The exact case the code's own comment names ─────────────────────────────

describe('two requests racing to name the same log line', () => {
  // Two requests to one endpoint, then one log line that contains that
  // endpoint's path — the file's own comment on `named` says which of the two
  // it meant is the reader's call, not a tie this file breaks silently.
  const graph = buildCausalGraph({
    steps: [
      step({
        networkCalls: [
          call({ url: 'https://shop.test/api/cart', timestamp: 1010 }),
          call({ url: 'https://shop.test/api/cart', timestamp: 1015 }),
        ],
        consoleLogs: [entry({ args: ['fetching /api/cart now'], timestamp: 1020 })],
      }),
    ],
  });

  const first = eventRef('network', 1, 1);
  const second = eventRef('network', 1, 2);
  const logged = eventRef('console', 1, 1);

  it('no longer lets both racing candidates claim high confidence', () => {
    const toFirst = between(graph, first, logged);
    const toSecond = between(graph, second, logged);

    expect(toFirst).toEqual([expect.objectContaining({ basis: 'named' })]);
    expect(toSecond).toEqual([expect.objectContaining({ basis: 'named' })]);

    expect(toFirst[0].confidence).not.toBe('high');
    expect(toSecond[0].confidence).not.toBe('high');
  });

  it('still names the path — only the confidence, not the evidence, changes', () => {
    const [link] = between(graph, first, logged);
    expect(link.detail).toContain('/api/cart');
  });
});

// ── The audit's own ambiguous-pair shape: two requests racing to explain one
//    state change ──────────────────────────────────────────────────────────

describe('two requests racing to explain one state change', () => {
  // Two calls whose response bodies both carry the identifier one state delta
  // wrote — the same fan-in ambiguity as `named`, over `echoed`.
  const graph = buildCausalGraph({
    steps: [
      step({
        networkCalls: [
          call({
            method: 'POST',
            url: 'https://shop.test/api/cart/1',
            status: 200,
            responseBody: '{"orderId":"ord_8f31c0a2"}',
            timestamp: 1010,
          }),
          call({
            method: 'POST',
            url: 'https://shop.test/api/cart/2',
            status: 200,
            responseBody: '{"orderId":"ord_8f31c0a2"}',
            timestamp: 1015,
          }),
        ],
        state: [
          { store: 'redux', patch: [{ path: '/checkout/orderId', value: 'ord_8f31c0a2' }] },
        ],
      }),
    ],
  });

  const first = eventRef('network', 1, 1);
  const second = eventRef('network', 1, 2);
  const delta = eventRef('state', 1, 'redux/1');

  it('downgrades both echoed candidates instead of keeping them both high', () => {
    const toFirst = between(graph, first, delta);
    const toSecond = between(graph, second, delta);

    expect(toFirst).toEqual([expect.objectContaining({ basis: 'echoed' })]);
    expect(toSecond).toEqual([expect.objectContaining({ basis: 'echoed' })]);

    expect(toFirst[0].confidence).not.toBe('high');
    expect(toSecond[0].confidence).not.toBe('high');
  });
});

// ── Everything that is not ambiguous is untouched ────────────────────────────

describe('a single, unambiguous candidate', () => {
  it('still earns high confidence on `named`', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [call({ url: 'https://shop.test/api/cart', timestamp: 1010 })],
          consoleLogs: [entry({ args: ['fetching /api/cart now'], timestamp: 1020 })],
        }),
      ],
    });

    expect(withBasis(graph.links, 'named')).toEqual([
      expect.objectContaining({ confidence: 'high' }),
    ]);
  });

  it('still earns high confidence on `echoed`', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [
            call({
              status: 200,
              responseBody: '{"orderId":"ord_8f31c0a2"}',
              timestamp: 1010,
            }),
          ],
          state: [
            { store: 'redux', patch: [{ path: '/checkout/orderId', value: 'ord_8f31c0a2' }] },
          ],
        }),
      ],
    });

    expect(withBasis(graph.links, 'echoed')).toEqual([
      expect.objectContaining({ confidence: 'high' }),
    ]);
  });

  it('leaves `attributed` and `followed` scored exactly as before', () => {
    const graph = buildCausalGraph({
      steps: [
        step({
          networkCalls: [
            call({ url: 'https://shop.test/api/one', status: 500, timestamp: 1010 }),
            call({ url: 'https://shop.test/api/two', status: 500, timestamp: 1015 }),
          ],
          consoleLogs: [entry({ level: 'error', args: ['boom'], timestamp: 1030 })],
        }),
      ],
    });

    expect(withBasis(graph.links, 'attributed').every((link) => link.confidence === 'medium')).toBe(
      true,
    );
    expect(withBasis(graph.links, 'followed').every((link) => link.confidence === 'low')).toBe(
      true,
    );
  });
});
