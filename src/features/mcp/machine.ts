/**
 * Delivering the machine-wide settings, and keeping the port's two sides level.
 *
 * The second channel, as one operation, because it is two writes that must
 * happen in one order and a caller that got the order wrong would produce
 * exactly the failure the port setting exists to prevent.
 *
 * The order: **tell the server first, then move the address.** The server that
 * has to hear about a new port is the one currently answering on the *old* one,
 * so a push sent after the address moved would go to a port nothing is
 * listening on yet, and `config.json` would never be written — leaving the
 * extension pointing at a port the server will never bind.
 *
 * Two callers, and both are a user act rather than a background sweep: the
 * Settings screen, when one of the three changes or its button is pressed, and
 * the service worker, when a settings file that was parked during a recording
 * is finally applied. `pushMachineConfig` says why there is no third.
 */

import { alignToPort, type Alignment } from './port.js';
import { pushMachineConfig, type ConfigReply } from './remote.js';
import {
  load,
  loadOverrides,
  machineOverrides,
  save,
  type Settings,
} from '../settings/index.js';
import type { Result } from '../../shared/result.js';

export interface MachineDelivery {
  /** The address the settings were sent to — the one held *before* any move. */
  readonly address: string;
  readonly push: Result<ConfigReply>;
  /** What the port setting meant for the address. */
  readonly alignment: Alignment;
  /** Whether a moved address actually reached storage. */
  readonly saved: boolean;
}

export async function deliverMachineSettings(
  settings?: Settings,
): Promise<MachineDelivery> {
  const resolved = settings ?? (await load());
  const address = resolved.mcpServerUrl;

  // The overrides, not the resolved settings: `config.json` holds only what the
  // user set, and a key at its default belongs out of it — its absence is what
  // tells the server to drop it.
  const push = await pushMachineConfig(
    address,
    machineOverrides(await loadOverrides()),
    resolved['mcp.remoteTimeoutMs'],
  );

  const alignment = alignToPort(address, resolved['mcp.port']);
  if (alignment.kind !== 'moved') return { address, push, alignment, saved: false };

  const written = await save({ mcpServerUrl: alignment.url });
  return { address, push, alignment, saved: written.ok };
}
