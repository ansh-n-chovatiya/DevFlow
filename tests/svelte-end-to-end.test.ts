/**
 * A Svelte recording, from the payload the extension posts to the reply a tool
 * gives — and, for a production build, from the payload to the *refusal*.
 *
 * `framework-end-to-end.test.ts` is this test's sibling and says why the shape
 * exists: `saveFlow` copies a posted payload's flow-level fields **by name**, so
 * a table that every fixture written straight onto disk keeps can still be
 * dropped on the way there. `svelte` was added to that list at the same time as
 * `vue`, which is a reason to believe it survives and not a reason to assume it,
 * so the first two cases below read `flow.json` rather than a reply.
 *
 * What this file adds to its sibling is the **negative**. Svelte production is
 * the one measured case in this repository where "we cannot tell you" is the
 * ordinary answer rather than a miss, and the thing that has to keep working is
 * the *sentence* — a reader who gets a blank concludes the element had no
 * component, which is false. So the production flow asserts the reason text
 * survives the same round trip the resolved names do.
 *
 * Every id, name, file, line and sentence below was minted by driving
 * `dist/` in a headed Chromium against three real applications:
 *
 *   vite dev            App › CartPanel › CheckoutButton, from `__svelte_meta`
 *   sveltekit vite dev  +page › CartPanel › CheckoutButton, generated frames
 *                       and `Pyramid_N` filtered out by `chain.ts`
 *   vite build          zero own properties on every element; one `absent` row
 *
 * The fourth and fifth targets of that run — `vite preview` of a SvelteKit
 * build, with and without `build.sourcemap: true` — produced a payload
 * byte-identical to the plain production one but for the SvelteKit sentence, so
 * they are represented here by that sentence rather than by a fourth flow.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';

const BASE = Date.UTC(2026, 8, 4, 11, 0);

let home: string;
let server: McpSession;

/** One click on `#checkout`, as the content script enriched it. */
function step(url: string, chain: string[]): Record<string, unknown> {
  return {
    type: 'click',
    url,
    timestamp: BASE + 1000,
    action: 'Clicked "Checkout"',
    stepNumber: 1,
    element: {
      tag: 'button',
      label: 'Checkout (0)',
      cssSelector: '#checkout',
      xpath: '//*[@id="checkout"]',
      boundingBox: null,
      // Outermost first, as the adapter produces it.
      frameworks: [{ framework: 'svelte', chain }],
    },
  };
}

/**
 * `PLAIN_DETAIL` from `src/core/svelte/absence.ts`, as it arrived in
 * `frameworkComponents` from the real production run. Written out in full
 * rather than imported, because what is under test is that this text survives
 * a POST and a render — importing the constant would test that a string equals
 * itself.
 */
const PROD_DETAIL =
  'Svelte strips __svelte_meta from production builds, so this element carries no link to the ' +
  'component that rendered it. Only a development build carries that link; set build.sourcemap: ' +
  'true in your Vite config if you also need production positions to be recoverable.';

/** As `features/mcp/send.ts` builds it, with the ids the real run minted. */
const plainDev = {
  schemaVersion: 1,
  id: 'svelte-real-dev',
  name: 'Svelte Real App — checkout (vite dev)',
  timestamp: BASE,
  startUrl: 'http://localhost:5176/',
  steps: [step('http://localhost:5176/', ['55c07c6555', '694166e393', '46b1301787'])],
  svelte: {
    detected: true,
    version: '5',
    /*
     * `unknown`, and that is what the run produced rather than a placeholder.
     * `detect()` is contractually forbidden to walk the tree, `window.__svelte`
     * is byte-identical in both builds, and this app is not SvelteKit — so the
     * one cheap tell is absent even though every element on the page carried
     * `__svelte_meta`. See this file's report for the field that was meant to
     * carry the walk's own answer.
     */
    build: 'unknown',
    components: {
      '55c07c6555': {
        name: 'App',
        status: 'resolved',
        via: 'debug-source',
        source: 'src/App.svelte',
        line: 10,
        column: 3,
      },
      '694166e393': {
        name: 'CartPanel',
        status: 'resolved',
        via: 'debug-source',
        source: 'src/lib/CartPanel.svelte',
        line: 9,
        column: 3,
      },
      '46b1301787': {
        name: 'CheckoutButton',
        status: 'resolved',
        via: 'debug-source',
        source: 'src/lib/CheckoutButton.svelte',
        line: 10,
        column: 1,
      },
    },
  },
};

