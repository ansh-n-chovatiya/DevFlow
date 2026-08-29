/**
 * The only place the worker fetches from the web.
 *
 * Used to read the page's own script bundles and their source maps. Three
 * things here are load-bearing:
 *
 *   - **`cache: 'force-cache'`.** The page has just loaded these bundles, so the
 *     search normally costs no network at all. This is also why resolution runs
 *     during recording rather than after it.
 *   - **`credentials: 'omit'`.** FlowSnap is reading a file, not acting as the
 *     user. A cookie sent from the worker would be a request the user never
 *     made, to an origin they may no longer be on.
 *   - **The scheme check.** A page controls the URLs it loads. Only `http:` and
 *     `https:` are ever fetched — never `file:`, `data:`, `blob:` or
 *     `chrome-extension:`, which would be reading something the page has no
 *     business pointing us at.
 *
 * `<all_urls>` is already a required host permission, so cross-origin CDN
 * bundles need no prompt and no CORS cooperation.
 */

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
 */
export async function fetchText(url: string, maxBytes: number): Promise<Result<string>> {
  if (!isFetchableUrl(url)) {
    return err(flowError('RESOURCE_UNFETCHABLE', `refused scheme: ${url.slice(0, 40)}`));
  }

  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit', cache: 'force-cache', redirect: 'follow' });
  } catch (error) {
    return err(flowError('RESOURCE_UNFETCHABLE', error));
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
    return err(flowError('RESOURCE_UNFETCHABLE', error));
  }

  if (text.length > maxBytes) return err(flowError('RESOURCE_TOO_LARGE', `${text.length} bytes`));

  return ok(text);
}
