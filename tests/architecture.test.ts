/**
 * The Living Architecture Map — what a reading claims, and what it refuses to.
 *
 * The feature's whole risk is one sentence: a snapshot presented as the present.
 * `ROADMAP_AND_PHASES.md` §3.3 asked for a real-time feed, an MCP tool can only
 * ever return one answer at one moment, and the gap between those two is exactly
 * where a plausible lie lives. So the assertions that matter here are not about
 * the tree walk — they are about the age surviving every hop from the page to
 * the model, and about the three "nothing here" states staying distinguishable.
 *
 * The pure half is tested directly. The server half is driven through a real
 * spawned server over the real transport, for `helpers/mcp-server.ts`'s reason:
 * `mcp-server/server.js` has top-level side effects, is not typechecked, and its
 * interesting failures are invisible from inside the process.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildArchitecture,
  describeAge,
  isStale,
  renderArchitecture,
  STALE_AFTER_MS,
  type ComponentInstanceReading,
  type PageReading,
} from '../src/core/architecture/index.js';
import { pos1 } from '../src/core/react/positions.js';
import { startServer, type McpSession } from './helpers/mcp-server.js';

const servers: McpSession[] = [];

async function server(): Promise<McpSession> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-arch-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });
  const session = await startServer({ home });
  servers.push(session);
  return session;
}

afterAll(() => {
  for (const session of servers) session.stop();
});

function instance(
  over: Partial<ComponentInstanceReading> & Pick<ComponentInstanceReading, 'id' | 'name'>,
): ComponentInstanceReading {
  return { depth: 0, contextIds: [], ...over };
}

function page(over: Partial<PageReading> = {}): PageReading {
  return {
    url: 'https://app.example.com/cart',
    title: 'Cart',
    roots: 1,
    capped: false,
    instances: [],
    contexts: [],
    ...over,
  };
}

describe('buildArchitecture', () => {
  it('collapses instances of one component and keeps the count', () => {
    const snapshot = buildArchitecture(
      page({
        instances: [
          instance({ id: 'a', name: 'App', depth: 0 }),
          instance({ id: 'r', name: 'Row', depth: 3 }),
          instance({ id: 'r', name: 'Row', depth: 3 }),
          instance({ id: 'r', name: 'Row', depth: 4 }),
        ],
      }),
      1_000,
    );

    expect(snapshot.components).toHaveLength(2);
    expect(snapshot.totalInstances).toBe(4);
    const row = snapshot.components.find((c) => c.id === 'r');
    expect(row?.instances).toBe(3);
    // The shallowest instance, not the last one seen: it is what orders the map.
    expect(row?.depth).toBe(3);
  });

  it('orders outermost first, because a map reads root-downwards', () => {
    const snapshot = buildArchitecture(
      page({
        instances: [
          // The busiest component, and the deepest. Ordering by instance count
          // would put this first and bury `App`, which is the ordering mistake
          // this assertion exists to catch.
          ...Array.from({ length: 50 }, () => instance({ id: 'row', name: 'Row', depth: 5 })),
          instance({ id: 'app', name: 'App', depth: 0 }),
          instance({ id: 'page', name: 'CartPage', depth: 2 }),
        ],
      }),
      1_000,
    );

    expect(snapshot.components.map((c) => c.name)).toEqual(['App', 'CartPage', 'Row']);
  });

  it('is stable across two readings of one unchanged page', () => {
    const reading = page({
      instances: [
        instance({ id: 'b', name: 'B', depth: 1 }),
        instance({ id: 'a', name: 'A', depth: 1 }),
        instance({ id: 'c', name: 'C', depth: 1 }),
      ],
    });
    const first = buildArchitecture(reading, 1_000);
    const second = buildArchitecture(reading, 9_999);
    expect(first.components.map((c) => c.id)).toEqual(second.components.map((c) => c.id));
  });

  it('drops a nameless component rather than keying it on the empty string', () => {
    const snapshot = buildArchitecture(
      page({
        instances: [
          instance({ id: 'x', name: '   ' }),
          instance({ id: 'y', name: '' }),
          instance({ id: 'z', name: 'Real' }),
        ],
      }),
      1_000,
    );
    expect(snapshot.components.map((c) => c.name)).toEqual(['Real']);
  });

  it('keeps the first source it is given, not the last', () => {
    const snapshot = buildArchitecture(
      page({
        instances: [
          instance({ id: 'a', name: 'A', depth: 1, sourceFile: 'src/A.tsx', sourceLine: pos1(12) }),
          instance({ id: 'a', name: 'A', depth: 2, sourceFile: 'src/Wrong.tsx', sourceLine: pos1(99) }),
        ],
      }),
      1_000,
    );
    expect(snapshot.components[0].sourceFile).toBe('src/A.tsx');
    expect(snapshot.components[0].sourceLine).toBe(12);
  });

  it('drops a context nothing was observed reading', () => {
    /*
     * A provider whose consumers all sat beyond the node cap looks exactly like
     * a store nobody subscribes to, and only one of those is a fact about the
     * app. `capped` carries that once; a zero-subscriber row would restate it as
     * something that reads like a finding.
     */
    const snapshot = buildArchitecture(
      page({
        capped: true,
        instances: [instance({ id: 'a', name: 'A', contextIds: ['ctx:0'] })],
        contexts: [
          { id: 'ctx:0', label: 'CartContext', kind: 'redux' },
          { id: 'ctx:1', label: 'Orphan', kind: 'context' },
        ],
      }),
      1_000,
    );
    expect(snapshot.contexts.map((c) => c.label)).toEqual(['CartContext']);
    expect(snapshot.contexts[0].subscribers).toEqual(['a']);
  });

  it('records a component against a context once, however many instances read it', () => {
    const snapshot = buildArchitecture(
      page({
        instances: [
          instance({ id: 'a', name: 'A', contextIds: ['ctx:0'] }),
          instance({ id: 'a', name: 'A', contextIds: ['ctx:0'] }),
        ],
        contexts: [{ id: 'ctx:0', label: 'Cart', kind: 'context' }],
      }),
      1_000,
    );
    expect(snapshot.contexts[0].subscribers).toEqual(['a']);
  });

  it('honours the limits without losing the instance total', () => {
    const snapshot = buildArchitecture(
      page({
        instances: Array.from({ length: 20 }, (_, i) =>
          instance({ id: `c${i}`, name: `C${i}`, depth: i }),
        ),
      }),
      1_000,
      { maxComponents: 5, maxContexts: 2 },
    );
    expect(snapshot.components).toHaveLength(5);
    // The count is of what was *read*, not of what survived the budget — a
    // total that shrank with the limit would understate the page.
    expect(snapshot.totalInstances).toBe(20);
  });
});