const kitDev = {
  schemaVersion: 1,
  id: 'sveltekit-real-dev',
  name: 'SvelteKit Real App — checkout (vite dev)',
  timestamp: BASE,
  startUrl: 'http://localhost:5176/',
  steps: [step('http://localhost:5176/', ['936aee3e8e', '694166e393', '46b1301787'])],
  svelte: {
    detected: true,
    version: '5',
    // `__sveltekit_dev` exists here, which is the one build tell `detect()` gets.
    build: 'development',
    components: {
      '936aee3e8e': {
        name: '+page',
        status: 'resolved',
        via: 'debug-source',
        source: 'src/routes/+page.svelte',
        line: 7,
        column: 3,
      },
      '694166e393': {
        name: 'CartPanel',
        status: 'resolved',
        via: 'debug-source',
        source: 'src/lib/CartPanel.svelte',
        line: 9,
        column: 3,
      },
      '46b1301787': {
        name: 'CheckoutButton',
        status: 'resolved',
        via: 'debug-source',
        source: 'src/lib/CheckoutButton.svelte',
        line: 10,
        column: 1,
      },
    },
  },
};

const plainProd = {
  schemaVersion: 1,
  id: 'svelte-real-prod',
  name: 'Svelte Real App — checkout (vite build)',
  timestamp: BASE,
  startUrl: 'http://localhost:4175/',
  // One id, and a placeholder one: every absent element on a production page
  // resolves to the same `nameOnlyId('Anonymous')`.
  steps: [step('http://localhost:4175/', ['n_d37775ce'])],
  svelte: {
    detected: true,
    version: '5',
    build: 'unknown',
    components: {
      n_d37775ce: { name: 'Anonymous', status: 'not-found', detail: PROD_DETAIL },
    },
  },
};

/**
 * The shape this test reads off disk, named rather than left as `any`.
 *
 * Only the fields asserted on, so a key that stops being written is a compile
 * error here rather than an `undefined` that quietly passes a `toBeUndefined`.
 */
interface DiskComponent {
  name: string;
  status: string;
  via?: string;
  detail?: string;
  source?: string;
  line?: number;
  column?: number;
}

interface DiskFlow {
  steps: { element: { frameworks: { framework: string; chain: string[] }[] } }[];
  svelte: {
    detected: boolean;
    build: string;
    version?: string;
    components: Record<string, DiskComponent>;
  };
}

function onDisk(id: string): DiskFlow {
  return JSON.parse(
    fs.readFileSync(path.join(home, 'flows', id, 'flow.json'), 'utf8'),
  ) as DiskFlow;
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-svelte-e2e-'));
  server = await startServer({ home });

  for (const payload of [plainDev, kitDev, plainProd]) {
    const posted = await server.post('/flows', JSON.stringify(payload));
    expect(posted.status).toBe(200);
  }
}, 30_000);

afterAll(() => {
  server?.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a posted Svelte recording keeps its component table, all the way to disk', () => {
  /*
   * Read off disk rather than out of a reply, for the sibling's reason: a
   * renderer that reconstructed names from the step's chain would answer
   * correctly for a flow that had lost the table entirely.
   */
  it('writes the flow-level svelte table rather than dropping it in the by-name copy', () => {
    const flow = onDisk('svelte-real-dev');

    expect(flow.svelte).toBeDefined();
    expect(flow.svelte.detected).toBe(true);
    expect(flow.svelte.version).toBe('5');
    expect(Object.keys(flow.svelte.components)).toHaveLength(3);
    expect(flow.svelte.components['46b1301787'].source).toBe('src/lib/CheckoutButton.svelte');
    expect(flow.svelte.components['46b1301787'].line).toBe(10);
  });

  /* The step half travels separately, and losing either one loses the answer. */
  it('keeps the step’s chain, which is worthless without the table above', () => {
    const flow = onDisk('svelte-real-dev');
    expect(flow.steps[0].element.frameworks[0].framework).toBe('svelte');
    expect(flow.steps[0].element.frameworks[0].chain).toEqual([
      '55c07c6555',
      '694166e393',
      '46b1301787',
    ]);
  });

  it('names the innermost component, its file and the line the runtime gave', async () => {
    const answer = await server.call('get_step_detail', {
      id: 'svelte-real-dev',
      step: 1,
      include: ['component'],
    });

    expect(answer).toContain('svelte: CheckoutButton');
    expect(answer).toContain('src/lib/CheckoutButton.svelte:10');
  });

  it('prints the chain outermost first', async () => {
    const answer = await server.call('get_step_detail', {
      id: 'svelte-real-dev',
      step: 1,
      include: ['component'],
    });

    expect(answer).toContain('svelte chain, outermost first: App › CartPanel › CheckoutButton');
  });

  /*
   * The flow is not React and must not be described as one — the same guard the
   * Vue run needed.
   */
  it('does not answer a Svelte flow with "no React data"', async () => {
    const answer = await server.call('get_step_detail', {
      id: 'svelte-real-dev',
      step: 1,
      include: ['component'],
    });

    expect(answer).not.toContain('carries no React data');
  });
});

