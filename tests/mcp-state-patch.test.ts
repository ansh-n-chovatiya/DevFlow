/**
 * `get_state_patch` against the real server, over the real transport.
 *
 * The tool exists because four things arrive as the same absence: state was
 * never captured, no store was recognised, no store moved, and here is what
 * moved. A reader who cannot tell them apart picks the worst reading — usually
 * that the application did nothing — and that reading cannot be checked from
 * anywhere else in this server. So the first block below is not a set of
 * assertions about wording; it is the assertion that the four responses are
 * four responses, and it fails the moment any two of them collapse into one.
 *
 * The rest guards the three claims the tool makes that a reader would have no
 * way to verify: that the blocks are in step order, that `bounded` and
 * `collapsed` reached the page, and that a budget that bit said so. `collapsed`
 * is the subtle one — it means finer operations were folded into coarser ones
 * that still apply exactly, and describing it as dropped operations would tell
 * a reader the patch has holes in it when it does not.
 *
 * Why a spawned process rather than an import is in `tests/helpers/mcp-server.ts`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

/** The server's own estimate, so the assertions measure what the budget does. */
const estimateTokens = (value: string) => Math.ceil(value.length / 4);

/** `mcp.maxTokens`, unset anywhere in these fixtures, so the default is the budget. */
const MAX_TOKENS = 20_000;

const BASE = Date.UTC(2026, 7, 20, 9, 30);

let home: string;
let server: McpSession;

const call = (name: string, args: Record<string, unknown>): Promise<string> => server.call(name, args);

/** A step with nothing but the fields every tool here reads. */
const step = (n: number, extra: Record<string, unknown> = {}) => ({
  type: 'click',
  url: 'https://shop.example.com/cart',
  timestamp: BASE + n * 1000,
  action: `Clicked "Step ${n}"`,
  stepNumber: n,
  element: { tag: 'button', cssSelector: `button.s${n}` },
  consoleLogs: [],
  networkCalls: [],
  ...extra,
});

/**
 * The four flows the four answers come from, plus the one that has patches in
 * it. Each of the first three is a different *absence*, written the way the
 * extension would leave it.
 */
function writeFixtures(): void {
  // 1a — recorded by a build that never read state at all: no `state` key.
  writeFlow(home, {
    id: 'flow-nostate',
    name: 'Recorded before state',
    timestamp: BASE,
    startUrl: 'https://shop.example.com/cart',
    errorCount: 0,
    schemaVersion: 1,
    steps: [step(1), step(2)],
  });

  // 1b — state capture switched off.
  writeFlow(home, {
    id: 'flow-off',
    name: 'Capture off',
    timestamp: BASE,
    startUrl: 'https://shop.example.com/cart',
    errorCount: 0,
    schemaVersion: 1,
    state: { read: false, stores: [], note: 'Application state capture is switched off.' },
    steps: [step(1), step(2)],
  });

  // 2 — capture ran and found nothing it recognised.
  writeFlow(home, {
    id: 'flow-blind',
    name: 'Nothing recognised',
    timestamp: BASE,
    startUrl: 'https://shop.example.com/cart',
    errorCount: 0,
    schemaVersion: 1,
    state: {
      read: true,
      stores: [],
      note: 'React was detected but no Redux, Zustand, React Query or context value was readable.',
    },
    steps: [step(1), step(2)],
  });

  // 3 — capture ran, two stores found, neither moved on any step.
  writeFlow(home, {
    id: 'flow-still',
    name: 'Nothing moved',
    timestamp: BASE,
    startUrl: 'https://shop.example.com/cart',
    errorCount: 0,
    schemaVersion: 1,
    state: {
      read: true,
      stores: [
        { id: 's-cart', kind: 'redux', label: 'cart' },
        { id: 's-theme', kind: 'context', label: 'ThemeContext' },
      ],
    },
    steps: [step(1), step(2, { state: [] })],
  });

  // 4 — the recording with patches in it.
  writeFlow(home, {
    id: 'flow-moves',
    name: 'Cart moves',
    timestamp: BASE,
    startUrl: 'https://shop.example.com/cart',
    errorCount: 0,
    schemaVersion: 1,
    react: {
      detected: true,
      components: {
        'c-cart': { name: 'CartPanel', status: 'resolved', source: 'src/Cart.tsx', line: 12 },
        'c-badge': { name: 'CartBadge', status: 'resolved', source: 'src/Badge.tsx', line: 4 },
      },
    },
    state: {
      read: true,
      stores: [
        { id: 's-cart', kind: 'redux', label: 'cart', subscribers: ['c-cart', 'c-badge'] },
        { id: 's-theme', kind: 'context', label: 'ThemeContext' },
        { id: 's-query', kind: 'react-query', label: 'queries' },
      ],
    },
    steps: [
      step(1),
      step(2, { state: [{ store: 's-cart', patch: [{ op: 'replace', path: '/items/0/qty', value: 2 }] }] }),
      step(3, {
        state: [
          { store: 's-cart', patch: [{ op: 'replace', path: '/total', value: 1999 }], bounded: true },
          { store: 's-theme', patch: [{ op: 'replace', path: '/mode', value: 'dark' }] },
        ],
      }),
      step(4, { state: [] }),
      step(5, {
        state: [
          {
            store: 's-cart',
            patch: [{ op: 'replace', path: '/items', value: [{ sku: 'a' }, { sku: 'b' }] }],
            collapsed: 7,
          },
        ],
      }),
      step(6, {
        state: [
          {
            store: 's-cart',
            patch: [
              { op: 'add', path: '/errors/0', value: 'totals missing' },
              { op: 'remove', path: '/pending' },
            ],
          },
        ],
      }),
      step(7, {
        state: [
          {
            store: 's-cart',
            patch: [
              { op: 'replace', path: '/catalogue', value: 'x'.repeat(4000) },
              { op: 'replace', path: '/count', value: 3 },
            ],
          },
        ],
      }),
    ],
  });
}

