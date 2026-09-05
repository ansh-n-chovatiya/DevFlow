/**
 * How deep a span chain the receiver will hold, and hand back.
 *
 * `buildSpanTree` and `flattenTree` in `core/otel` walk a span tree by
 * recursion, so a chain's depth is a depth of stack frames. Measured on this
 * build: 1,000 is fine and 5,000 is `RangeError: Maximum call stack size
 * exceeded`. Neither existing bound covers it — one 4MB delivery holds around
 * 18,000 minimal spans, and `MAX_SPANS` allows 50,000 rows which in a line are
 * 50,000 frames.
 *
 * The endpoint is unauthenticated by necessity (`otel.js`'s header says why the
 * origin rule is unavailable here), so the two bounds below are what stands in
 * front of that walk. They are tested separately because they catch different
 * shapes: one deep delivery, and a deep chain assembled out of shallow ones.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Only what this file touches — `tests/arkg.test.ts` sets the pattern. */
interface Otel {
  openSpanStore(path: string): unknown;
  closeSpanStore(): void;
  handleOtlpPost(body: string, contentType: string): {
    status: number;
    body: { partialSuccess: { rejectedSpans?: number; errorMessage?: string } };
  };
  spansForTraces(traceIds: string[]): unknown[];
  spanStoreStats(): { spans: number };
}

interface Core {
  buildSpanTree(spans: unknown[]): unknown[];
  flattenTree(roots: unknown[]): unknown[];
}

process.env.DEVFLOW_OTEL = '1';
const otel = (await import(/* @vite-ignore */ new URL('../mcp-server/otel.js', import.meta.url).href)) as Otel;
const core = (await import(/* @vite-ignore */ new URL('../mcp-server/core.js', import.meta.url).href)) as Core;

const TRACE = 'a'.repeat(32);
let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-audit-otel-'));
  otel.openSpanStore(path.join(home, 'spans.db'));
});

afterEach(() => {
  otel.closeSpanStore();
  fs.rmSync(home, { recursive: true, force: true });
});

/** `count` spans, each the child of the one before it, starting at `from`. */
function chain(count: number, from = 0): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
        scopeSpans: [
          {
            spans: Array.from({ length: count }, (_unused, i) => ({
              traceId: TRACE,
              spanId: String(i + from).padStart(16, '0'),
              parentSpanId: i + from === 0 ? '' : String(i + from - 1).padStart(16, '0'),
              name: 'op',
              kind: 1,
              startTimeUnixNano: String(1_700_000_000_000_000_000n + BigInt(i + from)),
              endTimeUnixNano: String(1_700_000_000_001_000_000n + BigInt(i + from)),
            })),
          },
        ],
      },
    ],
  });
}

describe('one delivery carrying a chain deeper than the cap', () => {
  it('holds what fits and tells the exporter what it dropped', () => {
    const answer = otel.handleOtlpPost(chain(5000), 'application/json');

    // OTLP's own channel for this, so an exporter parsing the reply is told
    // rather than left to notice missing spans later.
    expect(answer.status).toBe(200);
    expect(answer.body.partialSuccess.rejectedSpans).toBeGreaterThan(4000);
    expect(answer.body.partialSuccess.errorMessage).toContain('parent chain deeper than');

    expect(otel.spanStoreStats().spans).toBeLessThanOrEqual(256);
  });
});

describe('a chain assembled out of individually shallow deliveries', () => {
  /*
   * The case the ingest check cannot see: each POST carries one span, so no
   * delivery is deep, and the chain only exists once the rows sit together
   * under one trace id. This is why the read funnel bounds what it returns as
   * well — and why rows written before either bound existed are covered too.
   */
  it('is bounded where it is read, so walking it does not overflow the stack', () => {
    for (let i = 0; i < 3000; i += 1) otel.handleOtlpPost(chain(1, i), 'application/json');

    expect(otel.spanStoreStats().spans).toBeGreaterThan(2000);

    const spans = otel.spansForTraces([TRACE]);
    expect(spans.length).toBeLessThanOrEqual(256);

    // The whole point: what comes back can be walked.
    expect(() => core.flattenTree(core.buildSpanTree(spans))).not.toThrow();
  });
});
