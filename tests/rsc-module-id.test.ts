/**
 * The join that gives `mcp-server/rsc.js` a caller.
 *
 * `rsc-manifest.test.ts` already proves the manifest reader turns `56850` into
 * `app/components/ClientCounter.tsx`. Nothing produced the `56850`. Every
 * production `I` row in `.ctx/spike-rsc.md` §2 carries one, and the missing
 * piece was a rule saying *which* `I` row belongs to the element that was
 * clicked. This suite is that rule, and then the whole path through it:
 *
 *   wire → `flightClientModuleFor` → `Resolution.moduleId` →
 *   `ComponentSource.moduleId` → `get_step_detail` → `fileForModuleId`.
 *
 * The flight bytes are `.ctx/spike-rsc.md` §1–2's, with one adaptation stated
 * plainly rather than hidden: the spike's own client-component row is
 * `["$","$L4",null,{"title":"Cart"}]`, and `title` is not an attribute that
 * reaches the DOM as itself, so the fixture passes `id` as well. That is the
 * shape the join needs and it is also, precisely, the limit of the join — the
 * refusal tests below are about the payload where it is absent.
 *
 * The manifest fixtures are `rsc-manifest.test.ts`'s, for its reason: two
 * transcriptions of one measured artefact are two things to drift apart.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';
import {
  createRscAdapter,
  type RscFiberReading,
  type RscPort,
} from '../src/core/rsc/adapter.js';
import { flightClientModuleFor, parseFlightPayload } from '../src/core/rsc/flight.js';
import { resolutionId, resolutionSource } from '../src/core/locate/resolution.js';

// ── The wire ─────────────────────────────────────────────────────────────────

/**
 * A production payload: three client modules, one server-rendered `<div>`, and
 * a client module reference carrying an `id` the browser can see.
 *
 * `12177` is the spike's own id for the page's client component, and `$L4` is
 * the forward reference to it, verbatim from §1. `$5` beside it is the *back*
 * reference form, which is the same meaning arriving in the other order.
 */
const PROD = [
  '1:"$Sreact.fragment"',
  '2:I[39756,["/_next/static/chunks/3fntmmi971322.js"],"default"]',
  '4:I[12177,["/_next/static/chunks/3fntmmi971322.js","/_next/static/chunks/1e0p9l01qr10t.js"],"default"]',
  '5:I[7523,["/_next/static/chunks/3fntmmi971322.js"],"ActionForm"]',
  '7:["$","main",null,{"id":"page-main","children":[' +
    '["$","div",null,{"id":"server-panel","data-computed":30,"children":"marker"}],' +
    '["$","$L4",null,{"id":"cart","title":"Cart"}],' +
    '["$","$5",null,{"data-form":"echo"}]]}]',
].join('\n');

/** The dev form of the same page: the `I` row's id is a path (§2). */
const DEV = [
  '3f:I["[project]/app/components/ClientCounter.tsx [app-client] (ecmascript)",' +
    '["/_next/static/chunks/_098lxtj._.js"],"default"]',
  '32:["$","main",null,{"children":[["$","$L3f",null,{"id":"cart"}]],"x":1}]',
].join('\n');

const prodModel = parseFlightPayload(`${PROD}\n`).model;
const devModel = parseFlightPayload(`${DEV}\n`).model;