/**
 * A recording that cannot be answered whole: 60 steps, three stores apiece,
 * twelve operations each, every other value larger than anything worth
 * printing. Without it the budget assertions pass whether or not there is a
 * budget — a response that fits by accident proves nothing about the code that
 * makes it fit.
 */
function writeHostileFlow(): void {
  const steps = Array.from({ length: 60 }, (_, i) => {
    const n = i + 1;
    const patch = Array.from({ length: 12 }, (_, j) => ({
      op: 'replace',
      path: `/rows/${j}/payload`,
      value: j % 2 === 0 ? `${'y'.repeat(900)}` : j,
    }));
    return step(n, {
      state: ['h-a', 'h-b', 'h-c'].map((store) => ({ store, patch, bounded: true })),
    });
  });

  writeFlow(home, {
    id: 'flow-hostile',
    name: 'Everything moves at once',
    timestamp: BASE,
    startUrl: 'https://shop.example.com/cart',
    errorCount: 0,
    schemaVersion: 1,
    state: {
      read: true,
      stores: [
        { id: 'h-a', kind: 'redux', label: 'a' },
        { id: 'h-b', kind: 'zustand', label: 'b' },
        { id: 'h-c', kind: 'react-query', label: 'c' },
      ],
    },
    steps,
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-test-'));
  writeFixtures();
  writeHostileFlow();
  server = await startServer({ home });
}, 20_000);

afterAll(() => {
  server?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

/*
 * The reason the tool exists. Each of these four is a different fact about the
 * world, and the failure this block guards is not a wrong sentence — it is two
 * of them being the same sentence.
 */
describe('the four answers that must not read alike', () => {
  it('says a recording carries no state at all, and how to turn it on', async () => {
    const answer = await call('get_state_patch', { id: 'flow-nostate', step: 1 });

    expect(answer).toContain('carries no application state at all');
    expect(answer).toContain('absence of data and not the absence of change');
    expect(answer).toContain('"recording.state"');
  });

  it('says state capture was switched off, which is not the same as the build not having it', async () => {
    const answer = await call('get_state_patch', { id: 'flow-off', step: 1 });

    expect(answer).toContain('State capture was switched off');
    expect(answer).toContain('"recording.state"');
    // Not the other absence: this build read state, this recording did not ask it to.
    expect(answer).not.toContain('carries no application state at all');
  });

  it('says capture ran and recognised nothing, and prints the recording\'s own note', async () => {
    const answer = await call('get_state_patch', { id: 'flow-blind', step: 1 });

    expect(answer).toContain('recognised no store on that page');
    expect(answer).toContain('no Redux, Zustand, React Query or context value was readable');
    expect(answer).toContain('This is not "nothing changed" — there was nothing to watch');
    expect(answer).not.toContain('"recording.state"');
  });

  it('says no store moved, naming the stores that were read and watched', async () => {
    const answer = await call('get_state_patch', { id: 'flow-still', step: 2 });

    expect(answer).toContain('No store moved on step 2');
    expect(answer).toContain('redux "cart" (#s-cart)');
    expect(answer).toContain('context "ThemeContext" (#s-theme)');
    // The sampling caveat, which is the whole difference between this answer
    // and a claim that the application did nothing.
    expect(answer).toContain('changed and changed back');
    // And emphatically not advice to switch on something already on.
    expect(answer).not.toContain('"recording.state"');
  });

  /*
   * The highest-value test in this file. Every assertion above passes on a
   * server that returns one sentence for all four cases as long as that
   * sentence happens to contain the substrings — this is the one that does not.
   */
  it('gives four different answers, not one absence four times', async () => {
    const answers = await Promise.all([
      call('get_state_patch', { id: 'flow-nostate', step: 1 }),
      call('get_state_patch', { id: 'flow-off', step: 1 }),
      call('get_state_patch', { id: 'flow-blind', step: 1 }),
      call('get_state_patch', { id: 'flow-still', step: 2 }),
      call('get_state_patch', { id: 'flow-moves', step: 2 }),
    ]);

    expect(new Set(answers).size).toBe(5);
    // Specifically: "capture was off" and "nothing changed" must not render the
    // same. They are the two that a reader most needs kept apart, because one
    // is a fact about the app and the other is a fact about the recorder.
    expect(answers[1]).not.toEqual(answers[3]);
    expect(answers[3]).toContain('No store moved');
    expect(answers[1]).not.toContain('No store moved');
  });
});

describe('the patch itself', () => {
  it('returns the operations for one step, over the snapshot rather than the store', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves', step: 2 });

    expect(answer).toContain('## State on step 2 of 7 — Cart moves');
    expect(answer).toContain('{"op":"replace","path":"/items/0/qty","value":2}');
    expect(answer).toContain('not on the live store');
    expect(answer).toContain('concatenation is itself a valid RFC 6902 patch');
    // Concatenation is a per-store claim, and saying it without that limit
    // would be false the moment two stores appear in one response.
    expect(answer).toContain('Across stores they do not concatenate');
  });

  it('lists every store, marking the ones that did not move as read but still', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves', from: 2, to: 7 });

    expect(answer).toContain('react-query "queries" (#s-query) — did not move');
    expect(answer).toContain('read by CartPanel, CartBadge');
  });
});

describe('a range', () => {
  it('concatenates the blocks in step order', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves', from: 2, to: 6 });

    const at = (needle: string) => answer.indexOf(needle);
    expect(at('### step 2 ·')).toBeGreaterThan(-1);
    expect(at('### step 3 ·')).toBeGreaterThan(at('### step 2 ·'));
    expect(at('### step 5 ·')).toBeGreaterThan(at('### step 3 ·'));
    expect(at('### step 6 ·')).toBeGreaterThan(at('### step 5 ·'));
    // Step 4 carried an empty delta list, so it is absent rather than printed
    // as a block with nothing in it.
    expect(at('### step 4 ·')).toBe(-1);
  });

  it('orders the operations within a store by the step they happened on', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves', from: 2, to: 6, store: 's-cart' });

    const at = (needle: string) => answer.indexOf(needle);
    expect(at('"/items/0/qty"')).toBeGreaterThan(-1);
    expect(at('"/total"')).toBeGreaterThan(at('"/items/0/qty"'));
    expect(at('"/errors/0"')).toBeGreaterThan(at('"/total"'));
  });

  /*
   * Refused rather than sorted. Quietly reversing a backwards range hands the
   * reader a correct answer to a question they did not ask, which they then
   * trust the next time the mistake cannot be repaired.
   */
  it('refuses a range that runs backwards instead of quietly putting it in order', async () => {
    const answer = await server.callRaw('get_state_patch', { id: 'flow-moves', from: 6, to: 2 });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('runs backwards');
    expect(answer.text).toContain('"from":2,"to":6');
    expect(answer.text).not.toContain('### step');
  });

  it('refuses a step and a range together rather than guessing which was meant', async () => {
    const answer = await server.callRaw('get_state_patch', { id: 'flow-moves', step: 2, from: 3, to: 5 });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('not both');
  });

  it('defaults to the whole recording when neither is given', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves' });

    expect(answer).toContain('## State across steps 1–7 of 7');
    expect(answer).toContain('### step 2 ·');
    expect(answer).toContain('### step 7 ·');
  });
});

