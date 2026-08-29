/**
 * FlowSnap must not record itself.
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
const fetchWrapper = read('src/chrome/fetch.ts');

describe('the resolver and the page never share a fetch', () => {
  it('the agent is the only thing that patches fetch, and it patches the page', () => {
    expect(agent).toMatch(/window\.fetch = async function patchedFetch/);
    // If this ever appears in the worker, the patch and the resolver are in one
    // context and every resolution lands in the recording.
    expect(resolver).not.toContain('window.fetch');
    expect(fetchWrapper).not.toContain('window.fetch');
  });

  it('the agent cannot reach the resolver or the fetch wrapper', () => {
    // A MAIN-world script has no `chrome.*` anyway, but an import would bundle
    // the resolver into the page, where its fetches would be patched ones.
    expect(agent).not.toMatch(/from '.*chrome\/fetch/);
    expect(agent).not.toMatch(/from '.*features\/react\/resolver/);
  });

  it('the resolver reaches the network through the wrapper and nothing else', () => {
    expect(resolver).toContain("from '../../chrome/fetch.js'");
    // Every call goes through `deps.fetchText`, so a test can supply its own and
    // the worker can supply the wrapper. A bare `fetch(` here would bypass both
    // the scheme check and the size cap.
    expect(resolver).not.toMatch(/[^.\w]fetch\(/);
  });

  it('the wrapper refuses everything but http and https', () => {
    expect(fetchWrapper).toContain("const FETCHABLE_SCHEMES = ['http:', 'https:']");
    expect(fetchWrapper).toContain("credentials: 'omit'");
  });
});
