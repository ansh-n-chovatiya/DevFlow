/**
 * Is the MCP server actually there?
 *
 * Auto-send ships whole flows — screenshots and captured request bodies — to
 * whatever address is configured, so being able to check that address before
 * trusting it is part of making that opt-in meaningful.
 */

import { HEALTH_TIMEOUT_MS as TIMEOUT_MS } from '../../shared/constants.js';
import { flowError } from '../../shared/errors.js';
import { err, ok, type Result } from '../../shared/result.js';

/**
 * The health endpoint for a configured flows URL.
 *
 * The setting points at `/flows` because that is where recordings are POSTed;
 * the server answers `GET /health` on the same origin. Pure — see tests.
 */
export function healthUrl(flowsUrl: string): string | null {
  try {
    return new URL('/health', flowsUrl).toString();
  } catch {
    return null;
  }
}

export interface McpHealth {
  service: string;
  mode: string;
}

export async function checkMcp(
  flowsUrl: string,
  /**
   * `mcp.healthTimeoutMs`, passed in by the Settings screen, which has the
   * resolved settings in hand. Defaulted rather than read here so this module
   * stays free of storage — it is driven directly by its own tests, and a read
   * at import would be the compiled-in default whatever the user had chosen.
   */
  timeoutMs = TIMEOUT_MS,
): Promise<Result<McpHealth>> {
  const url = healthUrl(flowsUrl);
  if (!url) return err(flowError('MCP_UNREACHABLE', `not a URL: ${flowsUrl}`));

  // A server that accepts the connection and then never answers would otherwise
  // leave "Checking…" on screen forever.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) return err(flowError('MCP_UNREACHABLE', `HTTP ${response.status}`));

    const body = (await response.json()) as Partial<McpHealth>;
    return ok({ service: body.service ?? 'unknown', mode: body.mode ?? 'unknown' });
  } catch (error) {
    return err(flowError('MCP_UNREACHABLE', error instanceof Error ? error.message : error));
  } finally {
    clearTimeout(timer);
  }
}