describe('the two flags a reader cannot see for themselves', () => {
  /*
   * `bounded` is the caveat most easily lost: it is one boolean on a delta, and
   * a response that reads it and never prints it is indistinguishable from one
   * that never read it. So this asserts the sentence, not the flag.
   */
  it('prints the bounded caveat on the store that carried it', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves', step: 3 });

    expect(answer).toContain('Snapshot bounded');
    expect(answer).toContain('reads as unchanged whether it changed or not');
    // On the bounded store's block, not floating at the top of the response
    // where it would look like it applied to both stores.
    const bounded = answer.indexOf('Snapshot bounded');
    const cart = answer.indexOf('### step 3 · redux "cart"');
    const theme = answer.indexOf('### step 3 · context "ThemeContext"');
    expect(bounded).toBeGreaterThan(cart);
    expect(bounded).toBeLessThan(theme);
  });

  it('does not claim a bounded snapshot on a store that had none', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves', step: 2 });

    expect(answer).not.toContain('Snapshot bounded');
  });

  /*
   * `collapsed` counts operations folded into coarser ones that still apply
   * exactly. Reporting it as dropped operations tells the reader the patch has
   * holes in it, which is the one thing `StepStateDelta` promises it never has.
   */
  it('prints collapsed as folding rather than as dropped operations', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves', step: 5 });

    expect(answer).toContain('7 finer operations were folded into coarser replaces');
    expect(answer).toContain('Nothing was dropped');
    expect(answer).toContain('still applies exactly');

    // The word "dropped" appears in exactly one sentence here, and that
    // sentence is the one denying it. A response that also said the operations
    // were dropped would satisfy every assertion above.
    const sentences = answer.match(/[^.]*\bdropp?ed\b[^.]*\./g) ?? [];
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain('Nothing was dropped');
  });

  it('does not mention folding on a patch that was not collapsed', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves', step: 6 });

    expect(answer).not.toContain('folded into coarser replaces');
  });
});

