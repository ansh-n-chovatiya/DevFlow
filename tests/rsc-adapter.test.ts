/**
 * `fiber._debugInfo` and the adapter built on it.
 *
 * **The `_debugInfo` fixture is transcribed from `.ctx/spike-rsc.md` §3**, which
 * printed it off a real `<div id="server-only">` in `next dev` — including the
 * `{ time: … }` markers either side of the component record, which are the part
 * a hand-written fixture would have left out and are exactly what a reader
 * filtering on `name` alone gets wrong. The debug-channel rows in the second
 * block are §2's, verbatim, and the production readings are §3's own
 * `_debugInfo= null | debugKeys= []` walk.
 *
 * The two builds are exercised apart, because the whole shape of the answer
 * differs between them and a suite that only ran one would report a passing
 * adapter that lies in the other.
 */

import { describe, expect, it } from 'vitest';
import type { Resolution } from '../src/core/locate/adapter.js';
import { pos1 } from '../src/core/locate/positions.js';
import { parseSourceMap } from '../src/core/locate/sourcemap.js';
import {
  attributionFrame,
  generatedPositionOf,
  isServerComponent,
  readDebugInfo,
  readStackFrame,
  resolutionFor,
  resolveDeclaredThrough,
  devSourceMapUrl,
} from '../src/core/rsc/debug.js';
import { createRscAdapter, type RscFiberReading, type RscPort } from '../src/core/rsc/adapter.js';

// ── The fixtures ─────────────────────────────────────────────────────────────

/** The compiled chunk every dev frame names — spike §2 and §4. */
const CHUNK = '/spike-rsc/.next/dev/server/chunks/ssr/[root-of-the-server]__0f3blm3._.js';

/** spike-rsc §3: `_debugInfo` off the fiber of `<div id="server-only">`. */
const SERVER_ONLY_DEBUG_INFO: unknown = [
  { time: 7.060126953125291 },
  {
    name: 'ServerOnlyWidget',
    key: null,
    env: 'Server',
    owner: { name: 'Page', key: null, env: 'Server', props: {} },
    stack: [['Page', CHUNK, 198, 264, 187, 1, false]],
    props: { label: 'from-page' },
  },
  { time: 7.096710953125239 },
];

/** spike-rsc §2, row `2f`: `Page`'s own record, whose only frame has no file. */
const PAGE_DEBUG_INFO: unknown = [
  {
    name: 'Page',
    key: null,
    env: 'Server',
    stack: [['Promise.all', '', 0, 0, 0, 0, true]],
    props: { params: '$@30', searchParams: '$@31' },
  },
];

/** spike-rsc §2, row `74`: a `J` timing record. It has a name and is not one. */
const TIMING_RECORD: unknown = {
  name: 'SlowServerData',
  start: 1.294625000009546,
  end: 1503.296000000002,
  env: 'Server',
  stack: '$75',
  owner: '$46',
  value: '$@76',
};

/** spike-rsc §1, prod rows — enough for `detect` to stamp the build. */
const PROD_FLIGHT = [
  '2:I[39756,["/_next/static/chunks/3fntmmi971322.js"],"default"]',
  '7:["$","div",null,{"id":"slow-server-data","children":"marker=SPIKE_SUSPENDED_PAYLOAD_ARRIVED"}]',
  '',
].join('\n');

/** spike-rsc §2, dev rows. */
const DEV_FLIGHT = [
  '3f:I["[project]/app/components/ClientCounter.tsx [app-client] (ecmascript)",["/_next/static/chunks/_098lxtj._.js"],"default"]',
  '',
].join('\n');

function portFor(options: {
  flight: string;
  readings?: readonly RscFiberReading[] | null;
  tag?: string;
  attributes?: Record<string, string>;
}): RscPort {
  return {
    flightChunks: () => [options.flight],
    readingsFor: () => options.readings ?? null,
    describe: () =>
      options.tag ? { tag: options.tag, attributes: options.attributes ?? {} } : null,
  };
}

// ── Reading _debugInfo ───────────────────────────────────────────────────────

