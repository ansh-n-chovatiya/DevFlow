/**
 * Writes to the MCP server that are not a send.
 *
 * Its own module rather than part of `send.ts`, because `store.ts` has to call
 * this and `send.ts` imports `store.ts` — putting it there would close a cycle
 * between storage and the network layer.
 */

import { load as loadSettings } from '../settings/index.js';
import type { Overrides } from '../settings/fields.js';
import { REMOTE_TIMEOUT_MS as TIMEOUT_MS } from '../../shared/constants.js';
import { flowError } from '../../shared/errors.js';
import { err, ok, type Result } from '../../shared/result.js';

/**
 * Tell the MCP server to forget a flow, if it ever had it.
 *
 * Deleting in the extension used to clear `chrome.storage` and stop there, so a
 * recording the user deleted — perhaps *because* they saw it had captured a
 * session token in a response body — stayed in `~/.flowsnap/flows` and was
 * handed to Claude by the next `list_flows`. The row disappeared and the
 * extension reported success, which is the worst version of not deleting
 * something.
 *
 * Best effort by design: the server is usually not running, and a delete that
 * failed because nothing was listening must not stop the local delete. The
 * result says what happened so the caller can mention it rather than guess.
 */
export async function deleteRemoteFlow(id: string): Promise<Result<void>> {
  const abort = new AbortController();
  // Armed after the settings read rather than before it, now that the timeout
  // is one of the settings — and left unarmed if that read throws, which the
  // catch below turns into the failed `Result` this promises.
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    // Inside the guard, not before it. Callers fire this and walk away, so a
    // throw from here would surface as an unhandled rejection rather than as
    // the failed `Result` this promises to return.
    const settings = await loadSettings();
    const base = settings.mcpServerUrl;
    timer = setTimeout(() => abort.abort(), settings['mcp.remoteTimeoutMs']);

    const path = new URL(base).pathname.replace(/\/$/, '');
    const url = new URL(`${path}/${encodeURIComponent(id)}`, base);
    const response = await fetch(url, { method: 'DELETE', signal: abort.signal });
    return response.ok ? ok(undefined) : err(flowError('MCP_UNREACHABLE', `HTTP ${response.status}`));
  } catch (error) {
    return err(flowError('MCP_UNREACHABLE', error instanceof Error ? error.message : error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── The machine-wide settings channel ────────────────────────────────────────

/** What the server says it did with a `POST /config`. */
export interface ConfigReply {
  /** The file it wrote, so the row can name a path the user can open. */
  readonly file: string;
  /** The machine-wide keys it now holds, sparse. */
  readonly applied: Overrides;
  /** The machine-wide values actually in force, resolved and clamped by the server. */
  readonly effective: Record<string, unknown>;
  /** Keys in the body that are not machine-wide, and were therefore not stored. */
  readonly ignored: readonly string[];
  /** Keys the server stored and will not use, because its environment names them too. */
  readonly overridden: readonly { readonly key: string; readonly by?: string; readonly using: unknown }[];
  /** Set when a value cannot take effect until the process restarts — the port. */
  readonly restart: string | null;
}

/** `POST /config` on the origin the flows URL names — see `health.ts`. */
export function configUrl(flowsUrl: string): string | null {
  try {
    return new URL('/config', flowsUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Hand this machine's settings to the server that is running now.
 *
 * The second channel. The response budget travels inside a flow because it
 * describes one document; the port and the retention caps describe the
 * *installation*, so they cannot travel in a recording — a flow from another
 * profile, or from last month, has no business saying how much disk this
 * machine keeps. This is the only path they have.
 *
 * Deliberately called from one place — an explicit act on the Settings screen —
 * and never from the send path. Two reasons, and the second is the one that
 * decided it. A push that rode along with every send would overwrite a
 * `config.json` somebody had edited by hand, every time they sent a flow,
 * silently. And the failure this endpoint actually has — the server not running
 * at the moment the setting changes — is one the user has to *see*, because the
 * fix is theirs: start the server and press the button again. A background
 * retry would hide it and leave the value undelivered for as long as the server
 * stayed down.
 *
 * The body is the sparse machine-wide half of the override object, and it is
 * the *whole* of that half: a key absent from it is a key the user has reset,
 * and the server drops it from the file rather than keeping what it was sent
 * last.
 */
export async function pushMachineConfig(
  flowsUrl: string,
  config: Overrides,
  /** `mcp.remoteTimeoutMs`, from the caller's resolved settings. */
  timeoutMs = TIMEOUT_MS,
): Promise<Result<ConfigReply>> {
  const url = configUrl(flowsUrl);
  if (!url) return err(flowError('MCP_UNREACHABLE', `not a URL: ${flowsUrl}`));

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      signal: abort.signal,
    });

    // The server explains its refusals in the body — a remote-mode server says
    // machine settings come from the environment there, and a body over the cap
    // says so too. Passing the status alone would turn all of that into "413".
    const body = (await response.json().catch(() => null)) as Partial<ConfigReply> & {
      error?: string;
    } | null;

    if (!response.ok) {
      return err(
        flowError('MCP_UNREACHABLE', body?.error ?? `HTTP ${response.status}`),
      );
    }

    return ok({
      file: body?.file ?? '~/.flowsnap/config.json',
      applied: body?.applied ?? {},
      effective: body?.effective ?? {},
      ignored: body?.ignored ?? [],
      overridden: body?.overridden ?? [],
      restart: body?.restart ?? null,
    });
  } catch (error) {
    return err(flowError('MCP_UNREACHABLE', error instanceof Error ? error.message : error));
  } finally {
    clearTimeout(timer);
  }
}