describe('flightClientModuleFor — which client module rendered this element', () => {
  it('joins an element to the I row its props sit under', () => {
    expect(
      flightClientModuleFor(prodModel, { tag: 'section', attributes: { id: 'cart' } }),
    ).toMatchObject({ row: '4', moduleId: 12177, exportName: 'default', sourceFile: null });
  });

  it('reads a resolved back-reference as well as a lazy forward one', () => {
    expect(
      flightClientModuleFor(prodModel, { tag: 'form', attributes: { 'data-form': 'echo' } }),
    ).toMatchObject({ row: '5', moduleId: 7523, exportName: 'ActionForm' });
  });

  /*
   * The whole production asymmetry in one assertion: dev's id is a path, so the
   * file is on the wire and nothing needs the filesystem; prod's is an integer,
   * so `fileForModuleId` is the only route left.
   */
  it('carries dev’s path through as a file, and prod’s integer as nothing', () => {
    expect(
      flightClientModuleFor(devModel, { tag: 'div', attributes: { id: 'cart' } })?.sourceFile,
    ).toBe('app/components/ClientCounter.tsx');
    expect(
      flightClientModuleFor(prodModel, { tag: 'section', attributes: { id: 'cart' } })?.sourceFile,
    ).toBeNull();
  });

  /*
   * The refusal, and it is the same one `flightElementFor` makes. A `<div>` with
   * nothing distinguishing about it matches whatever came first, and the wrong
   * answer that produces is not "no idea" — it is a *file path* for a component
   * nobody clicked.
   */
  it('refuses an element with nothing distinguishing about it', () => {
    expect(flightClientModuleFor(prodModel, { tag: 'div', attributes: {} })).toBeNull();
    expect(
      flightClientModuleFor(prodModel, { tag: 'div', attributes: { class: 'cart' } }),
    ).toBeNull();
  });

  /*
   * A server-rendered element is not a client module, and must never be handed
   * one. `#server-panel` is in the payload as an ordinary `div` tuple; the
   * component that rendered it has no id anywhere and this says so.
   */
  it('does not hand a server-rendered element the nearest client module', () => {
    expect(
      flightClientModuleFor(prodModel, {
        tag: 'div',
        attributes: { id: 'server-panel', 'data-computed': '30' },
      }),
    ).toBeNull();
  });

  it('does not invent one for an element the payload never mentions', () => {
    expect(
      flightClientModuleFor(prodModel, { tag: 'button', attributes: { id: 'nowhere' } }),
    ).toBeNull();
  });
});

// ── The adapter ──────────────────────────────────────────────────────────────

function portFor(
  chunks: readonly string[],
  attributes: Record<string, string>,
  readings: readonly RscFiberReading[],
): RscPort {
  return {
    flightChunks: () => chunks,
    readingsFor: () => readings,
    describe: () => ({ tag: 'div', attributes }),
    version: () => '16.3.4',
  };
}

/** Next's own boundaries, minified — what a real production walk actually finds. */
const WRAPPERS = ['x', 'd', 'h'].map((name) => ({
  name,
  host: false,
  debugInfo: undefined,
  fnSource: `function ${name}(){return null}`,
}));

