// @vitest-environment jsdom

/**
 * The wiring between an adapter's `Resolution` and what a flow stores.
 *
 * Fixtures mirror shapes printed by the Wave 1 spikes (`.ctx/spike-*.md`) —
 * a Svelte `declared` from `__svelte_meta.loc`, a Vue `declared` with no line,
 * an RSC `absent` for a production server component.
 */
import { describe, expect, it } from 'vitest';
import type { FrameworkAdapter, Resolution } from '../src/core/locate/adapter.js';
import { resolutionId, resolutionSource } from '../src/core/locate/resolution.js';
import { buildFlowFrameworks } from '../src/core/locate/flow-frameworks.js';
import { chainsFor, detectFrameworks } from '../src/injected/registry.js';
import { flightChunks } from '../src/injected/rsc.js';
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
    expect(source.detail).toMatch(/bundle search/);
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
