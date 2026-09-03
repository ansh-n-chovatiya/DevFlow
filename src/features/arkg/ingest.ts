/**
 * Telling the local knowledge graph about a component somebody picked.
 *
 * Impure — it reaches the network — so it lives in `features/` and could not
 * live in `core/`. Two POSTs, both to the MCP server on loopback, and between
 * them they are the *only* thing this extension sends the server outside a
 * recording: a component somebody picked, and — since Work Stream 3.3 — one
 * reading of what is mounted on a page. A recorded flow is not among them. It is
 * added by the server itself, in the handler that receives it: the server
 * already holds the flow, already parsed and already checked, and a second POST
 * carrying the same megabytes back would only be a second chance for the two
 * sides to disagree about what was recorded.
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
import type { ArchitectureSnapshot } from '../../core/architecture/index.js';
import type { PickedComponent } from '../../shared/types.js';

/**
 * The body `POST /arkg/ingest-component` takes.
 *
 * Written out rather than passed through, because the server reads exactly
 * these three keys. Sending a `PickedComponent` whole would put a shape this
 * module does not control on a wire it does.
 *
 * No id, and that is the interesting omission. This extension has one — a hash
 * of the component's compiled function source, minted in the MAIN world by
 * `core/locate/id.ts` — and it is exactly what the graph keys a *flow's*
 * components by, so sending it would look like the way to make a pick and a
 * recording agree. It is not available here: the panel resolves a pick from a
 * fiber it reads across a devtools boundary, and the compiled source the hash
 * is taken over never crosses it. So the server joins on the name and the path
 * instead — see `mcp-server/arkg.js`, which is where that join lives, because
 * it is the only side that can see both halves of the evidence at once.
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

  // A build stamp says the same thing `debugSource` does and says it about the
  // component's own file rather than its parent's, so it goes first here for the
  // reason it goes first everywhere else. Read as a pair — taking the name from
  // one and the line from the other would file a real line under a file it is
  // not in.
  const located = component.stamp ?? component.debugSource;
  const line = located?.line;

  return {
    name,
    ...(located?.source ? { sourceFile: located.source } : {}),
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

/**
 * Send one reading of a page's mounted tree to the local server — Work Stream
 * 3.3, the Living Architecture Map.
 *
 * ## Why this rides the same switch, and the same fire-and-forget shape
 *
 * `mcpAutoSend`, for `ingestComponentPick`'s reason and with more room to spare:
 * the question that switch answers is *may this browser talk to the local server
 * without the user pressing anything*, and that is exactly what this does. What
 * it sends is strictly less than a pick's neighbour in one respect that matters
 * — a reading carries **no value from the page**. No prop, no hook, no store
 * contents; component names, their source paths when the page knows them, and
 * which contexts they read. The shape has nowhere for a value to sit, which is
 * the version of that promise a later caller cannot loosen by passing a bigger
 * budget. See the header of `core/architecture`.
 *
 * ## It cannot fail anything, and reports whether it worked anyway
 *
 * Never throws, never rejects — a developer taking a reading must not wait on a
 * socket. But unlike `ingestComponentPick` it *returns* what happened, because
 * this one has a surface waiting: somebody pressed a button and is owed a
 * sentence. A server that is not running is the ordinary case rather than an
 * error, and the sentence for it has to say so, or a user will go and debug a
 * page that read perfectly well.
 */
export async function ingestArchitecture(
  snapshot: ArchitectureSnapshot,
): Promise<{ sent: boolean; error?: string }> {
  const abort = new AbortController();
  // Armed after the settings read, because the timeout is one of the settings —
  // the shape `ingestComponentPick` and `deleteRemoteFlow` both have.
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const settings = await loadSettings();
    if (!settings.mcpAutoSend) {
      return {
        sent: false,
        error:
          'Not sent: “Send recordings to Claude automatically” is off, which is also the switch that lets this browser talk to the local server without being asked. Turn it on in Settings → Claude, or read the map here.',
      };
    }

    const url = new URL('/architecture', settings.mcpServerUrl);
    timer = setTimeout(() => abort.abort(), settings['mcp.remoteTimeoutMs']);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
      signal: abort.signal,
    });

    if (!response.ok) {
      return { sent: false, error: `The local server answered ${response.status}.` };
    }
    return { sent: true };
  } catch {
    /*
     * One sentence for three causes — a server that is not running, an address
     * that is not a URL, a timeout — because the reader's next move is the same
     * for all three and naming which would mean distinguishing them, which
     * `fetch` does not let this side do reliably.
     */
    return {
      sent: false,
      error:
        'The local DevFlow MCP server did not answer. It is started by Claude Code; the map above was still read from the page.',
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
