// @vitest-environment jsdom

/**
 * The wiring between an adapter's `Resolution` and what a flow stores.
 *
 * Fixtures mirror shapes printed by the Wave 1 spikes (`.ctx/spike-*.md`) —
 * a Svelte `declared` from `__svelte_meta.loc`, a Vue `declared` with no line,
 * an RSC `absent` for a production server component.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FrameworkAdapter, Resolution } from '../src/core/locate/adapter.js';
import { resolutionId, resolutionSource } from '../src/core/locate/resolution.js';
import { buildFlowFrameworks } from '../src/core/locate/flow-frameworks.js';
import { chainsFor, detectFrameworks } from '../src/injected/registry.js';
import { flightChunks } from '../src/injected/rsc.js';
import { resolveSvelteElement } from '../src/core/svelte/index.js';
import { pos1 } from '../src/core/locate/positions.js';
import type { Step } from '../src/shared/types.js';

const declared: Resolution = {
  kind: 'declared',
  name: 'Counter',
  source: 'src/Counter.svelte',
  line: pos1(5),
};
const searchable: Resolution = {
  kind: 'searchable',
  name: 'DeepLeaf',
  fnSource: 'function DeepLeaf(){ return null }',
};
const absent: Resolution = {
  kind: 'absent',
  name: 'ServerOnlyWidget',
  reason: 'server-rendered',
  detail: 'This production build leaves no identity for a server component.',
};

describe('resolutionSource', () => {
  it('calls a declared resolution resolved, and says the runtime told us', () => {
    const source = resolutionSource(declared);
    expect(source.status).toBe('resolved');
    expect(source.via).toBe('debug-source');
    expect(source.source).toBe('src/Counter.svelte');
    expect(source.line).toBe(5);
  });

  /*
   * The load-bearing one. A searchable resolution is a needle and nothing more:
   * no bundle fetched, no map decoded. Calling it `resolved` would put a
   * component in the table with a status claiming a path it does not have.
   */
  it('calls a searchable resolution pending, never resolved', () => {
    const source = resolutionSource(searchable);
    expect(source.status).toBe('pending');
    expect(source.source).toBeUndefined();
    expect(source.detail).toMatch(/searched for in the page/);
  });

  it('carries the adapter’s own sentence for an absence', () => {
    const source = resolutionSource(absent);
    expect(source.status).toBe('not-found');
    expect(source.detail).toBe(absent.kind === 'absent' ? absent.detail : '');
  });

  /* Vue records a file and no line — the contract allows it, so nothing invents one. */
  it('omits the line when the runtime recorded none', () => {
    const source = resolutionSource({
      kind: 'declared',
      name: 'DeepLeaf',
      source: 'src/DeepLeaf.vue',
    });
    expect(source.status).toBe('resolved');
    expect(source.line).toBeUndefined();
  });

  it('marks a call-site source as one, rather than passing it off', () => {
    const source = resolutionSource({ ...declared, at: 'call-site' });
    expect(source.detail).toMatch(/where the component was used/);
  });
});

describe('resolutionId', () => {
  it('is stable for one component and distinct across files', () => {
    expect(resolutionId(declared)).toBe(resolutionId({ ...declared }));
    expect(resolutionId(declared)).not.toBe(
      resolutionId({ ...declared, source: 'src/Other.svelte' }),
    );
  });

  /* Same name, different declaration site, must not collapse into one row. */
  it('separates same-named components declared in different places', () => {
    const a = resolutionId({ kind: 'declared', name: 'Button', source: 'a/Button.vue' });
    const b = resolutionId({ kind: 'declared', name: 'Button', source: 'b/Button.vue' });
    expect(a).not.toBe(b);
  });
});

function stepWith(framework: 'vue' | 'svelte' | 'rsc', chain: string[]): Step {
  return {
    index: 1,
    type: 'click',
    timestamp: 0,
    url: 'https://example.test/',
    element: {
      tag: 'button',
      cssSelector: '#b',
      xpath: '//button',
      boundingBox: null,
      frameworks: [{ framework, chain }],
    },
  } as unknown as Step;
}

