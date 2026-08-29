/**
 * Keeping the two sides of the port setting in step.
 *
 * `mcp.port` is one number with two readers that cannot see each other. The MCP
 * server binds it; the extension POSTs flows to `mcpServerUrl`, which contains
 * it. A setting that moves one and not the other is worse than no setting at
 * all: the server would be listening perfectly well on a port nothing sends to,
 * and every symptom of that — sends failing, "Test connection" red, an empty
 * `list_flows` — points at the server rather than at the address.
 *
 * So changing the port has to surface both sides, and this file is the rule for
 * the side the extension owns. It is pure and it is a `Result`-shaped answer
 * rather than a silent rewrite, because two of its four outcomes are things the
 * user has to be *told*, not things to do quietly on their behalf.
 *
 * ## Why a remote address is left alone
 *
 * `mcp.port` is machine-wide: it says what the server on *this* machine binds,
 * and it reaches that server through `POST /config`. An `mcpServerUrl` pointing
 * somewhere else entirely — a colleague's box, a container, a deployment in
 * remote mode — is not that server, and rewriting its port would silently
 * redirect a send at a port nobody chose on a host this setting says nothing
 * about. The honest answer there is to change neither and say why.
 */

/** The hosts that mean "the server this setting is about". */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Whether an address names a server on this machine. */
export function isLoopback(url: string): boolean {
  const parsed = parse(url);
  return parsed !== null && LOOPBACK.has(parsed.hostname);
}

/**
 * The port an address sends to, with the scheme's own default filled in.
 *
 * `http://127.0.0.1/flows` really does send to port 80, and reporting `null`
 * for it would have the caller treat "already agrees" and "no port here" as the
 * same answer at the one moment they differ.
 */
export function portOf(url: string): number | null {
  const parsed = parse(url);
  if (!parsed) return null;
  if (parsed.port !== '') return Number(parsed.port);
  if (parsed.protocol === 'https:') return 443;
  if (parsed.protocol === 'http:') return 80;
  return null;
}

export type Alignment =
  /** The address has been moved to the new port. */
  | { readonly kind: 'moved'; readonly url: string; readonly from: number }
  /** Both sides already say the same thing. Nothing to do and nothing to say. */
  | { readonly kind: 'agreed' }
  /** The address is not this machine's server, so the port does not apply to it. */
  | { readonly kind: 'remote'; readonly host: string }
  /** The address is not a URL. `resolve()` will fall back to the default. */
  | { readonly kind: 'unusable' };

/**
 * `mcpServerUrl`, moved to `port` — or the reason it was not.
 *
 * Everything but the port is preserved, including the path: the setting points
 * at `/flows` because that is where recordings are POSTed, and a rewrite that
 * dropped it would break sending in the act of fixing the port.
 */
export function alignToPort(url: string, port: number): Alignment {
  const parsed = parse(url);
  if (!parsed) return { kind: 'unusable' };
  if (!LOOPBACK.has(parsed.hostname)) return { kind: 'remote', host: parsed.hostname };

  const from = portOf(url);
  if (from === port) return { kind: 'agreed' };

  parsed.port = String(port);
  return { kind: 'moved', url: parsed.toString(), from: from ?? 0 };
}
