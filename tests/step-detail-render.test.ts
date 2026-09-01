/**
 * The `render` part of `get_step_detail`, against the real server.
 *
 * "Why did this render?" is a question with four different answers that look
 * identical if the part is written the obvious way. Renders were never sampled;
 * the walk stopped at its fiber cap before it had seen the whole tree; nothing
 * re-rendered; here is what re-rendered and why. Only the third is a statement
 * about the application, and a reader handed an empty section takes it as the
 * third every time — which is the one reading that cannot be checked. So each
 * of the four is a different first sentence, and this file is the thing that
 * holds them apart.
 *
 * The claim underneath all of them is what the data can carry. The evidence is
 * two readings of the fiber tree per step, not a commit hook, so the part knows
 * *which* components re-rendered and cannot know how many times any of them
 * did. Nothing in the output may imply a count, and the summary counts
 * components. That is asserted here because it is the kind of sentence that
 * gets added later by somebody being helpful, and no other gate would see it.
 *
 * The producer does not exist yet. These fixtures are hand-written against the
 * frozen contract in `src/shared/types.ts`, which is the point: a part that no
 * tool prints does not exist from outside, and the shape of the printing is
 * what the producer is then written to fill.
 *
 * Why a spawned process rather than an import is in `tests/helpers/mcp-server.ts`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

const NOW = Date.UTC(2026, 8, 1, 11, 0);

let home: string;
let server: McpSession;

const call = (name: string, args: Record<string, unknown>): Promise<string> =>
  server.call(name, args);

/** One step's `render` part, which is what nearly every assertion here is about. */
const renderPart = (id: string, step: number): Promise<string> =>
  call('get_step_detail', { id, step, include: ['render'] });

/** A step with nothing in it but the fields every step must have. */
const bareStep = (stepNumber: number, extra: Record<string, unknown> = {}) => ({
  type: 'click',
  url: 'https://shop.example.com/list',
  timestamp: NOW + stepNumber,
  action: `Clicked "Row ${stepNumber}"`,
  stepNumber,
  element: { tag: 'button', cssSelector: `button.row-${stepNumber}` },
  consoleLogs: [],
  networkCalls: [],
  ...extra,
});

/**
 * The flow where sampling worked, holding one of every entry the contract
 * allows.
 *
 * Step 1 carries a component with all three kinds of change, a wasted one, a
 * bounded one whose value could not be sampled at all, and one whose id the
 * flow does not list. Step 2 carries none, which is the "nothing re-rendered"
 * answer — the only one of the four that is about the app.
 */
function writeRenderFlow(): void {
  writeFlow(home, {
    id: 'flow-render',
    name: 'Filter the list',
    timestamp: NOW,
    startUrl: 'https://shop.example.com/list',
    errorCount: 0,
    schemaVersion: 1,
    react: {
      detected: true,
      components: {
        'list-0': { name: 'ProductList', status: 'resolved', source: 'src/ProductList.tsx', line: 12 },
        'row-0': { name: 'ProductRow', status: 'resolved', source: 'src/ProductRow.tsx', line: 40 },
        'badge-0': { name: 'Badge', status: 'resolved', source: 'src/Badge.tsx', line: 4 },
      },
    },
    renders: { read: true },
    steps: [
      bareStep(1, {
        renders: [
          {
            component: 'list-0',
            props: [{ key: 'items', before: { count: 2 }, after: { count: 3 } }],
            hooks: [{ key: 'hook 2', before: false, after: true }],
            contexts: [{ key: 'theme', before: 'light', after: 'dark' }],
          },
          { component: 'row-0', wasted: true },
          // Bounded, and with a change whose two sides were both dropped —
          // which the contract says is what "too large or too circular to
          // snapshot" looks like from here.
          { component: 'badge-0', bounded: true, props: [{ key: 'payload' }] },
          {
            component: 'ghost-9',
            props: [
              {
                key: 'blob',
                before: 'x'.repeat(400),
                after: Object.fromEntries('abcdefghijkl'.split('').map((k) => [k, 'value'])),
              },
            ],
          },
        ],
      }),
      bareStep(2),
    ],
  });
}