describe('SvelteKit dev, where most of the chain is SvelteKit’s own', () => {
  /*
   * The measured `__svelte_meta.parent` chain above this button is six frames
   * deep and three of them are inside `.svelte-kit/generated/root.svelte`, two
   * of those carrying `componentTag: Pyramid_0` / `Pyramid_1`. What reaches the
   * reader is the three a person wrote. This is the assertion that would go red
   * if `chain.ts`'s filter were dropped, and the failure it prevents is a flow
   * that names a build artefact regenerated on every `vite dev`.
   */
  it('drops the generated frames and the synthetic Pyramid_N tags', async () => {
    const answer = await server.call('get_step_detail', {
      id: 'sveltekit-real-dev',
      step: 1,
      include: ['component'],
    });

    expect(answer).toContain('svelte chain, outermost first: +page › CartPanel › CheckoutButton');
    expect(answer).not.toContain('Pyramid');
    expect(answer).not.toContain('.svelte-kit/generated');
  });

  /*
   * `+page` keeps its `+`. It is what the file is called on disk and in every
   * SvelteKit document, and a prettier name would be one the reader cannot grep
   * for — `componentNameFromFile` says so in as many words.
   */
  it('keeps a route file’s name as SvelteKit writes it', () => {
    const flow = onDisk('sveltekit-real-dev');
    expect(flow.svelte.components['936aee3e8e'].name).toBe('+page');
    expect(flow.svelte.components['936aee3e8e'].source).toBe('src/routes/+page.svelte');
  });

  /* `__sveltekit_dev` is the one cheap build tell Svelte offers, and it reaches disk. */
  it('records the development build SvelteKit’s own global disclosed', () => {
    expect(onDisk('sveltekit-real-dev').svelte.build).toBe('development');
  });
});

describe('a Svelte production build, where the honest answer is that there is none', () => {
  /*
   * The headline measurement of the whole run, asserted rather than described:
   * a production Svelte element has zero own properties, so the adapter resolves
   * nothing and says why. A test that skipped this would leave the common path
   * for this framework uncovered.
   */
  it('records the element as not-found rather than inventing a component', () => {
    const flow = onDisk('svelte-real-prod');

    expect(flow.svelte).toBeDefined();
    expect(flow.svelte.detected).toBe(true);
    expect(Object.keys(flow.svelte.components)).toEqual(['n_d37775ce']);
    expect(flow.svelte.components.n_d37775ce.status).toBe('not-found');
    expect(flow.svelte.components.n_d37775ce.source).toBeUndefined();
    expect(flow.svelte.components.n_d37775ce.line).toBeUndefined();
  });

  /*
   * The reason is the entire product of a production recording, so it is the one
   * thing here that must survive the round trip intact. Asserted as the whole
   * sentence rather than a fragment: a truncation that kept "Svelte strips
   * __svelte_meta" and lost the two instructions would pass a `toContain` on the
   * opening words and tell the reader nothing they can do.
   */
  it('carries the whole reason sentence to disk, not a fragment of it', () => {
    expect(onDisk('svelte-real-prod').svelte.components.n_d37775ce.detail).toBe(PROD_DETAIL);
  });

  it('prints the reason when asked for the component', async () => {
    const answer = await server.call('get_step_detail', {
      id: 'svelte-real-prod',
      step: 1,
      include: ['component'],
    });

    expect(answer).toContain('svelte: Anonymous');
    expect(answer).toContain(
      'Svelte strips __svelte_meta from production builds, so this element carries no link to the component that rendered it.',
    );
    expect(answer).toContain('Only a development build carries that link');
  });

  /*
   * Not a blank. This is the failure the reason exists to prevent, and it is
   * cheap to assert and impossible to notice by reading the output above.
   */
  it('does not answer a production Svelte flow with silence', async () => {
    const answer = await server.call('get_step_detail', {
      id: 'svelte-real-prod',
      step: 1,
      include: ['component'],
    });

    expect(answer).not.toContain('carries no React data');
    expect(answer.trim().endsWith('### component')).toBe(false);
  });
});