describe('the adapter attaches the id to the component the wire named', () => {
  it('gives a production client component its module id instead of a shrug', () => {
    const adapter = createRscAdapter(
      portFor([`${PROD}\n`], { id: 'cart' }, [
        { name: null, host: true, debugInfo: undefined, fnSource: null },
        { name: 'q', host: false, debugInfo: undefined, fnSource: 'function q(){return null}' },
        ...WRAPPERS,
      ]),
    );

    const chain = adapter.fromElement({} as Element)?.chain ?? [];
    // Outermost first, so the element's own component is last.
    const [innermost] = chain.slice(-1);
    expect(innermost.kind).toBe('searchable');
    expect(innermost.moduleId).toBe('12177');
    // Only the one that was joined. The wrappers are ancestors and carry none.
    expect(chain.filter((r) => r.moduleId !== undefined)).toHaveLength(1);
  });

  /*
   * The answer the join replaces. An element whose markup is not on the wire and
   * whose fiber was minified past recognition used to be `stripped-by-build` and
   * nothing else — honest then, and half an answer now that the payload has been
   * asked a question it can answer. The reason stays; the id is new, and it is
   * the id that reaches `fileForModuleId`.
   */
  it('still answers when the fiber walk found nothing at all', () => {
    const adapter = createRscAdapter(
      portFor([`${PROD}\n`], { id: 'cart' }, [
        { name: null, host: true, debugInfo: undefined, fnSource: null },
      ]),
    );

    const [only] = adapter.fromElement({} as Element)?.chain ?? [];
    expect(only).toMatchObject({ kind: 'absent', reason: 'stripped-by-build', moduleId: '12177' });
    expect(only.kind === 'absent' && only.detail).toContain('12177');
  });

  /*
   * Development pays for the same code path immediately: the wire states the
   * file, so a `searchable` that would have cost a bundle fetch, a map decode
   * and a text search becomes a `declared` with the answer already in it.
   */
  it('upgrades a dev client component to declared, from the path on the wire', () => {
    const adapter = createRscAdapter(
      portFor([`${DEV}\n`], { id: 'cart' }, [
        { name: null, host: true, debugInfo: undefined, fnSource: null },
        {
          name: 'ClientCounter',
          host: false,
          debugInfo: undefined,
          fnSource: 'function ClientCounter(){}',
        },
      ]),
    );

    const [innermost] = (adapter.fromElement({} as Element)?.chain ?? []).slice(-1);
    expect(innermost).toMatchObject({
      kind: 'declared',
      name: 'ClientCounter',
      source: 'app/components/ClientCounter.tsx',
      at: 'declaration',
      // Kept exactly as the wire wrote it, decoration and all — `tidyPath` is
      // the one place that rule lives and it lives on the other side.
      moduleId: '[project]/app/components/ClientCounter.tsx [app-client] (ecmascript)',
    });
  });

  it('leaves a page with no matching client module exactly as it was', () => {
    const adapter = createRscAdapter(
      portFor([`${PROD}\n`], { id: 'server-panel', 'data-computed': '30' }, [
        { name: null, host: true, debugInfo: undefined, fnSource: null },
      ]),
    );

    const [only] = adapter.fromElement({} as Element)?.chain ?? [];
    expect(only).toMatchObject({ kind: 'absent', reason: 'server-rendered' });
    expect(only.moduleId).toBeUndefined();
  });
});

// ── The conversion ───────────────────────────────────────────────────────────

describe('the id survives the conversion to ComponentSource', () => {
  it('rides every status, not only the ones that failed', () => {
    expect(
      resolutionSource({ kind: 'searchable', name: 'q', fnSource: 'x', moduleId: '12177' })
        .moduleId,
    ).toBe('12177');
    expect(
      resolutionSource({
        kind: 'declared',
        name: 'C',
        source: 'app/c.tsx',
        moduleId: '12177',
      }).moduleId,
    ).toBe('12177');
    expect(
      resolutionSource({
        kind: 'absent',
        reason: 'stripped-by-build',
        detail: 'd',
        moduleId: '12177',
      }).moduleId,
    ).toBe('12177');
  });

  it('leaves every component that never had one untouched', () => {
    expect(resolutionSource({ kind: 'searchable', name: 'q', fnSource: 'x' })).not.toHaveProperty(
      'moduleId',
    );
  });

  /*
   * The data-loss guard. Two unnamed production client components are two
   * `absent` resolutions with no name, and `nameOnlyId('Anonymous')` is a
   * *placeholder* id every unnamed absence collapses onto — so without this the
   * second would overwrite the first and take the one fact that could have found
   * its file with it.
   */
  it('keeps two unnamed client components apart by their ids', () => {
    const a = resolutionId({
      kind: 'absent',
      reason: 'stripped-by-build',
      detail: 'd',
      moduleId: '12177',
    });
    const b = resolutionId({
      kind: 'absent',
      reason: 'stripped-by-build',
      detail: 'd',
      moduleId: '7523',
    });

    expect(a).not.toBe(b);
    // Not a placeholder, and not name-only: this one has an identity to resolve.
    expect(a.startsWith('n')).toBe(false);
  });
});

// ── End to end, through the real server ──────────────────────────────────────

/** `rsc-manifest.test.ts`'s fixture — §4's two entries, in §4's shape. */
const CLIENT_ENTRIES =
  '{"[project]/app/components/ClientCounter.tsx":{"id":12177,"name":"*","chunks":["/_next/static/chunks/3fntmmi971322.js"],"async":false},' +
  '"[project]/app/components/ActionForm.tsx":{"id":7523,"name":"*","chunks":["/_next/static/chunks/3fntmmi971322.js"],"async":false}}';