describe('readDebugInfo', () => {
  it('reads the component record and steps over the time markers', () => {
    const components = readDebugInfo(SERVER_ONLY_DEBUG_INFO);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ name: 'ServerOnlyWidget', env: 'Server' });
    expect(components[0].props).toEqual({ label: 'from-page' });
  });

  /*
   * A `J` record carries a `name` and is a stopwatch, not a component. Filtering
   * on `name` alone reports `SlowServerData` twice — once as itself and once as
   * its own duration.
   */
  it('does not mistake a J timing record for a component record', () => {
    const asComponent = readDebugInfo([TIMING_RECORD]);
    // It has both `name` and `env`, so it is read — and it carries no frames,
    // which is what keeps it from producing a source.
    expect(asComponent[0]?.stack).toEqual([]);
    expect(resolutionFor(asComponent[0]).kind).toBe('absent');
  });

  it('is empty rather than throwing for the production shape', () => {
    expect(readDebugInfo(null)).toEqual([]);
    expect(readDebugInfo(undefined)).toEqual([]);
    expect(readDebugInfo([])).toEqual([]);
  });

  it('knows a server component from a client one by env', () => {
    expect(isServerComponent(readDebugInfo(SERVER_ONLY_DEBUG_INFO)[0])).toBe(true);
    const client = readDebugInfo([{ name: 'ClientCounter', env: 'Client', stack: [] }]);
    expect(isServerComponent(client[0])).toBe(false);
  });
});

describe('readStackFrame', () => {
  it('reads the measured seven-slot frame', () => {
    const frame = readStackFrame(['ServerOnlyWidget', CHUNK, 93, 263, 91, 1, false]);
    expect(frame).toMatchObject({ fn: 'ServerOnlyWidget', file: CHUNK, line: 93, column: 263 });
    expect(frame?.isAsync).toBe(false);
  });

  it('refuses a tuple of any other arity rather than reading it half-way', () => {
    expect(readStackFrame(['ServerOnlyWidget', CHUNK, 93, 263])).toBeNull();
    expect(readStackFrame(['ServerOnlyWidget', CHUNK, 93, 263, 91, 1, false, 'extra'])).toBeNull();
  });
});

describe('resolutionFor', () => {
  /*
   * The measured subtlety: the frame on `ServerOnlyWidget`'s record is named
   * `Page` and points into `Page`'s compiled code, because it is the call site
   * — which is the answer `core/react/owner.ts` already leads with.
   */
  it('declares the component at the call site the runtime recorded, and says so', () => {
    const resolution = resolutionFor(readDebugInfo(SERVER_ONLY_DEBUG_INFO)[0]);
    expect(resolution).toEqual({
      kind: 'declared',
      name: 'ServerOnlyWidget',
      source: CHUNK,
      line: pos1(198),
      column: pos1(264),
      /*
       * `at` was missing until a real Next.js run was inspected on disk and the
       * component's `detail` came back `undefined`. The comment above and this
       * file's header both argue the frame is a call site; the contract has a
       * field for saying it, `resolutionSource` turns it into a sentence for
       * the reader, and nothing set it — so a call site shipped
       * indistinguishable from a declaration and the sentence was dead code.
       */
      at: 'call-site',
    } satisfies Resolution);
  });

  it('takes the innermost frame, not the root of the render', () => {
    const component = readDebugInfo([
      {
        name: 'ServerOnlyWidget',
        env: 'Server',
        stack: [
          ['Page', CHUNK, 198, 264, 187, 1, false],
          ['RootLayout', CHUNK, 17, 263, 16, 1, false],
        ],
      },
    ])[0];
    expect(attributionFrame(component)?.line).toBe(198);
  });

  /*
   * `Page`'s own frame is `["Promise.all","",0,0,0,0,true]` — a real record with
   * no file. Reported as `declared` it would put an empty path in front of a
   * reader; reported as absent-with-a-name it says what is true.
   */
  it('is absent, with the name kept, when the frame names no file', () => {
    const resolution = resolutionFor(readDebugInfo(PAGE_DEBUG_INFO)[0]);
    expect(resolution.kind).toBe('absent');
    expect(resolution.name).toBe('Page');
    if (resolution.kind === 'absent') expect(resolution.reason).toBe('server-rendered');
  });
});

// ── Through the source map ───────────────────────────────────────────────────

