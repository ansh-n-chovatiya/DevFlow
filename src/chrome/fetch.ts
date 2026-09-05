/**
 * The only place DevFlow fetches from the web.
 *
 * Used to read the page's own script bundles and their source maps, by both
 * `BundleProvider` implementations: the worker's, which has no other way to get
 * a bundle, and the DevTools panel's, for the resources the DevTools cache has a
 * record of but no body for. The panel used to route this through the service
 * worker, because react-source-locator asked for `<all_urls>` at runtime through
 * `optional_host_permissions` and only the background held the grant. DevFlow
 * holds `<all_urls>` statically — a superset — so the round trip, its message
 * type and its permission prompt are all gone.
 *
 * Four things here are load-bearing:
 *
 *   - **`cache: 'force-cache'`.** The page has just loaded these bundles, so the
 *     search normally costs no network at all. This is also why resolution runs
 *     during recording rather than after it.
 *   - **`credentials: 'omit'`.** DevFlow is reading a file, not acting as the
 *     user. A cookie sent from the worker would be a request the user never
 *     made, to an origin they may no longer be on.
 *   - **The scheme check.** A page controls the URLs it loads. Only `http:` and
 *     `https:` are ever fetched — never `file:`, `data:`, `blob:` or
 *     `chrome-extension:`, which would be reading something the page has no
 *     business pointing us at.
 *   - **The timeout.** For the reason the scheme check exists: the page chose
 *     the host, and `fetch` waits on a silent one forever. A server that
 *     accepts the connection and then never answers used to stop the resolve
 *     pass dead — no error, no user-visible end state, and in the worker an
 *     unabandoned request that keeps the worker alive for as long as Chrome
 *     allows. `RESOURCE_TIMEOUT_MS` spans the body as well as the headers,
 *     because a response that stalls halfway through 3 MB of bundle hangs just
 *     as completely as one that never starts.
 *
 * `<all_urls>` is already a required host permission, so cross-origin CDN
 * bundles need no prompt and no CORS cooperation.
 */

import { RESOURCE_TIMEOUT_MS } from '../shared/constants.js';
import { flowError } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';

const FETCHABLE_SCHEMES = ['http:', 'https:'];

/** Is this a URL the worker is willing to read at all? */
export function isFetchableUrl(url: string): boolean {
  try {
    return FETCHABLE_SCHEMES.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Reads a URL as text, refusing anything over `maxBytes`.
 *
 * The declared length is checked before the body is read, so an oversized
 * bundle costs a header round trip rather than 40 MB of worker heap — but it is
 * checked again afterwards, because `Content-Length` is absent on every chunked
 * response and a server is free to lie about it.
 *
 * One `AbortController` covers both awaits and the timer is cleared on every
 * exit, including the ones that return early. A per-await timer would leave the
 * body unguarded between them, and a timer left running past a return fires at
 * an `AbortController` nobody is listening to any more — harmless, but it is
 * the shape of a leak and there is no reason to write it.
 */
export async function fetchText(url: string, maxBytes: number): Promise<Result<string>> {
  if (!isFetchableUrl(url)) {
    return err(flowError('RESOURCE_UNFETCHABLE', `refused scheme: ${url.slice(0, 40)}`));
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RESOURCE_TIMEOUT_MS);

  // A timeout is `RESOURCE_UNFETCHABLE` like every other way a fetch fails —
  // the caller loses one component's source file and says so in its `detail`,
  // and a code of its own would be a second thing for every call site to
  // handle to reach the same conclusion. The detail is what tells them apart.
  const unfetchable = (error: unknown): Result<string> =>
    err(
      flowError(
        'RESOURCE_UNFETCHABLE',
        abort.signal.aborted ? `no answer after ${RESOURCE_TIMEOUT_MS}ms` : error,
      ),
    );

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        credentials: 'omit',
        cache: 'force-cache',
        redirect: 'follow',
        signal: abort.signal,
      });
    } catch (error) {
      return unfetchable(error);
    }

    if (!response.ok) return err(flowError('RESOURCE_UNFETCHABLE', `HTTP ${response.status}`));

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return err(flowError('RESOURCE_TOO_LARGE', `${declared} bytes`));
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return unfetchable(error);
    }

    if (text.length > maxBytes) return err(flowError('RESOURCE_TOO_LARGE', `${text.length} bytes`));

    return ok(text);
  } finally {
    clearTimeout(timer);
  }
}