describe('describeAge', () => {
  it('rounds, because a map is not accurate to the millisecond', () => {
    expect(describeAge(0)).toBe('just now');
    expect(describeAge(4_400)).toBe('just now');
    expect(describeAge(30_000)).toBe('30s ago');
    expect(describeAge(5 * 60_000)).toBe('5 minutes ago');
    // Minutes run to 90 before hours start, so an hour reads as "60 minutes
    // ago". Deliberate: the units change where the number stops being useful,
    // not where the arithmetic changes.
    expect(describeAge(60 * 60_000)).toBe('60 minutes ago');
    expect(describeAge(2 * 60 * 60_000)).toBe('2 hours ago');
    expect(describeAge(72 * 60 * 60_000)).toBe('3 days ago');
  });

  it('says so rather than inventing a number it does not have', () => {
    expect(describeAge(Number.NaN)).toBe('at an unknown time');
    expect(describeAge(-1)).toBe('at an unknown time');
  });
});

describe('renderArchitecture', () => {
  const now = 10_000_000;

  it('puts the age and the page above anything a reader would act on', () => {
    const snapshot = buildArchitecture(
      page({ instances: [instance({ id: 'a', name: 'App' })] }),
      now - 30_000,
    );
    const [first] = renderArchitecture(snapshot, now).split('\n');
    expect(first).toContain('30s ago');
    expect(first).toContain('https://app.example.com/cart');
    // The claim the whole feature turns on, in the same sentence as the age.
    expect(first).toContain('not a feed');
  });

  it('changes what it says about a stale reading rather than hiding it', () => {
    const snapshot = buildArchitecture(page({ instances: [instance({ id: 'a', name: 'App' })] }), 0);
    expect(isStale(snapshot, STALE_AFTER_MS)).toBe(true);

    const rendered = renderArchitecture(snapshot, STALE_AFTER_MS + 1);
    expect(rendered).toContain('not the current page');
    expect(rendered).toContain('take another');
    // Still rendered. Withholding it would lose a reader the only map there is.
    expect(rendered).toContain('App');
  });

  it('tells a page with no React from a page with nothing on it', () => {
    const rendered = renderArchitecture(buildArchitecture(page({ roots: 0 }), now), now);
    expect(rendered).toContain('No React root');
    // The distinction that stops a reader concluding the app is empty.
    expect(rendered).toContain('a fact about the reader, not about the page');
  });

  it('says a capped walk is the top of the tree, not all of it', () => {
    const rendered = renderArchitecture(
      buildArchitecture(page({ capped: true, instances: [instance({ id: 'a', name: 'App' })] }), now),
      now,
    );
    expect(rendered).toContain('node cap');
    expect(rendered).toContain('never looked at');
  });

  it('names the module-level Zustand gap rather than reporting no state', () => {
    const rendered = renderArchitecture(
      buildArchitecture(page({ instances: [instance({ id: 'a', name: 'App' })] }), now),
      now,
    );
    // The same refusal ADR 0005 records and `stateNote` prints in a recording:
    // a store with no provider leaves no dependency on a consumer's fiber.
    expect(rendered).toContain('outside a provider');
  });

  it('points at the accumulated graph rather than pretending to be it', () => {
    const rendered = renderArchitecture(
      buildArchitecture(page({ instances: [instance({ id: 'a', name: 'App' })] }), now),
      now,
    );
    expect(rendered).toContain('get_app_architecture');
  });

  it('names the other pages it holds, so a reader can ask for one', () => {
    const rendered = renderArchitecture(
      buildArchitecture(page({ instances: [instance({ id: 'a', name: 'App' })] }), now),
      now,
      ['https://app.example.com/checkout'],
    );
    expect(rendered).toContain('https://app.example.com/checkout');
  });
});