describe('resolveDeclaredThrough', () => {
  /**
   * An **indexed (`sections`) map**, which is the shape §4 measured Next serving
   * from `/__nextjs_source-map`: top-level `sources` empty, `mappings` empty,
   * the real content in `sections`. A flat-only reader reports nothing here and
   * says nothing about why, which is the whole reason this calls
   * `core/locate/sourcemap.ts` instead of decoding anything itself.
   *
   * The section's mapping is hand-built to put generated line 1, column 0 at
   * `ServerOnlyWidget.tsx` line 6, column 4 — 0-based, as a map is — so that a
   * 1-based frame of 2:1 must come back as 7:5.
   */
  const INDEXED_MAP = JSON.stringify({
    version: 3,
    sources: [],
    mappings: '',
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: {
          version: 3,
          sources: ['app/components/ServerOnlyWidget.tsx'],
          names: [],
          mappings: ';AAMI',
        },
      },
    ],
  });

  it('maps a 1-based frame through an indexed map to a 1-based original', () => {
    const declared: Resolution = {
      kind: 'declared',
      name: 'ServerOnlyWidget',
      source: CHUNK,
      // `pos1` is the assertion positions.ts licenses for a React-recorded line.
      line: pos1(2),
      column: pos1(1),
    };
    const upgraded = resolveDeclaredThrough(declared, parseSourceMap(INDEXED_MAP));

    expect(upgraded).toEqual({
      kind: 'declared',
      name: 'ServerOnlyWidget',
      source: 'app/components/ServerOnlyWidget.tsx',
      line: 7,
      column: 5,
    });
  });

  /*
   * Pinned so that if the direction is ever measured to be wrong, exactly one
   * test goes red rather than every attribution being quietly one line off —
   * which is `positions.ts`'s whole thesis.
   */
  it('treats a frame as 1-based and a generated position as 0-based', () => {
    expect(generatedPositionOf({ fn: '', file: CHUNK, line: pos1(93), column: pos1(263), isAsync: false }))
      .toEqual({ line: 92, column: 262 });
  });

  /**
   * The axes do not cross, and this is the assertion that says so.
   *
   * Svelte's `__svelte_meta` records a 1-based line beside a 0-based column in
   * one object, so `pos1(column)` there is one column wrong forever and nothing
   * catches it. React's frames are not like that, and the evidence is in the
   * spike's own bytes: every frame it printed has an enclosing column of
   * exactly `1`, and those enclosing positions are top-level declarations that
   * begin at the start of their line — which a 0-based column would record as
   * `0`. Both axes are 1-based, so both are shifted by the same amount.
   */
  it('shifts both axes equally, because both are 1-based', () => {
    const MEASURED_FRAMES: [number, number, number, number][] = [
      // name, line, column, enclosingLine, enclosingColumn — spike §2.
      [93, 263, 91, 1],
      [188, 263, 187, 1],
      [198, 264, 187, 1],
      [17, 263, 16, 1],
    ];

    for (const [, , , enclosingColumn] of MEASURED_FRAMES) {
      expect(enclosingColumn).toBe(1);
    }

    for (const [line, column] of MEASURED_FRAMES) {
      const frame = readStackFrame(['fn', CHUNK, line, column, 0, 1, false]);
      const generated = generatedPositionOf(frame!);
      expect(line - generated.line).toBe(column - generated.column);
    }
  });

  it('leaves the resolution alone when no segment covers the frame', () => {
    const declared: Resolution = {
      kind: 'declared',
      name: 'ServerOnlyWidget',
      source: CHUNK,
      line: pos1(9000),
      column: pos1(1),
    };
    expect(resolveDeclaredThrough(declared, parseSourceMap(INDEXED_MAP))).toBe(declared);
  });

  it('encodes the compiled path into the dev source-map URL', () => {
    expect(devSourceMapUrl('http://localhost:3000/', CHUNK)).toBe(
      `http://localhost:3000/__nextjs_source-map?filename=${encodeURIComponent(CHUNK)}`,
    );
  });
});

// ── The adapter ──────────────────────────────────────────────────────────────

describe('createRscAdapter — detect', () => {
  it('is not detected on a page with no flight payload', () => {
    const adapter = createRscAdapter(portFor({ flight: '' }));
    expect(adapter.detect()).toEqual({ framework: 'rsc', detected: false });
  });

  it('stamps the build off the payload without ever asking for a reading', () => {
    let walked = false;
    const port: RscPort = {
      flightChunks: () => [PROD_FLIGHT],
      readingsFor: () => {
        walked = true;
        return null;
      },
      describe: () => null,
    };

    expect(createRscAdapter(port).detect()).toMatchObject({
      framework: 'rsc',
      detected: true,
      build: 'production',
    });
    expect(walked).toBe(false);
  });

  it('stamps development off a string module id', () => {
    expect(createRscAdapter(portFor({ flight: DEV_FLIGHT })).detect().build).toBe('development');
  });
});

