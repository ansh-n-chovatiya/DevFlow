/**
 * Sends ARKG observations to the MCP server.
 *
 * Impure — calls `fetch` to the loopback MCP server. Lives in `features/` for
 * that reason; nothing here belongs in `core/`.
 *
 * Every function in this module is fire-and-forget. ARKG ingestion must never
 * interrupt a flow save, a component resolution, or anything the user is waiting
 * for. A failure is logged to stderr and swallowed.
 *
 * The module is read-after-write safe: the MCP server is started before
 * anything sends to it, and if it is not running the fetch fails silently.
 */

import { load as loadSettings } from '../settings/index.js';
import type { FlowPayload } from '../../shared/types.js';
import type { PickedComponent } from '../../shared/types.js';

/**
 * Ingest a complete flow into the ARKG.
 *
 * Called after a flow is successfully POSTed to `/flows`. The flow payload is
 * sent to `/arkg/ingest` on the same MCP server, using the same base URL the
 * flow was sent to. Fire-and-forget: the promise is dropped by the caller.
 *
 * The `arkg.enabled` setting gates this. When it is false, this is a no-op.
 */
export async function ingestFlowToArkg(payload: FlowPayload): Promise<void> {
  let settings;
  try {
    settings = await loadSettings();
  } catch {
    return; // Cannot load settings — skip silently.
  }

  if (settings['arkg.enabled'] === false) return;

  const base = settings.mcpServerUrl;
  if (!base) return;

  try {
    const arkgUrl = new URL('/arkg/ingest', base).toString();
    await fetch(arkgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    // Response is ignored. A non-2xx means ARKG is unavailable or errored —
    // not worth surfacing to the user for what is a best-effort background write.
  } catch {
    // Network error, timeout, or server not running — all expected and silent.
  }
}

/**
 * Ingest a single component pick into the ARKG.
 *
 * Called after the DevTools panel resolves a component via the source locator.
 * The component's id, name, and source location are the key facts; timingMs is
 * the time the resolution took (a proxy for locate performance, not render time).
 *
 * Fire-and-forget.
 */
export async function ingestComponentToArkg(
  source: PickedComponent,
  timingMs: number,
): Promise<void> {
  let settings;
  try {
    settings = await loadSettings();
  } catch {
    return;
  }

  if (settings['arkg.enabled'] === false) return;

  const base = settings.mcpServerUrl;
  if (!base) return;

  try {
    const arkgUrl = new URL('/arkg/ingest-component', base).toString();
    await fetch(arkgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: source.name,
        name: source.name,
        sourceFile: source.debugSource?.source,
        sourceLine: source.debugSource?.line,
        timingMs,
        failed: false,
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Silent.
  }
}