describe('POST /architecture', () => {
  const reading = {
    url: 'https://app.example.com/cart',
    title: 'Cart',
    takenAt: Date.now(),
    roots: 1,
    capped: false,
    components: [
      { id: 'app', name: 'App', instances: 1, depth: 0, reads: [] },
      { id: 'cart', name: 'CartPanel', instances: 2, depth: 2, reads: ['ctx:0'], sourceFile: 'src/Cart.tsx', sourceLine: 8 },
    ],
    contexts: [{ id: 'ctx:0', label: 'CartContext', kind: 'redux' }],
  };

  it('takes a reading from the extension and answers what it stored', async () => {
    const session = await server();
    const response = await session.post('/architecture', JSON.stringify(reading));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, components: 2 });
  });

  it('refuses a caller that is not the extension', async () => {
    const session = await server();
    const response = await session.post('/architecture', JSON.stringify(reading), {
      Origin: 'https://evil.example.com',
    });
    expect(response.status).toBe(403);
  });

  it('refuses a reading with no age, because that is the one misleading shape', async () => {
    const session = await server();
    const ageless: Record<string, unknown> = { ...reading };
    delete ageless.takenAt;
    const response = await session.post('/architecture', JSON.stringify(ageless));
    expect(response.status).toBe(400);
    expect(response.body).toContain('takenAt');
  });

  it('refuses a reading with no page to attribute it to', async () => {
    const session = await server();
    const anonymous: Record<string, unknown> = { ...reading };
    delete anonymous.url;
    const response = await session.post('/architecture', JSON.stringify(anonymous));
    expect(response.status).toBe(400);
    expect(response.body).toContain('url');
  });

  it('bounds the body on an unauthenticated loopback port', async () => {
    const session = await server();
    const response = await session.post(
      '/architecture',
      JSON.stringify({ ...reading, title: 'x'.repeat(600 * 1024) }),
    );
    expect(response.status).toBe(413);
  });

  it('does not take the server down on a body that is not JSON', async () => {
    const session = await server();
    expect((await session.post('/architecture', 'not json')).status).toBe(400);
    // The claim behind the previous line: the process is still answering.
    expect((await session.post('/architecture', JSON.stringify(reading))).status).toBe(200);
  });
});

