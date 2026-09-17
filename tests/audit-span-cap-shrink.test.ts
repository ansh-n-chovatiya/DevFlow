/**
 * `report.md` §3.7 P2: the 256-span depth cap is untested in the shrink
 * direction. `tests/audit-mcp-otel-depth.test.ts` proves the cap rejects a
 * chain that overshoots it (5,000 deep, or 3,000 shallow deliveries under one
 * trace id) — but every assertion there is a lower bound (`toBeGreaterThan`,
 * `toBeLessThanOrEqual(256)`) that a *tighter* cap still satisfies. Reducing
 * `MAX_SPAN_DEPTH` from 256 to 10 by hand and re-running that file produced
 * zero failures.
 *
 * The shape that actually pins the value is the opposite of "too deep": a
 * chain sitting exactly at today's cap, on both sides of it that enforce the
 * cap (the ingest check in `handleOtlpPost`, and the read-side funnel in
 * `spansForTraces`), must come back *whole*. A chain that size stops
 * resolving fully the moment the cap is tightened under it, which is exactly
 * the mutation the audit found nothing catching.
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

/**
 * The cap as documented in `mcp-server/otel.js` on `MAX_SPAN_DEPTH`. Not
 * imported — the constant isn't exported, and it shouldn't be just for this —
 * so this is the one place that value is retyped. If a future change moves
 * the cap deliberately, this number moves with it and the tests below stay
 * meaningful for the new value; if the cap shrinks *without* this number
 * changing, the tests fail, which is the point.
 */
const CURRENT_CAP = 256;

const TRACE_A = 'a'.repeat(32);
const TRACE_B = 'b'.repeat(32);
let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-audit-span-cap-'));
  otel.openSpanStore(path.join(home, 'spans.db'));
});

afterEach(() => {
  otel.closeSpanStore();
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * `count` spans, each the child of the one before it, starting at `from`.
 *
 * Ids are 1-based (`from + 1`, `from + 2`, ...) rather than starting at 0: a
 * span id of all zeros is OTel's reserved "invalid" id, and `readSpanId`
 * rejects it (`bad-span-id`) before depth is ever considered, which would
 * silently shrink a boundary-sized chain by one and defeat the point of
 * building it exactly at the cap.
 */
function chain(traceId: string, count: number, from = 0): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
        scopeSpans: [
          {
            spans: Array.from({ length: count }, (_unused, i) => ({
              traceId,
              spanId: String(i + from + 1).padStart(16, '0'),
              parentSpanId: i + from === 0 ? '' : String(i + from).padStart(16, '0'),
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

describe('a chain exactly as deep as the cap allows, delivered in one batch', () => {
  it('is held in full, not just partially', () => {
    const answer = otel.handleOtlpPost(chain(TRACE_A, CURRENT_CAP), 'application/json');

    // An empty `partialSuccess` is OTLP's way of saying nothing was dropped.
    // If the cap were tighter than this chain, some spans would be rejected
    // and `partialSuccess` would carry a `rejectedSpans` count instead.
    expect(answer.status).toBe(200);
    expect(answer.body.partialSuccess.rejectedSpans).toBeUndefined();
    expect(otel.spanStoreStats().spans).toBe(CURRENT_CAP);

    const spans = otel.spansForTraces([TRACE_A]);
    expect(spans.length).toBe(CURRENT_CAP);
    expect(() => core.flattenTree(core.buildSpanTree(spans))).not.toThrow();
  });
});

describe('a chain exactly as deep as the cap allows, assembled from shallow deliveries', () => {
  it('is read back in full through spansForTraces, the read-side half of the cap', () => {
    for (let i = 0; i < CURRENT_CAP; i += 1) {
      otel.handleOtlpPost(chain(TRACE_B, 1, i), 'application/json');
    }

    expect(otel.spanStoreStats().spans).toBe(CURRENT_CAP);

    const spans = otel.spansForTraces([TRACE_B]);
    // The read-side funnel (`spansForTraces`) applies the same bound; a chain
    // sitting exactly at the cap must come back whole, not truncated.
    expect(spans.length).toBe(CURRENT_CAP);
    expect(() => core.flattenTree(core.buildSpanTree(spans))).not.toThrow();
  });
});