describe('buildFlowFrameworks', () => {
  const id = resolutionId(declared);
  const table = { svelte: { [id]: resolutionSource(declared) } };

  it('keeps only components a surviving step still names', () => {
    const built = buildFlowFrameworks(
      [stepWith('svelte', [id])],
      [{ framework: 'svelte', detected: true, build: 'development' }],
      { svelte: { ...table.svelte, orphan: resolutionSource(searchable) } },
    );
    expect(Object.keys(built.svelte?.components ?? {})).toEqual([id]);
  });

  /*
   * Detected but never clicked into. An empty `components: {}` under
   * `detected: true` reads as "Svelte was here and we found nothing", which is
   * a stronger claim than the recording can make.
   */
  it('omits a framework no surviving step references', () => {
    const built = buildFlowFrameworks(
      [stepWith('vue', ['someVueId'])],
      [{ framework: 'svelte', detected: true }],
      table,
    );
    expect(built.svelte).toBeUndefined();
  });

  it('returns nothing at all when no adapter reported a runtime', () => {
    expect(buildFlowFrameworks([stepWith('svelte', [id])], null, table)).toEqual({});
  });
});

describe('the registry', () => {
  const throwing: FrameworkAdapter = {
    framework: 'vue',
    detect: () => {
      throw new Error('hostile runtime');
    },
    fromElement: () => {
      throw new Error('hostile runtime');
    },
  };
  const working: FrameworkAdapter = {
    framework: 'svelte',
    detect: () => ({ framework: 'svelte', detected: true }),
    fromElement: () => ({ framework: 'svelte', chain: [declared] }),
  };

  /*
   * Nothing about a framework adapter may fail a recording — the rule `arkgTry`,
   * `gitTry` and `otelTry` hold on the server, applied in the page.
   */
  it('does not let one throwing adapter cost the others their page', () => {
    expect(detectFrameworks([throwing, working])).toHaveLength(1);
    expect(chainsFor(document.createElement('div'), [throwing, working])).toHaveLength(1);
  });

  it('drops an adapter that resolved an empty chain', () => {
    const empty: FrameworkAdapter = {
      framework: 'rsc',
      detect: () => ({ framework: 'rsc', detected: true }),
      fromElement: () => ({ framework: 'rsc', chain: [] }),
    };
    expect(chainsFor(document.createElement('div'), [empty])).toEqual([]);
  });
});

describe('flightChunks', () => {
  /*
   * Measured: `self.__next_f` is drained to length 0 by hydration in both
   * builds, so the payload has to come from the `<script>` tags that pushed
   * into it. A reader of the global reports, wrongly, that the page is not RSC.
   */
  it('reads the inline script tags and unescapes the JSON string', () => {
    const doc = document.implementation.createHTMLDocument('t');
    const script = doc.createElement('script');
    script.textContent = 'self.__next_f.push([1,"3f:I[\\"app/page.tsx\\",[],\\"default\\"]\\n"])';
    doc.body.appendChild(script);

    const chunks = flightChunks(doc);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('3f:I["app/page.tsx"');
    expect(chunks[0]).not.toContain('\\"');
  });

  it('keeps both pushes, because a row can straddle them', () => {
    const doc = document.implementation.createHTMLDocument('t');
    for (const part of ['"0:{\\"a\\":"', '"1}\\n"']) {
      const s = doc.createElement('script');
      s.textContent = `self.__next_f.push([1,${part}])`;
      doc.body.appendChild(s);
    }
    expect(flightChunks(doc)).toHaveLength(2);
  });

  it('ignores a script that never mentions the global', () => {
    const doc = document.implementation.createHTMLDocument('t');
    const s = doc.createElement('script');
    s.textContent = 'console.log("hello")';
    doc.body.appendChild(s);
    expect(flightChunks(doc)).toEqual([]);
  });
});

/*
 * `ResolvedChain.build` exists *because of* Svelte — `detect()` cannot know the
 * build, since `window.__svelte` is byte-identical in development and
 * production and there is no devtools hook. The adapter was declared against
 * that and then never set the field, so a real `vite dev` run recorded
 * `build: "unknown"` on a page where every element carried `__svelte_meta`.
 * Found by driving the built extension against a real Svelte app.
 */
describe('the build Svelte reports from its walk', () => {
  const page = {
    runtimeGlobal: true,
    devMetaAnywhere: true,
    delegatedEventsAnywhere: true,
    hydrationMarkers: false,
    sveltekit: false,
  };
  const meta = { loc: { file: 'src/lib/CheckoutButton.svelte', line: 10, column: 2 } };

  it('calls a page carrying __svelte_meta a development build', () => {
    const chain = resolveSvelteElement({ meta, page });
    expect(chain?.build).toBe('development');
  });

  /* Metadata stripped is something only a production build does. */
  it('calls a stripped page a production build', () => {
    const chain = resolveSvelteElement({
      meta: undefined,
      page: { ...page, devMetaAnywhere: false },
    });
    expect(chain?.chain[0]?.kind).toBe('absent');
    expect(chain?.build).toBe('production');
  });

  /*
   * The one absence that is not evidence about the build: the markup is
   * server-rendered and the client runtime may still be arriving, so calling it
   * production would be a guess that hardens into a stored fact.
   */
  it('refuses to guess while the page is not yet hydrated', () => {
    const chain = resolveSvelteElement({
      meta: undefined,
      page: {
        runtimeGlobal: false,
        devMetaAnywhere: false,
        delegatedEventsAnywhere: false,
        hydrationMarkers: true,
        sveltekit: true,
      },
    });
    expect(chain?.chain[0]).toMatchObject({ kind: 'absent', reason: 'not-hydrated' });
    expect(chain?.build).toBe('unknown');
  });
});