/** spike-rsc §5, verbatim, including the key that must never be returned. */
const SERVER_MANIFEST = JSON.stringify({
  node: {
    '40f43782738bb9c45a0870d2dcbb114f82c8acb929': {
      workers: { 'app/page': { moduleId: 57526, async: false, codeHash: null } },
      filename: 'app/actions.ts',
      exportedName: 'echoAction',
    },
  },
  edge: {},
  encryptionKey: 'SPIKE_ENCRYPTION_KEY_NOT_TO_BE_RETURNED',
});

const flow = {
  schemaVersion: 1,
  id: 'rsc-module-id',
  name: 'RSC production, module id only',
  timestamp: 1788519600000,
  startUrl: 'http://localhost:3001/',
  steps: [
    {
      type: 'click',
      url: 'http://localhost:3001/',
      timestamp: 1788519602000,
      action: 'Clicked "#cart"',
      stepNumber: 1,
      element: {
        tag: 'section',
        cssSelector: '#cart',
        xpath: '/html/body/main/section',
        boundingBox: null,
        frameworks: [{ framework: 'rsc', chain: ['aa11bb22cc'] }],
      },
      networkCalls: [
        {
          method: 'POST',
          url: 'http://localhost:3001/',
          requestHeaders: {
            'Next-Action': '40f43782738bb9c45a0870d2dcbb114f82c8acb929',
            'content-type': 'text/plain;charset=UTF-8',
          },
          requestBody: '["hello"]',
          status: 200,
          responseHeaders: {},
          responseBody: null,
          durationMs: 14,
          timestamp: 1788519602100,
        },
      ],
    },
  ],
  rsc: {
    detected: true,
    version: '16.3.4',
    build: 'production',
    components: {
      aa11bb22cc: {
        name: 'Anonymous',
        status: 'not-found',
        moduleId: '12177',
        detail:
          'A production build left this client component nothing but a module id on the wire.',
      },
    },
  },
};

let home = '';
let root = '';
let server: McpSession;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-rsc-id-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-rsc-app-'));

  const serverDir = path.join(root, '.next', 'server');
  fs.mkdirSync(path.join(serverDir, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(serverDir, 'app', 'page_client-reference-manifest.js'),
    `globalThis.__RSC_MANIFEST=globalThis.__RSC_MANIFEST||{};globalThis.__RSC_MANIFEST["/page"]=${CLIENT_ENTRIES}`,
  );
  fs.writeFileSync(path.join(serverDir, 'server-reference-manifest.json'), SERVER_MANIFEST);

  server = await startServer({ home, env: { DEVFLOW_PROJECT_ROOT: root } });
  const posted = await server.post('/flows', JSON.stringify(flow));
  expect(posted.status).toBe(200);
}, 30_000);

afterAll(() => {
  server?.stop();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('get_step_detail finishes the join off the filesystem', () => {
  it('names the file behind a module id the browser could only number', async () => {
    const text = await server.call('get_step_detail', {
      id: 'rsc-module-id',
      step: 1,
      include: ['component'],
    });

    expect(text).toContain('module 12177');
    expect(text).toContain('app/components/ClientCounter.tsx');
  });

  /*
   * The one production route a server action has: the `next-action` request
   * header the extension already captures, against
   * `server-reference-manifest.json`. Both halves are measured — §5 for the
   * manifest, §1 for the header — and neither is reachable from a browser.
   */
  it('names the file and export behind a next-action id', async () => {
    const text = await server.call('get_step_detail', {
      id: 'rsc-module-id',
      step: 1,
      include: ['network'],
    });

    expect(text).toContain('server action echoAction');
    expect(text).toContain('app/actions.ts');
    expect(text).not.toContain('SPIKE_ENCRYPTION_KEY_NOT_TO_BE_RETURNED');
  });
});
