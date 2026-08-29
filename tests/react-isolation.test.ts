/**
 * DevFlow must not record itself.
 *
 * The recorder observes network by patching `fetch` and `XMLHttpRequest` in the
 * page's own JS context. The resolver fetches the page's bundles and source maps
 * — potentially dozens of requests per flow. If those two ever met, every
 * recording of a React app would carry a pile of requests the user never made,
 * handed to an AI as evidence of what the app did.
 *
 * They cannot meet, because the patch lives in the MAIN world and the resolver
 * lives in the service worker, which has its own global `fetch`. That is a
 * structural guarantee rather than a behavioural one, so this is a structural
 * test: it asserts the boundary the guarantee rests on is still where it was.
 * The behavioural half — recording a React app and confirming no bundle fetch
 * appears in the flow — is in the manual matrix, because it needs a browser.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

const agent = read('src/injected/agent.ts');
const resolver = read('src/features/react/resolver.ts');
const provider = read('src/features/react/providers/worker.ts');
const fetchWrapper = read('src/chrome/fetch.ts');

describe('the resolver and the page never share a fetch', () => {
  it('the agent is the only thing that patches fetch, and it patches the page', () => {
    // Two halves of one assertion since the patch moved behind the agent's
    // double-injection guard: the replacement exists, and it is installed. It
    // used to be a single `window.fetch = async function patchedFetch` — a
    // statement at module scope, which is exactly what the guard exists to stop
    // being unconditional. Installing twice would wrap `fetch` in two agents and
    // report every request on the step twice.
    expect(agent).toMatch(/async function patchedFetch\(/);
    expect(agent).toMatch(/window\.fetch = patchedFetch;/);
    // If this ever appears in the worker, the patch and the resolver are in one
    // context and every resolution lands in the recording.
    expect(resolver).not.toContain('window.fetch');
    expect(fetchWrapper).not.toContain('window.fetch');
  });

  /*
   * The picker's half of the agent is on the same side of the boundary, and it
   * fetches nothing at all: it reads fibers, calls `toString()` and draws a box.
   * Every byte the locate path pulls off the network is pulled by the worker,
   * through `BundleProvider`. If a fetch ever appeared in these three files it
   * would be a patched one, and a locate would show up in the recording as
   * requests the user never made.
   */
  it('the picker fetches nothing, so a locate cannot land in a flow', () => {
    for (const file of ['picker.ts', 'overlay.ts', 'highlight.ts']) {
      const source = read(`src/injected/${file}`);
      expect(source).not.toMatch(/[^.\w]fetch\(/);
      expect(source).not.toContain('XMLHttpRequest');
    }
  });

  it('the agent cannot reach the resolver or the fetch wrapper', () => {
    // A MAIN-world script has no `chrome.*` anyway, but an import would bundle
    // the resolver into the page, where its fetches would be patched ones.
    expect(agent).not.toMatch(/from '.*chrome\/fetch/);
    expect(agent).not.toMatch(/from '.*features\/react\/resolver/);
  });

  it('the resolver reaches the network through the wrapper and nothing else', () => {
    /*
     * The invariant is unchanged; the wrapper moved one hop.
     *
     * The resolver no longer fetches at all — it asks a `BundleProvider`, and
     * `WorkerProvider` is what holds the import. So the assertion follows it
     * there, and the resolver gets the stronger claim: not "it fetches through
     * the wrapper" but "it does not fetch". Both files keep the bare-`fetch(`
     * check, because a bare call in either would bypass the scheme check and the
     * size cap exactly as before.
     */
    expect(provider).toContain("from '../../../chrome/fetch.js'");
    expect(provider).not.toMatch(/[^.\w]fetch\(/);

    expect(resolver).not.toContain("from '../../chrome/fetch.js'");
    expect(resolver).not.toMatch(/[^.\w]fetch\(/);
  });

  it('the wrapper refuses everything but http and https', () => {
    expect(fetchWrapper).toContain("const FETCHABLE_SCHEMES = ['http:', 'https:']");
    expect(fetchWrapper).toContain("credentials: 'omit'");
  });
});
