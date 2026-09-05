/**
 * How deep a trace `buildSpanTree` and `flattenTree` survive.
 *
 * The depth is not ours. Spans arrive over the MCP server's unauthenticated
 * `/v1/traces`, and a trace is as deep as the instrumented code made it — one
 * span per frame of a recursive call is an ordinary shape, not an attack. The
 * recursive form of these two walks settled a 1,000-deep tree and threw
 * `RangeError` at 5,000, which one 4 MB delivery holds several times over; and
 * because a chain can be assembled across deliveries under one trace id, no
 * per-request cap can see it coming.
 *
 * These are cheap and deliberately far past anything real. A depth limit was
 * the other option and was rejected: it has to pick a number, and its honest
 * failure for a deeper trace is to drop spans the user recorded and cannot get
 * back. Nothing in either walk needs the call stack, so the bound is simply
 * gone — and the ordering cases below are what keep "iterative" from quietly
 * meaning "in some other order".
 */

import { describe, expect, it } from 'vitest';
import { buildSpanTree, flattenTree, type OtelSpan } from '../src/core/otel/index.js';

/** A span with only the fields the tree walk reads; the rest are absent. */
function span(spanId: string, parentSpanId: string | null, startUnixNano: string): OtelSpan {
  return {
    traceId: 'a'.repeat(32),
    spanId,
    parentSpanId,
    name: `span-${spanId}`,
    kind: 'internal',
    service: 'checkout',
    serviceVersion: null,
    environment: null,
    startUnixNano,
    durationMs: 1,
    failed: false,
    statusMessage: null,
    http: null,
    db: null,
    code: null,
    exception: null,
  };
}

/** One unbroken parent→child chain `depth` spans long. */
function chain(depth: number): OtelSpan[] {
  const spans: OtelSpan[] = [];
  for (let i = 0; i < depth; i++) {
    spans.push(span(`s${i}`, i === 0 ? null : `s${i - 1}`, String(1_000 + i)));
  }
  return spans;
}

/*
 * 30,000 is chosen, not arbitrary. The recursive form of these walks was
 * measured overflowing at 8,000 on this Node, so a depth well past that is what
 * makes these tests mean something; and the linking pass that feeds them was
 * quadratic until this change, so a depth this size would not have completed at
 * all. Both properties are asserted below rather than described.
 */
const DEEP = 30_000;

describe('a trace deeper than the call stack', () => {
  it('builds the tree without overflowing', () => {
    const roots = buildSpanTree(chain(DEEP));

    expect(roots).toHaveLength(1);
    expect(roots[0]?.span.spanId).toBe('s0');
  });

  it('numbers the depth of every span in the chain', () => {
    const flat = flattenTree(buildSpanTree(chain(DEEP)));

    // Each level was set exactly once: a walk that re-visited a node, or one
    // that lost the running depth, shows up at the far end of the chain.
    expect(flat).toHaveLength(DEEP);
    expect(flat[0]?.depth).toBe(0);
    expect(flat[flat.length - 1]?.depth).toBe(DEEP - 1);
  });

  it('flattens it without overflowing', () => {
    expect(flattenTree(buildSpanTree(chain(DEEP)))).toHaveLength(DEEP);
  });
});

/*
 * The linking pass answers "does this span's chain of parents ever end?" once
 * per span and remembers it, instead of re-walking the whole chain per span.
 * These pin the endings that question has to get right — a memo that returned
 * the wrong answer for a cycle would build a tree that loses spans entirely, or
 * one the walks above would never finish.
 */
describe('a trace whose parent links form a cycle', () => {
  it('re-roots a span that is its own parent', () => {
    const roots = buildSpanTree([span('only', 'only', '1000')]);

    expect(roots.map((n) => n.span.spanId)).toEqual(['only']);
  });

  it('keeps every span of a two-span cycle', () => {
    const roots = buildSpanTree([span('a', 'b', '1000'), span('b', 'a', '1100')]);

    // Neither can be below the other without losing one, so both are roots.
    expect(roots.map((n) => n.span.spanId).sort()).toEqual(['a', 'b']);
    expect(flattenTree(roots)).toHaveLength(2);
  });

  it('re-roots a span whose ancestors lead into a cycle it is not part of', () => {
    // `tail` hangs off a 3-span cycle. Walking up from it never ends, so it
    // cannot be linked under a parent — but it must still appear.
    const roots = buildSpanTree([
      span('x', 'z', '1000'),
      span('y', 'x', '1100'),
      span('z', 'y', '1200'),
      span('tail', 'z', '1300'),
    ]);

    expect(flattenTree(roots)).toHaveLength(4);
    expect(roots.map((n) => n.span.spanId)).toContain('tail');
  });

  it('still nests an ordinary trace that happens to sit beside a cycle', () => {
    const roots = buildSpanTree([
      span('loop1', 'loop2', '1000'),
      span('loop2', 'loop1', '1100'),
      span('root', null, '2000'),
      span('child', 'root', '2100'),
    ]);

    const root = roots.find((n) => n.span.spanId === 'root');
    expect(root?.children.map((c) => c.span.spanId)).toEqual(['child']);
    expect(flattenTree(roots)).toHaveLength(4);
  });
});

describe('the order the walks promise', () => {
  it('lists parents before children, each child in start order', () => {
    // Two roots, each with two children, deliberately supplied out of order so
    // a walk that merely happened to preserve input order would not pass.
    const spans = [
      span('r2', null, '2000'),
      span('r1', null, '1000'),
      span('r1b', 'r1', '1200'),
      span('r1a', 'r1', '1100'),
      span('r2b', 'r2', '2200'),
      span('r2a', 'r2', '2100'),
    ];

    const flat = flattenTree(buildSpanTree(spans));

    expect(flat.map((n) => n.span.spanId)).toEqual(['r1', 'r1a', 'r1b', 'r2', 'r2a', 'r2b']);
  });

  it('gives every node the depth of its own level', () => {
    const spans = [
      span('root', null, '1000'),
      span('mid', 'root', '1100'),
      span('leaf', 'mid', '1200'),
      span('sibling', 'root', '1300'),
    ];

    const depths = new Map(
      flattenTree(buildSpanTree(spans)).map((n) => [n.span.spanId, n.depth]),
    );

    expect(depths.get('root')).toBe(0);
    expect(depths.get('mid')).toBe(1);
    expect(depths.get('leaf')).toBe(2);
    expect(depths.get('sibling')).toBe(1);
  });
});
