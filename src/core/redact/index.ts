/**
 * Credentials that travel in a URL rather than in a header.
 *
 * Request headers are redacted where they are captured, and a password field's
 * value is masked before it becomes a step — but a URL was written down exactly
 * as it appeared. An OAuth round trip puts the whole grant in one: the callback
 * arrives as `?code=4/0AY0e-…`, and an implicit-flow app puts the access token
 * in the fragment. Both were stored, exported to Markdown and JSON, packed into
 * the ZIP and POSTed to the MCP server, where they are read into a context
 * window.
 *
 * Only the *value* is replaced, never the parameter, and never the path. A URL
 * is most of what identifies a step, and one that had its query stripped would
 * be unreadable as a record of where the user was. `…/callback?code=[redacted]`
 * still says exactly what happened.
 */

/**
 * Parameter names whose value is a credential.
 *
 * Matched whole and case-insensitively against the parameter name, plus a few
 * suffix forms (`x_token`, `client_secret`) that are too common to miss.
 * Deliberately not here: `state` and `nonce`, which are CSRF machinery rather
 * than credentials and are often the thing being debugged; and `id`, which
 * matches half the query strings ever written.
 */
const SECRET_PARAM =
  /^(code|access_token|id_token|refresh_token|token|auth|authorization|api_key|apikey|key|secret|password|passwd|pwd|session|sessionid|sid|sig|signature|credential|assertion)$|_(token|secret|key|password|signature)$/i;

/** What replaces a credential, chosen to be obvious in a step description. */
const MASK = '[redacted]';

/**
 * Mask the credential-bearing parameters of a query or fragment string.
 *
 * Returns `null` when nothing needed masking, so a caller can keep the original
 * string byte for byte rather than paying for a re-serialisation that may not
 * round-trip exactly.
 */
function maskParams(raw: string): string | null {
  if (!raw.includes('=')) return null;

  let masked = false;
  // Split by hand rather than via `URLSearchParams`, whose re-serialisation
  // re-encodes separators and would rewrite URLs that had nothing to hide.
  const parts = raw.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return part;

    const name = part.slice(0, eq);
    if (!SECRET_PARAM.test(decodeURIComponent(name))) return part;

    masked = true;
    return `${name}=${MASK}`;
  });

  return masked ? parts.join('&') : null;
}

/**
 * A URL safe to write into a recording.
 *
 * Anything unparseable is returned untouched: this is a redactor, not a
 * validator, and a URL it cannot read is one it cannot find a credential in
 * either. Fragments are treated as a query string only when they look like one
 * — an implicit-flow token lands in `#access_token=…`, while a single-page
 * app's route is `#/orders/42` and must survive intact, now that route changes
 * are recorded as their own steps.
 */
export function redactUrl(url: string): string {
  if (typeof url !== 'string' || !url) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const query = parsed.search ? maskParams(parsed.search.slice(1)) : null;
  const hash = parsed.hash ? maskParams(parsed.hash.slice(1)) : null;
  if (query === null && hash === null) return url;

  const rebuiltQuery = query === null ? parsed.search : `?${query}`;
  const rebuiltHash = hash === null ? parsed.hash : `#${hash}`;
  return `${parsed.origin}${parsed.pathname}${rebuiltQuery}${rebuiltHash}`;
}