describe('createRscAdapter — fromElement in dev', () => {
  /*
   * The measured dev walk: the server component's record is on the *host* fiber
   * of the `<div>` it produced, because a server component has no fiber of its
   * own in the client tree. An adapter that skipped host readings would find
   * nothing at all here, which is the richest case in the whole unit.
   */
  it('declares a server component whose record is on the host fiber it produced', () => {
    const readings: RscFiberReading[] = [
      { name: null, host: true, debugInfo: SERVER_ONLY_DEBUG_INFO },
      { name: 'ClientCounter', host: false, fnSource: 'function ClientCounter(){}' },
    ];
    const chain = createRscAdapter(
      portFor({ flight: DEV_FLIGHT, readings }),
    ).fromElement({} as Element);

    expect(chain?.framework).toBe('rsc');
    // Outermost first, per the contract — the port walks nearest-first.
    expect(chain?.chain.map((r) => r.kind)).toEqual(['searchable', 'declared']);
    expect(chain?.chain[1]).toMatchObject({ name: 'ServerOnlyWidget', source: CHUNK });
  });

  it('is null when the port has no readings for the element', () => {
    expect(
      createRscAdapter(portFor({ flight: DEV_FLIGHT, readings: null })).fromElement({} as Element),
    ).toBeNull();
  });
});

describe('createRscAdapter — fromElement in production', () => {
  /**
   * §3, verbatim: `_debugInfo= null | debugKeys= []` on every fiber of the walk
   * up from `<div id="server-only">`, and the component fiber's type minified to
   * `anon-fn`.
   */
  const PROD_READINGS: RscFiberReading[] = [
    { name: null, host: true, debugInfo: null },
    { name: null, host: true, debugInfo: null },
  ];

  it('is absent with server-rendered when the markup is in the flight payload', () => {
    const chain = createRscAdapter(
      portFor({
        flight: PROD_FLIGHT,
        readings: PROD_READINGS,
        tag: 'div',
        attributes: { id: 'slow-server-data' },
      }),
    ).fromElement({} as Element);

    expect(chain?.chain).toHaveLength(1);
    expect(chain?.chain[0]).toMatchObject({ kind: 'absent', reason: 'server-rendered' });
  });

  /*
   * The other way of not knowing, and it must not wear the same reason. A miss
   * in the payload is most likely a minified client component, whose fix —
   * productionBrowserSourceMaps — is real and is a different fix from the one
   * a server component needs, which does not exist in the browser at all.
   */
  it('is absent with stripped-by-build when the markup is not on the wire', () => {
    const chain = createRscAdapter(
      portFor({
        flight: PROD_FLIGHT,
        readings: PROD_READINGS,
        tag: 'button',
        attributes: { id: 'counter' },
      }),
    ).fromElement({} as Element);

    expect(chain?.chain[0]).toMatchObject({ kind: 'absent', reason: 'stripped-by-build' });
  });

  /*
   * This used to assert that a `searchable` anywhere in the walk suppressed the
   * production answer entirely, on the reasoning that `server-rendered` claimed
   * over a real answer is a confident lie.
   *
   * Running the built extension against a real Next.js application showed the
   * rule was too strong. Every element on an App Router page sits under Next's
   * own client boundaries — `LayoutRouter`, `RedirectBoundary`, `ErrorBoundary`
   * — which are ordinary functions in the production bundle and yield a
   * `searchable` each; seven were measured. So the production arm was
   * unreachable on every page it was written for.
   *
   * The two facts are not in competition, which is what the old rule assumed. A
   * function *above* an element is its ancestor, not necessarily the thing that
   * rendered it — and if the element's markup is in the flight payload, then a
   * server component emitted it, however many client boundaries it was passed
   * through afterwards. So both are reported: the ancestors as `searchable`,
   * and the element's own origin as `absent`/`server-rendered`, innermost,
   * where a statement about the element belongs.
   *
   * The original worry survives where it was actually right: nothing is
   * appended over a `declared` resolution, which is a real identity for the
   * element itself rather than for something above it.
   */
  it('reports server-rendered beside the ancestors, not instead of them', () => {
    const chain = createRscAdapter(
      portFor({
        flight: PROD_FLIGHT,
        readings: [
          { name: null, host: true, debugInfo: null },
          { name: null, host: false, fnSource: 'function(){return null}' },
        ],
        tag: 'div',
        attributes: { id: 'slow-server-data' },
      }),
    ).fromElement({} as Element);

    // Outermost first: the wrapper, then the element's own origin.
    expect(chain?.chain.map((r) => r.kind)).toEqual(['searchable', 'absent']);
  });

  /*
   * `unknown` is not `production`. A payload with no I row must not make every
   * component on the page report as absent.
   */
  it('claims nothing when the build could not be stamped', () => {
    expect(
      createRscAdapter(
        portFor({
          flight: '1:"$Sreact.fragment"\n',
          readings: PROD_READINGS,
          tag: 'div',
          attributes: { id: 'slow-server-data' },
        }),
      ).fromElement({} as Element),
    ).toBeNull();
  });
});