describe('the store filter', () => {
  it('selects one store and says what it is not telling you about', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves', from: 2, to: 3, store: 's-cart' });

    expect(answer).toContain('### step 3 · redux "cart"');
    expect(answer).not.toContain('ThemeContext" (#s-theme) —');
    expect(answer).toContain('says nothing at all about them');
  });

  it('takes the label the page gave a store as well as its id', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves', from: 2, to: 6, store: 'cart' });

    expect(answer).toContain('### step 2 · redux "cart"');
  });

  /*
   * The filter's own version of the mistake this tool is organised around: an
   * unknown store answered with an empty patch reads as "that store did not
   * move", which is a claim about the application rather than about the typo.
   */
  it('refuses an unknown store rather than returning an empty patch', async () => {
    const answer = await server.callRaw('get_state_patch', {
      id: 'flow-moves',
      from: 2,
      to: 6,
      store: 'sessionStore',
    });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('read no store called "sessionStore"');
    expect(answer.text).toContain('redux "cart" (#s-cart)');
    expect(answer.text).toContain('"that store did not move", which is a different thing');
    expect(answer.text).not.toContain('did not move on steps');
  });

  it('says a known store did not move, which is the answer the unknown one must not borrow', async () => {
    const answer = await server.callRaw('get_state_patch', {
      id: 'flow-moves',
      from: 2,
      to: 6,
      store: 'queries',
    });

    expect(answer.isError).toBeFalsy();
    expect(answer.text).toContain('react-query "queries" (#s-query) did not move on steps 2–6');
    expect(answer.text).toContain('the two samples matched');
  });
});