/*
 * The whole class of mistake, not the two instances of it that shipped.
 *
 * `getLocal` answers with `Partial<LocalStorageShape>` whatever it is asked
 * for, so reading a key that was never requested typechecks perfectly and is
 * `undefined` forever. `captureAndSave` read `frameworkComponents` and
 * `frameworkMeta` without asking for either: the merge was unioning against
 * nothing and *replacing* the component table on every step, losing the best
 * answer in a real recording. It was found by driving the built extension
 * against a real Next.js application, because every fixture passed.
 *
 * Nothing in the type system can catch this and the next person to add a read
 * will do it again — the resolver pass added right after the fix needed two
 * more keys and would have had the same bug. So the invariant is asserted over
 * every `getLocal` block in the file rather than the one that was wrong.
 */
describe('every storage key the worker reads is a key it asked for', () => {
  it('names each key somewhere in the function that reads it', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/background/index.ts'),
      'utf8',
    );

    /* Scoped per top-level function: a read belongs to the function it is in. */
    const starts = [...source.matchAll(/^(?:async )?function (\w+)/gm)];
    expect(starts.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const [index, start] of starts.entries()) {
      const from = start.index ?? 0;
      const to = starts[index + 1]?.index ?? source.length;
      const body = source.slice(from, to);

      const read = new Set(
        [...body.matchAll(/stored\.value\.([A-Za-z]\w*)/g)].map((m) => m[1]),
      );
      if (read.size === 0) continue;

      const asked = new Set<string>();
      for (const call of body.matchAll(/getLocal\(\[([\s\S]*?)\]\)/g)) {
        for (const key of call[1].matchAll(/'([A-Za-z]\w*)'/g)) asked.add(key[1]);
      }
      for (const one of body.matchAll(/getLocal\('([A-Za-z]\w*)'\)/g)) asked.add(one[1]);

      for (const key of read) {
        if (!asked.has(key)) offenders.push(`${start[1]} reads ${key} without asking`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/*
 * A server action that *worked* is the case that matters, and it was the case
 * being thrown away.
 *
 * `leanCalls` keeps request headers only on a failed call — `DIAGNOSTIC_HEADERS`
 * answers "what went wrong", so a successful call is stripped to `{}`. Next.js
 * names the server action a request invoked in `next-action`, and
 * `mcp-server/rsc.js` maps that id to the file and export it came from. Under
 * the old rule the manifest reader was reachable only for actions that failed,
 * which is the opposite of useful.
 */
describe('the headers a send keeps', () => {
  it('keeps next-action on a call that succeeded', async () => {
    const { leanCalls } = await import('../src/features/mcp/send.js');
    const step = {
      networkCalls: [
        {
          status: 200,
          requestHeaders: { 'next-action': '40f4378abc', cookie: 'secret', accept: 'text/x-component' },
          responseHeaders: { 'content-type': 'text/x-component' },
          requestBody: null,
          responseBody: null,
        },
      ],
    } as never;

    const [call] = leanCalls(step).networkCalls!;
    expect(call.requestHeaders?.['next-action']).toBe('40f4378abc');
    // Everything else still goes: this widened one header, not the rule.
    expect(call.requestHeaders?.cookie).toBeUndefined();
    expect(call.requestHeaders?.accept).toBeUndefined();
    expect(call.responseHeaders?.['content-type']).toBeUndefined();
  });

  it('still keeps the diagnostic headers when the call failed', async () => {
    const { leanCalls } = await import('../src/features/mcp/send.js');
    const step = {
      networkCalls: [
        {
          status: 500,
          requestHeaders: { cookie: 'secret' },
          responseHeaders: { 'content-type': 'application/json', 'retry-after': '30' },
          requestBody: null,
          responseBody: null,
        },
      ],
    } as never;

    const [call] = leanCalls(step).networkCalls!;
    expect(call.responseHeaders?.['retry-after']).toBe('30');
    expect(call.requestHeaders?.cookie).toBeUndefined();
  });
});