describe('get_living_architecture', () => {
  it('says what to do when nobody has taken a reading', async () => {
    const session = await server();
    const answer = await session.call('get_living_architecture', {});
    // Three states have to stay distinguishable, and this is the one a reader
    // would otherwise mistake for "the app has no components".
    expect(answer).toContain('No architecture reading has been taken');
    expect(answer).toContain('DevFlow panel');
  });

  it('renders the reading it was given, with its age', async () => {
    const session = await server();
    await session.post(
      '/architecture',
      JSON.stringify({
        url: 'https://app.example.com/cart',
        title: 'Cart',
        takenAt: Date.now(),
        roots: 1,
        capped: false,
        components: [{ id: 'cart', name: 'CartPanel', instances: 3, depth: 1, reads: ['ctx:0'] }],
        contexts: [{ id: 'ctx:0', label: 'CartContext', kind: 'redux' }],
      }),
    );

    const answer = await session.call('get_living_architecture', {});
    expect(answer).toContain('Living architecture');
    expect(answer).toContain('CartPanel');
    expect(answer).toContain('×3');
    expect(answer).toContain('CartContext');
    expect(answer).toContain('just now');
  });

  it('answers with the freshest page and names the others', async () => {
    const session = await server();
    const base = { roots: 1, capped: false, components: [], contexts: [] };
    await session.post(
      '/architecture',
      JSON.stringify({ ...base, url: 'https://app.example.com/old', title: 'Old', takenAt: Date.now() - 60_000 }),
    );
    await session.post(
      '/architecture',
      JSON.stringify({ ...base, url: 'https://app.example.com/new', title: 'New', takenAt: Date.now() }),
    );

    const answer = await session.call('get_living_architecture', {});
    expect(answer.split('\n')[0]).toContain('/new');
    expect(answer).toContain('/old');
  });

  it('selects a page by substring, and refuses a miss by naming what it holds', async () => {
    const session = await server();
    await session.post(
      '/architecture',
      JSON.stringify({
        url: 'https://app.example.com/cart',
        title: 'Cart',
        takenAt: Date.now(),
        roots: 1,
        capped: false,
        components: [],
        contexts: [],
      }),
    );

    expect(await session.call('get_living_architecture', { url: 'cart' })).toContain('/cart');

    // A typo and an unread page are not "the app is empty", so this is a
    // refusal that names the alternative rather than an empty success.
    const miss = await session.callRaw('get_living_architecture', { url: 'checkout' });
    expect(miss.isError).toBe(true);
    expect(miss.text).toContain('/cart');
  });

  it('is offered to the model as a reading rather than as a feed', async () => {
    const session = await server();
    const tools = await session.tools();
    expect(tools).toContain('get_living_architecture');
    // The description is the only thing a model reads before deciding what the
    // answer means, so the honesty has to be in it and not only in the output.
    expect(tools).toContain('not a feed');
  });
});