describe('the token budget', () => {
  it('holds on a recording built to break it', async () => {
    const answer = await call('get_state_patch', { id: 'flow-hostile' });

    expect(estimateTokens(answer)).toBeLessThanOrEqual(MAX_TOKENS);
  });

  it('says the budget bit, and names the call that continues', async () => {
    const answer = await call('get_state_patch', { id: 'flow-hostile' });

    expect(answer).toContain('Cut to fit the response budget');
    expect(answer).toMatch(/get_state_patch\(\{"id":"flow-hostile","from":\d+,"to":60\}\)/);
    expect(answer).toContain('"mcp.maxTokens"');
  });

  /*
   * Without this the assertions above prove nothing the moment the fixture
   * stops being hostile: a response with everything in it keeps the budget by
   * accident, and the test that guards the budget passes whether or not the
   * budget exists.
   */
  it('has more to say than it can afford, and stops on a step boundary', async () => {
    const answer = await call('get_state_patch', { id: 'flow-hostile' });

    expect(answer).toContain('### step 1 ·');
    expect(answer).not.toContain('### step 60 ·');
    // Cut between steps, not inside one: the "from" the response names has to
    // resume exactly where it stopped.
    const stopped = Number(/"from":(\d+)/.exec(answer)?.[1]);
    expect(stopped).toBeGreaterThan(1);
    expect(answer).not.toContain(`### step ${stopped} ·`);
    expect(answer).toContain(`### step ${stopped - 1} ·`);
  });

  it('sketches a value too large to print rather than cutting it mid-value', async () => {
    const answer = await call('get_state_patch', { id: 'flow-moves', step: 7 });

    // The shape and the size, under a key nothing can mistake for a value.
    expect(answer).toContain('"valueOmitted":"string of 4000 characters, 4002 characters as JSON"');
    expect(answer).toContain('not applicable as printed');
    // The operation that fits is still printed whole.
    expect(answer).toContain('{"op":"replace","path":"/count","value":3}');
    // And no half a value anywhere: the huge string never reaches the response.
    expect(answer).not.toContain('x'.repeat(200));
  });
});

describe('a step that is not there', () => {
  it('refuses a step past the end and says how many there are', async () => {
    const answer = await server.callRaw('get_state_patch', { id: 'flow-moves', step: 99 });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('"Cart moves" has no step 99');
    expect(answer.text).toContain('It has 7 steps, numbered 1 to 7');
  });

  it('refuses a range that runs past the end', async () => {
    const answer = await server.callRaw('get_state_patch', { id: 'flow-moves', from: 2, to: 99 });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('has no step 99');
  });

  /*
   * The step is checked before the state is, so a typo is answered as a typo.
   * Answering it with "this recording has no state" sends the reader to the
   * settings page to fix a number they mistyped.
   */
  it('answers a bad step number as a bad step number even where there is no state', async () => {
    const answer = await server.callRaw('get_state_patch', { id: 'flow-nostate', step: 99 });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('has no step 99');
    expect(answer.text).not.toContain('"recording.state"');
  });

  it('refuses a flow that does not exist, pointing at list_flows', async () => {
    const answer = await server.callRaw('get_state_patch', { id: 'no-such-flow', step: 1 });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('list_flows');
  });
});

describe('what the tool says about itself', () => {
  it('describes sampling as sampling, and does not imply it watched every state', async () => {
    const tools = await server.tools();
    const listed = (JSON.parse(tools) as { tools: { name: string; description: string }[] }).tools;
    const described = listed.find((tool) => tool.name === 'get_state_patch');

    expect(described).toBeDefined();
    const description = described!.description;
    expect(description).toContain('samples state, it does not watch it');
    expect(description).toContain('changed and changed back');
    expect(description).toContain('bounded snapshot');
    // The concatenation claim carries its own limit wherever it is made.
    expect(description).toContain('across stores they do not');
  });
});