/** Sampling ran and stopped short, which changes what an empty list means. */
function writeCappedFlow(): void {
  writeFlow(home, {
    id: 'flow-capped',
    name: 'Scroll the table',
    timestamp: NOW,
    startUrl: 'https://shop.example.com/table',
    errorCount: 0,
    schemaVersion: 1,
    react: {
      detected: true,
      components: { 'cell-0': { name: 'Cell', status: 'resolved', source: 'src/Cell.tsx', line: 7 } },
    },
    renders: { read: true, capped: true },
    steps: [
      bareStep(1),
      bareStep(2, {
        renders: [{ component: 'cell-0', props: [{ key: 'row', before: 4, after: 5 }] }],
      }),
    ],
  });
}

/** Sampling was switched off, with the recording's own reason for it. */
function writeOffFlow(): void {
  writeFlow(home, {
    id: 'flow-off',
    name: 'Log in',
    timestamp: NOW,
    startUrl: 'https://shop.example.com/login',
    errorCount: 0,
    schemaVersion: 1,
    renders: { read: false, note: 'No fiber root was found on this page.' },
    steps: [bareStep(1)],
  });
}

/**
 * A recording carrying entries the contract does not allow.
 *
 * Flows arrive over an unauthenticated loopback POST from whatever page the
 * browser is on, so "the producer would never send that" is not a reason this
 * part may throw on it.
 */
function writeJunkFlow(): void {
  writeFlow(home, {
    id: 'flow-junk',
    name: 'Malformed renders',
    timestamp: NOW,
    startUrl: 'https://shop.example.com/junk',
    errorCount: 0,
    schemaVersion: 1,
    react: {
      detected: true,
      components: { 'ok-0': { name: 'Header', status: 'resolved', source: 'src/Header.tsx', line: 3 } },
    },
    renders: { read: true },
    steps: [
      bareStep(1, {
        renders: [null, 'nope', 7, { component: 'ok-0', props: [null, { key: 'title', after: 'Cart' }] }],
      }),
    ],
  });
}

