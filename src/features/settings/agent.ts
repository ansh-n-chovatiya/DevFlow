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

import { parseOrigins } from '../../core/trace/index.js';
import type { AgentConfig } from '../../shared/messages.js';
import type { RecordingSettings } from './fields.js';

/**
 * The agent-relevant subset of the settings a recording is frozen at.
 *
 * `RecordingSettings`, not `Settings`: every field here is one the agent reads
 * while capturing, so every one of them is in the freeze, and taking them from
 * the live object would push a body cap into the page that the recording it is
 * capturing for was never started under.
 *
 * The seven `recording.state*` entries are the state sampler's, and they cross
 * for the same reason the `react.*` ones do: the stores are read off the page's
 * own fibers, in the page's own realm, and nothing in the isolated world can
 * see them. The eighth — `recording.statePatchOps` — deliberately does not
 * cross. It budgets the *diff*, which is computed on the isolated side out of
 * the two snapshots the agent sends back, and a field that does not need to
 * cross should not: this channel is `window.postMessage`, and the page can read
 * every value on it.
 *
 * The two `recording.render*` entries follow the same split for the same
 * reason: `recording.renders` and `recording.renderNodeCap` govern a walk of
 * the page's own fibers and must cross, while `renderMaxComponents` and
 * `renderMaxChanges` budget the evaluation `core/render` does on this side of
 * the boundary and stay here.
 *
 * The three `react.*` entries are Phase 6's, and they are here rather than in the
 * content script because the fiber walk happens in the MAIN world — it is the
 * page's own React that is being read, and nothing in the isolated world can
 * see it. They are frozen for the same reason the body cap is: a chain limit
 * that moved halfway through would leave one recording carrying two different
 * answers to "how far up did you look", with nothing saying so.
 *
 * `trace` is the one member that does not narrow what is written down. It
 * decides whether the page's own requests leave carrying a header they would
 * not otherwise have carried, and it crosses for the plainest reason in this
 * file: `fetch` and `XMLHttpRequest` belong to the page, so the only code that
 * can add a header to one runs in the page's realm.
 *
 * It crosses as a policy object rather than as three loose fields because the
 * rule that reads it is one pure function (`decideTrace` in `core/trace`) whose
 * input is exactly this shape — a shape nobody can half-apply, which for a
 * setting whose failure mode is somebody's application breaking is worth more
 * than the flatness the rest of this object has. And it is in the freeze with
 * everything else here, which is what makes a recording able to say that its
 * requests carried a header: a switch flipped mid-flow would leave half a flow
 * traced and nothing at all saying which half.
 *
 * `network.traceOrigins` is parsed on this side, by `core/trace`'s own parser,
 * so the agent is handed origins rather than a string it would have to agree
 * with us about how to split. One parser, in `core/`, is the point — a second
 * one in the page is a second answer to "is this the same origin", and the two
 * would disagree the first time somebody typed a trailing comma.
 */
export function toAgentConfig(settings: RecordingSettings): AgentConfig {
  return {
    trace: {
      devflow: settings['network.traceHeader'],
      traceparent: settings['network.traceparent'],
      allowedOrigins: parseOrigins(settings['network.traceOrigins']),
    },
    captureBodies: settings['network.captureBodies'],
    bodyCap: settings['network.bodyCap'],
    consoleLevels: settings['console.levels'],
    logArgCap: settings['console.logArgCap'],
    stackFrames: settings['console.stackFrames'],
    captureUncaught: settings['console.captureUncaught'],
    maxComponentChain: settings['react.maxComponentChain'],
    maxFiberWalk: settings['react.maxFiberWalk'],
    prewarmTtlMs: settings['react.prewarmTtlMs'],
    vueMaxVNodeWalk: settings['vue.maxVNodeWalk'],
    captureState: settings['recording.state'],
    stateSettleMs: settings['recording.stateSettleMs'],
    stateMaxDepth: settings['recording.stateMaxDepth'],
    stateMaxKeys: settings['recording.stateMaxKeys'],
    stateMaxEntries: settings['recording.stateMaxEntries'],
    stateStringCap: settings['recording.stateStringCap'],
    stateMaxStores: settings['recording.stateMaxStores'],
    captureRenders: settings['recording.renders'],
    renderNodeCap: settings['recording.renderNodeCap'],
    captureA11y: settings['recording.a11y'],
    a11yNodeCap: settings['recording.a11yNodeCap'],
  };
}
