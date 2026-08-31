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

/**
 * Parameter names worth *warning* about, which is a wider net than the one worth
 * masking.
 *
 * `SECRET_PARAM` is narrow on purpose, because a mask destroys information: a
 * false positive there costs somebody the value they were trying to read. A
 * warning costs a sentence, so it can afford to be drawn wider — and `state`
 * and `nonce` are the whole difference. They are CSRF machinery rather than
 * credentials and are deliberately left readable in the recording, but an OAuth
 * round trip that shows one is usually carrying a grant beside it, and somebody
 * deciding whether to hand a flow to a context window is better served by being
 * told what they are looking at than by being left to notice.
 */
const SUSPICIOUS_PARAM = /^(state|nonce)$/i;

/** Percent-decoding that survives a malformed `%`, which a recorded URL may have. */
function decodeOrRaw(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function scan(raw: string, into: string[], seen: Set<string>): void {
  if (!raw.includes('=')) return;

  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;

    const name = decodeOrRaw(part.slice(0, eq));
    if (!SECRET_PARAM.test(name) && !SUSPICIOUS_PARAM.test(name)) continue;

    // An empty parameter carries nothing, and one `redactUrl` has already dealt
    // with is the system working — neither is worth raising an alarm over.
    const value = decodeOrRaw(part.slice(eq + 1));
    if (value === '' || value === MASK) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    into.push(name);
  }
}

/**
 * The credential-looking parameters a URL is still carrying a value for.
 *
 * The counterpart to `redactUrl`, and deliberately not its inverse: this
 * reports, it does not change anything, so it is free to flag what masking
 * would be wrong to touch. Empty for a URL that is clean, unparseable, or whose
 * credentials have already been masked at capture — which is the ordinary case,
 * and is why a non-empty answer is worth putting in front of somebody.
 *
 * Names come back in the spelling and order they appear in, deduplicated
 * case-insensitively across the query and the fragment. A fragment is read only
 * when it looks like a query string, for `redactUrl`'s reason: `#access_token=…`
 * is an implicit-flow grant and `#/orders/42` is a route.
 */
export function credentialParams(url: string): readonly string[] {
  if (typeof url !== 'string' || !url) return [];

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  const found: string[] = [];
  const seen = new Set<string>();
  if (parsed.search) scan(parsed.search.slice(1), found, seen);
  if (parsed.hash) scan(parsed.hash.slice(1), found, seen);
  return found;
}
