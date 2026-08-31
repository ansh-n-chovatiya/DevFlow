/**
 * Telling the local knowledge graph about a component somebody picked.
 *
 * Impure — it reaches the network — so it lives in `features/` and could not
 * live in `core/`. One POST, to the MCP server on loopback, and it is the *only*
 * thing this extension sends to the graph. A recorded flow is added by the
 * server itself, in the handler that receives it: the server already holds the
 * flow, already parsed and already checked, and a second POST carrying the same
 * megabytes back would only be a second chance for the two sides to disagree
 * about what was recorded.
 *
 * ## Why a pick is worth sending at all
 *
 * Most picks are made while reading code, not while recording. A graph fed only
 * by flows knows the components that happened to appear in a recording somebody
 * pressed **Send to Claude** on, which is a biased sample of an app — it is
 * heaviest exactly where things were already going wrong. The components a
 * developer keeps pointing at are evidence of their own.
 *
 * ## What gates it
 *
 * `mcpAutoSend`, which is off by default and is the extension's existing answer
 * to one question: may this browser talk to the local server without the user
 * pressing anything? That is precisely what a pick would be doing. Its stated
 * consequence — "every recording leaves the browser the moment you press Stop" —
 * is strictly more than what is sent here: a name, a path and a line, and no
 * screenshot, body or console line ever.
 *
 * A key of its own would be better, and belongs beside `mcpAutoSend` in
 * `features/settings/fields.ts`. It is not there because `docs/CONTRACTS.md`
 * §3.6 enumerates the settings prefixes each concept owns and is frozen, and a
 * setting that is not in that table does not exist. Riding the existing switch
 * is the conservative reading of the gap rather than a way around it: the
 * default posture stays exactly what the README promises — nothing leaves the
 * browser until somebody says so.
 *
 * ## It cannot fail anything
 *
 * Every call here is fire-and-forget and this module never throws or rejects.
 * The server not running is the ordinary case, not an error: a pick is answered
 * from the page and the panel renders it whether or not anything was recorded
 * about it. A user waiting on a crosshair must never wait on a socket.
 */

import { load as loadSettings } from '../settings/index.js';
import type { PickedComponent } from '../../shared/types.js';

/**
 * The body `POST /arkg/ingest-component` takes.
 *
 * Written out rather than passed through, because the server reads exactly
 * these three keys and derives the graph's node id from two of them. Sending a
 * `PickedComponent` whole would put a shape this module does not control on a
 * wire it does.
 */
export interface ComponentObservation {
  readonly name: string;
  readonly sourceFile?: string;
  readonly sourceLine?: number;
}

/**
 * What is worth recording about one picked component, or nothing.
 *
 * Pure, and separate from the send, because this is the half that can be wrong
 * in a way no network error would reveal: a nameless component is a node the
 * graph would key on the empty string and pile every other anonymous
 * observation onto.
 *
 * `debugSource` is React's own record of where a component was written and is
 * present on development builds only. On a production build there is nothing
 * here yet — the original file comes from the source maps, which are resolved
 * in the panel, one process further on — so the observation carries a name
 * alone. That is still worth sending: how often a component is looked at is a
 * fact about the app whether or not its file is known, and the server fills the
 * source in the first time a flow or a pick arrives carrying one.
 */
export function observationFor(component: PickedComponent): ComponentObservation | null {
  const name = component.name?.trim();
  if (!name) return null;

  const debug = component.debugSource;
  const line = debug?.line;

  return {
    name,
    ...(debug?.source ? { sourceFile: debug.source } : {}),
    ...(Number.isInteger(line) && (line as number) > 0 ? { sourceLine: line as number } : {}),
  };
}

/**
 * Send one picked component to the local graph, if the user has allowed it.
 *
 * The settings read is inside the guard rather than above it. Callers fire this
 * and walk away, so a throw from `load()` — a service worker whose storage is
 * momentarily unavailable — would surface as an unhandled rejection in the
 * worker rather than as the nothing this promises.
 */
export async function ingestComponentPick(component: PickedComponent): Promise<void> {
  const observation = observationFor(component);
  if (!observation) return;

  const abort = new AbortController();
  // Armed after the settings read, because the timeout is one of the settings,
  // and left unarmed if that read throws — see `deleteRemoteFlow`, which has
  // the same shape for the same reason.
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const settings = await loadSettings();
    if (!settings.mcpAutoSend) return;

    const url = new URL('/arkg/ingest-component', settings.mcpServerUrl);
    timer = setTimeout(() => abort.abort(), settings['mcp.remoteTimeoutMs']);

    // The reply is read and dropped. It says whether the graph stored the
    // observation, and there is nothing useful to do with either answer: no
    // user is waiting, and a write nobody is waiting on has no reason to
    // succeed on a retry it would only duplicate.
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(observation),
      signal: abort.signal,
    });
  } catch {
    // A server that is not running, an address that is not a URL, a timeout.
    // All three are the ordinary case for a best-effort background write, and
    // none of them is worth a line in the console of every pick.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
