/**
 * What auto-send is allowed to put on the wire.
 *
 * `mcpAutoSend` posts a finished recording with nobody watching, which makes it
 * the one path where an over-share is never noticed. It used to serialise the
 * steps raw — the four `export.send*` switches were read by the Send dialog and
 * by nothing else — so turning network bodies off in Settings and turning
 * auto-send on shipped every un-redacted request and response body anyway.
 *
 * These assert the composition `src/background/index.ts` now builds its payload
 * from, at the seam where it is testable: a service worker registers listeners
 * at import, so the module itself cannot be loaded here.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPayload, pruneSteps } from '../src/features/mcp/send.js';
import { sendDefaults } from '../src/features/export/defaults.js';
import { renumber } from '../src/core/flow/index.js';
import type { FlowReact, Step } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

/** Every switch on, so each test turns off only the one it is about. */
const ALL_ON = {
  'export.sendImages': true,
  'export.sendNetwork': true,
  'export.sendLogs': true,
  'export.sendReact': true,
};

function step(over: Partial<Step> = {}): Step {
  return {
    type: 'click',
    url: 'https://shop.example.com/cart?code=abc123',
    timestamp: NOW,
    action: 'Clicked "Pay"',
    element: {
      tag: 'button',
      cssSelector: 'button',
      xpath: '/button',
      boundingBox: null,
      react: { chain: ['c1'], owner: 'c1' },
    },
    screenshot: 'data:image/jpeg;base64,AAAA',
    screenshotOriginal: 'data:image/jpeg;base64,BBBB',
    consoleLogs: [{ level: 'error', args: ['boom'], timestamp: NOW }],
    networkCalls: [
      {
        method: 'POST',
        url: 'https://shop.example.com/api/pay',
        requestHeaders: {},
        requestBody: '{"card":"4111111111111111"}',
        status: 500,
        responseHeaders: {},
        responseBody: '{"error":"declined"}',
        durationMs: 12,
        timestamp: NOW,
      },
    ],
    ...over,
  } as Step;
}

const REACT: FlowReact = {
  detected: true,
  components: {
    c1: { name: 'PayButton', status: 'resolved', source: 'src/checkout/PayButton.tsx' },
  },
};

/** Exactly what `autoExportToMcp` does, minus the fetch. */
function autoPayload(settings: typeof ALL_ON, steps: Step[] = [step()]) {
  const include = sendDefaults(settings);
  const sending = pruneSteps(renumber(steps), include);
  return buildPayload(
    'flow-1',
    'Flow',
    sending,
    NOW,
    include.react ? REACT : null,
    include,
  );
}

describe('auto-send obeys the switches the Send dialog obeys', () => {
  it('hands over everything when nothing is switched off', () => {
    const sent = autoPayload(ALL_ON).steps[0];
    expect(sent.screenshot).toBeDefined();
    expect(sent.networkCalls).toHaveLength(1);
    expect(sent.consoleLogs).toHaveLength(1);
    expect(sent.element?.react).toBeDefined();
  });

  it('keeps screenshots off the wire when sendImages is off', () => {
    const sent = autoPayload({ ...ALL_ON, 'export.sendImages': false }).steps[0];
    expect(sent.screenshot).toBeUndefined();
    expect(sent.screenshotOriginal).toBeUndefined();
  });

  it('keeps request and response bodies off the wire when sendNetwork is off', () => {
    const payload = autoPayload({ ...ALL_ON, 'export.sendNetwork': false });
    expect(payload.steps[0].networkCalls).toBeUndefined();
    // The card number was in a request body; nothing may carry it.
    expect(JSON.stringify(payload)).not.toContain('4111111111111111');
  });

  it('keeps console output off the wire when sendLogs is off', () => {
    expect(autoPayload({ ...ALL_ON, 'export.sendLogs': false }).steps[0].consoleLogs)
      .toBeUndefined();
  });

  it('keeps source paths off the wire when sendReact is off', () => {
    const payload = autoPayload({ ...ALL_ON, 'export.sendReact': false });
    expect(payload.steps[0].element?.react).toBeUndefined();
    expect(payload.react).toBeUndefined();
    // The table is pruned to what the steps still reference, so dropping the
    // refs has to drop the paths with them — see `pruneSteps`.
    expect(JSON.stringify(payload)).not.toContain('src/checkout/PayButton.tsx');
  });

  it('records what it withheld, so the reader is not guessing', () => {
    const payload = autoPayload({
      'export.sendImages': false,
      'export.sendNetwork': false,
      'export.sendLogs': true,
      'export.sendReact': true,
    });
    expect(payload.omitted).toEqual(['images', 'network']);
  });

  it('renumbers, so a step the reviewer deleted cannot leave a hole', () => {
    const steps = [step({ stepNumber: 7 }), step({ stepNumber: 9 })];
    expect(autoPayload(ALL_ON, steps).steps.map((s) => s.stepNumber)).toEqual([1, 2]);
  });
});

describe('the auto-send path is wired to that composition', () => {
  /*
   * The tests above pin the contract; this one pins the call site, and it is
   * the half that catches the regression. The bug was never that `buildPayload`
   * was wrong — it was that the worker did not call it, and every test of the
   * builder passed throughout. A service worker registers its listeners at
   * import, so the module cannot be loaded into a test; the source is the seam
   * that is left. `tests/settings-module-scope.test.ts` reads source for the
   * same reason.
   */
  const source = readFileSync(
    new URL('../src/background/index.ts', import.meta.url),
    'utf8',
  );
  const autoExport = source.slice(
    source.indexOf('async function autoExportToMcp'),
    source.indexOf('// ── Wiring'),
  );

  it('is present to be checked at all', () => {
    expect(autoExport).not.toBe('');
    expect(autoExport).toContain('mcpAutoSend');
  });

  it('builds its body through the shared builder, not by hand', () => {
    expect(autoExport).toContain('buildPayload(');
    expect(autoExport).toContain('pruneSteps(');
    expect(autoExport).toContain('sendDefaults(');
  });

  it('never serialises the steps it was handed', () => {
    // `JSON.stringify({ …, steps })` — the exact shape of the original defect.
    expect(autoExport).not.toMatch(/JSON\.stringify\(\s*\{/);
    expect(autoExport).not.toMatch(/\bsteps,\s*\}\)/);
  });
});
