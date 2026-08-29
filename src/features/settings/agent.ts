/**
 * The one path a setting can take into the MAIN world.
 *
 * The injected agent has no `chrome.*` at all, so nothing it reads can come from
 * storage. The content script resolves the settings on its own side of the
 * boundary and pushes this subset down the existing `CONTROL_MESSAGE_SOURCE`
 * channel — the same message that already tells the agent whether to watch for
 * interactions.
 *
 * Kept apart from the rest of `features/settings` so the content script imports
 * one small function rather than handing the agent an object shaped like the
 * whole settings table: the channel is `window.postMessage`, which means every
 * field here is readable by the page, and a field that does not need to cross
 * should not.
 */

import type { AgentConfig } from '../../shared/messages.js';
import type { RecordingSettings } from './fields.js';

/**
 * The agent-relevant subset of the settings a recording is frozen at.
 *
 * `RecordingSettings`, not `Settings`: every field here is one the agent reads
 * while capturing, so all nine are in the freeze, and taking them from the
 * live object would push a body cap into the page that the recording it is
 * capturing for was never started under.
 *
 * The three `react.*` entries are Phase 6's, and they are here rather than in the
 * content script because the fiber walk happens in the MAIN world — it is the
 * page's own React that is being read, and nothing in the isolated world can
 * see it. They are frozen for the same reason the body cap is: a chain limit
 * that moved halfway through would leave one recording carrying two different
 * answers to "how far up did you look", with nothing saying so.
 */
export function toAgentConfig(settings: RecordingSettings): AgentConfig {
  return {
    captureBodies: settings['network.captureBodies'],
    bodyCap: settings['network.bodyCap'],
    consoleLevels: settings['console.levels'],
    logArgCap: settings['console.logArgCap'],
    stackFrames: settings['console.stackFrames'],
    captureUncaught: settings['console.captureUncaught'],
    maxComponentChain: settings['react.maxComponentChain'],
    maxFiberWalk: settings['react.maxFiberWalk'],
    prewarmTtlMs: settings['react.prewarmTtlMs'],
  };
}