/** A recording made before renders were sampled at all — no `renders` key. */
function writeLegacyFlow(): void {
  writeFlow(home, {
    id: 'flow-legacy',
    name: 'Old recording',
    timestamp: NOW,
    startUrl: 'https://shop.example.com/old',
    errorCount: 0,
    schemaVersion: 1,
    steps: [bareStep(1)],
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-test-'));
  writeRenderFlow();
  writeCappedFlow();
  writeOffFlow();
  writeLegacyFlow();
  writeJunkFlow();

  server = await startServer({ home });
}, 20_000);

afterAll(() => {
  server?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('the render part in the index', () => {
  it('is listed, priced, and last of the parts', async () => {
    const index = await call('get_step_detail', { id: 'flow-render', step: 1 });

    expect(index).toMatch(/^ {2}render\s+.*~\d+ tokens$/m);
    expect(index.indexOf('\n  render ')).toBeGreaterThan(index.indexOf('\n  screenshot '));
  });

  it('says how many components re-rendered and how many were wasted', async () => {
    const index = await call('get_step_detail', { id: 'flow-render', step: 1 });

    expect(index).toMatch(/^ {2}render\s+4 components re-rendered, 1 wasted/m);
  });

  it('prices the part at exactly what the part is about to cost', async () => {
    const index = await call('get_step_detail', { id: 'flow-render', step: 1 });
    const detail = await renderPart('flow-render', 1);

    // The index and the section come out of `stepParts` together, and this is
    // what that is for: a quote computed from anything else is a number the
    // reader budgets against and nobody keeps.
    const quoted = Number(/^ {2}render\s+.*~(\d+) tokens$/m.exec(index)?.[1]);
    const section = detail.slice(detail.indexOf('### render'));

    expect(quoted).toBeGreaterThan(0);
    expect(Math.ceil(section.length / 4)).toBe(quoted);
  });

  it('says in the index what a step with no re-renders is, rather than leaving the row blank', async () => {
    const index = await call('get_step_detail', { id: 'flow-render', step: 2 });

    expect(index).toMatch(/^ {2}render\s+no component re-rendered/m);
  });
});

describe('what re-rendered, and why', () => {
  it('names the component and where it was written, not the id the flow keys it by', async () => {
    const detail = await renderPart('flow-render', 1);

    expect(detail).toContain('ProductList  src/ProductList.tsx:12');
    expect(detail).not.toContain('list-0');
  });

  it('prints the changed prop, hook and context with both sides of each', async () => {
    const detail = await renderPart('flow-render', 1);

    expect(detail).toContain('items: {"count":2} → {"count":3}');
    expect(detail).toContain('hook 2: false → true');
    expect(detail).toContain('theme: "light" → "dark"');
  });

  it('labels which of the three a change was, since a hook and a prop are different repairs', async () => {
    const detail = await renderPart('flow-render', 1);

    expect(detail).toMatch(/^ {2}props {4,}items: /m);
    expect(detail).toMatch(/^ {2}hooks {4,}hook 2: /m);
    expect(detail).toMatch(/^ {2}contexts +theme: /m);
  });

  it('marks the wasted component and says once what wasted means', async () => {
    const detail = await renderPart('flow-render', 1);

    expect(detail).toContain('ProductRow  src/ProductRow.tsx:40  — wasted');
    expect(detail).toContain('"wasted" marks a component that re-rendered while nothing it was seen to depend on changed value');
  });

  it('falls back to the id when the flow does not list the component', async () => {
    const detail = await renderPart('flow-render', 1);

    // The id is still the key every other tool here takes, so it beats
    // printing nothing and losing the entry.
    expect(detail).toContain('ghost-9');
  });

  it('replaces an over-large value with its shape rather than a slice of it', async () => {
    const detail = await renderPart('flow-render', 1);

    expect(detail).toContain('‹string of 400 characters›');
    expect(detail).toContain('‹object, 12 keys: a, b, c, d, e, f, …›');
    // A value cut mid-JSON reads as a whole value that is simply wrong.
    expect(detail).not.toContain('xxxxxxxxxx');
  });
});

describe('what the sampling could not see', () => {
  it('says a change whose values were both dropped is a gap, not a value of undefined', async () => {
    const detail = await renderPart('flow-render', 1);

    expect(detail).toContain('payload: changed — neither value could be sampled, too large or too circular');
    expect(detail).not.toContain('payload: undefined → undefined');
  });

  it('says on the bounded component that a value was cut, because then "nothing changed" is about the cap', async () => {
    const detail = await renderPart('flow-render', 1);

    expect(detail).toContain('Badge  src/Badge.tsx:4');
    expect(detail).toContain('a value was cut at a snapshot cap, so a change below the cut reads as no change');
  });
});

describe('a payload the contract does not allow', () => {
  it('answers out of what it can read rather than taking the tool call down', async () => {
    const answer = await server.callRaw('get_step_detail', {
      id: 'flow-junk',
      step: 1,
      include: ['render'],
    });

    expect(answer.isError).toBeFalsy();
    expect(answer.text).toContain('Header  src/Header.tsx:3');
    expect(answer.text).toContain('title: not sampled → "Cart"');
    // The three entries that are not entries are not counted as components
    // either — a count of what arrived is not a count of what re-rendered.
    expect(answer.text).toContain('1 component re-rendered across this step');
  });
});

describe('the three answers that are not "here is the blame"', () => {
  it('says renders were never sampled on a flow recorded before they were', async () => {
    const detail = await renderPart('flow-legacy', 1);

    expect(detail).toContain('did not sample renders at all');
    expect(detail).toContain('absence of data and not the absence of re-rendering');
    // The answer this must never be mistaken for.
    expect(detail).not.toContain('no component re-rendered');
  });

  it('says capture was switched off, in the recording\'s own words', async () => {
    const detail = await renderPart('flow-off', 1);

    expect(detail).toContain('Render capture was switched off');
    expect(detail).toContain('The recording\'s own note: No fiber root was found on this page.');
    expect(detail).toContain('recording.renders');
    expect(detail).not.toContain('no component re-rendered');
  });

  it('says an empty list under a hit cap is a statement about the cap', async () => {
    const detail = await renderPart('flow-capped', 1);

    expect(detail).toContain('hit its fiber cap');
    expect(detail).toContain('recording.renderNodeCap');
    expect(detail).toContain('components past it were never compared');
  });

  it('warns on a capped flow that even a non-empty list is only what was compared', async () => {
    const detail = await renderPart('flow-capped', 2);

    expect(detail).toContain('Cell  src/Cell.tsx:7');
    expect(detail).toContain('this is what was compared and not everything that re-rendered');
  });

  it('says nothing re-rendered only when sampling ran and finished, and says what that misses', async () => {
    const detail = await renderPart('flow-render', 2);

    expect(detail).toContain('Renders were sampled on this step and no component re-rendered');
    // Two readings, so a component that re-rendered and settled back is
    // indistinguishable from one that never rendered, and the reader is owed
    // that before they conclude the app is idle.
    expect(detail).toContain('settled back to the props it started with');
    expect(detail).not.toContain('fiber cap');
  });
});

describe('what this data cannot claim', () => {
  /*
   * The one rule with no other gate on it. The evidence is two readings per
   * step, so "rendered 3 times" is not a number this tool has — and it is
   * exactly the sentence somebody adds later while making the output friendlier.
   */
  it('never counts renders, in any of its answers', async () => {
    const answers = await Promise.all([
      renderPart('flow-render', 1),
      renderPart('flow-render', 2),
      renderPart('flow-capped', 1),
      renderPart('flow-capped', 2),
      renderPart('flow-off', 1),
      renderPart('flow-legacy', 1),
    ]);

    for (const answer of answers) {
      const section = answer.slice(answer.indexOf('### render'));
      expect(section).not.toMatch(/\b\d+\s*(?:×|x)?\s*(?:times|renders\b|re-renders\b)/i);
      expect(section).not.toMatch(/rendered\s+\d+/i);
    }
  });

  it('counts components when it counts anything, and says the count is of components', async () => {
    const detail = await renderPart('flow-render', 1);

    expect(detail).toContain('4 components re-rendered across this step');
    expect(detail).toContain('nothing about how often any of them did');
  });
});

/*
 * Everything above hands `flow.json` to the reader ready-made, which is the
 * only way to test the four answers apart — and is exactly the blind spot that
 * lost `state` once already. `saveFlow` lists the flow-level fields it keeps by
 * name, on purpose, so a reader added without its line there is answered for
 * out of a flow that no longer has the field: a sampled recording reads as one
 * where sampling never ran, and every fixture test in this file stays green
 * while it happens. So the wire is walked once, in both directions.
 */
describe('a recording that arrives the way a real one does', () => {
  const posted = (id: string, renders: unknown, steps: unknown[]) => ({
    id,
    name: `Recording ${id}`,
    timestamp: NOW,
    startUrl: 'https://shop.example.com/list',
    schemaVersion: 1,
    react: {
      detected: true,
      components: { 'sum-0': { name: 'CartSummary', source: 'src/CartSummary.tsx', line: 21 } },
    },
    renders,
    steps,
  });

  it('keeps what was sampled, rather than answering for a sampled flow as an unsampled one', async () => {
    const sent = await server.post(
      '/flows',
      JSON.stringify(
        posted('flow-wire', { read: true }, [
          bareStep(1, {
            renders: [{ component: 'sum-0', props: [{ key: 'total', before: 42, after: 55 }] }],
          }),
        ]),
      ),
    );
    expect(sent.status).toBe(200);

    const detail = await renderPart('flow-wire', 1);

    expect(detail).toContain('CartSummary  src/CartSummary.tsx:21');
    expect(detail).toContain('total: 42 → 55');
    // What a dropped `flow.renders` turns this into: the blame is on the step
    // and survives, so the entries still print while the flow says nothing was
    // ever looked at.
    expect(detail).not.toContain('did not sample renders at all');
  });

  it('keeps why nothing was sampled, which is the half a dropped field turns into a lie', async () => {
    const sent = await server.post(
      '/flows',
      JSON.stringify(
        posted('flow-wire-off', { read: false, note: 'React was not found on this page.' }, [bareStep(1)]),
      ),
    );
    expect(sent.status).toBe(200);

    const detail = await renderPart('flow-wire-off', 1);

    expect(detail).toContain('Render capture was switched off');
    expect(detail).toContain('The recording\'s own note: React was not found on this page.');
    expect(detail).not.toContain('did not sample renders at all');
  });
});

describe('the tool description', () => {
  it('offers the part by name and repeats what it may not claim', async () => {
    const tools = await server.tools();

    expect(tools).toContain('which components re-rendered');
    expect(tools).toContain('never how many times');
  });
});
