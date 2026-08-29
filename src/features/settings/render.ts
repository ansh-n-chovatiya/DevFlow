/**
 * The settings that govern what a flow looks like once it has left FlowSnap.
 *
 * The MCP server's settings split in two, and this file is the first half:
 * **per-flow rendering settings travel inside the flow.** The response budget,
 * the `raw` default, the images one call returns, the body length in tool
 * output and the two walkthrough caps are all `rendered` fields, so
 * `renderedOverrides()` puts them in the stamp that `sendFlow` and `exportFlow`
 * attach to every payload — and `flow.json` on the server carries them beside
 * the steps they describe.
 *
 * Why they travel rather than being the server's own opinion: the settings
 * screen is in a browser, the renderer is a Node process on the other side of
 * an HTTP boundary, and the two have no shared storage. The flow is the only
 * thing that crosses. A recording already carries the settings it was
 * made under so a reader can tell a quiet capture from a broken one; this is
 * the same object doing the same job one step further along — a walkthrough
 * that quotes 200 characters of a response body should be able to say that it
 * was asked to.
 *
 * ## Two functions, one shape
 *
 * `renderLimits` is what the document renderer wants: `core/export/markdown.ts`
 * takes a `RenderLimits` and knows nothing about where it came from, which is
 * what keeps `core/` free of the field table. `flowRendering` is everything the
 * MCP server decides per flow, in one typed object, so the dotted key strings
 * exist once rather than scattered through `server.js` where a typo resolves to
 * `undefined` and reads as "the default".
 *
 * ## Resolved settings in, never a raw stamp
 *
 * Both take a `Settings` — the output of `resolve()` — rather than the sparse
 * `Overrides` a stamp actually is. A stamp holds only what was changed, so
 * every reader would otherwise need its own `?? THE_CONSTANT` fallback, and a
 * reader that forgot one would silently use a number nobody chose. `resolve()`
 * fills the gaps and clamps what is there, which is the rule everywhere else
 * and matters more here than anywhere: on the server the stamp arrives over an
 * unauthenticated loopback POST.
 *
 * Pure. No `chrome.*`, no DOM — it is bundled into the MCP server through
 * `core/mcp-bundle.ts`.
 */

import type { RenderLimits } from '../../core/export/markdown.js';
import type { Settings } from './fields.js';

export type { RenderLimits };

/**
 * The body rules and walkthrough caps a document is rendered under.
 *
 * The two `network.*` keys were already applied once, by the extension, on the
 * way out, so on the server they are normally the flow's own answer — see
 * `renderingFor` in `mcp-server/server.js`, which is exact about the one case
 * where a machine-wide setting overrides them. The two `mcp.*` caps are applied
 * here for the first time.
 */
export function renderLimits(settings: Settings): RenderLimits {
  return {
    threshold: settings['network.schemaThreshold'],
    summarise: settings['network.summariseBodies'],
    responseBody: settings['mcp.maxResponseBody'],
    consoleEntries: settings['mcp.maxConsoleEntries'],
  };
}

/** Everything the MCP server decides per flow. */
export interface FlowRendering {
  /** `mcp.maxTokens` — what one tool response may weigh. */
  readonly maxTokens: number;
  /** `mcp.raw` — whether the step JSON is returned without being asked for. */
  readonly raw: boolean;
  /** `mcp.maxImages` — how many screenshots one call returns inline. */
  readonly maxImages: number;
  /** `mcp.bodyLimit` — how much of a body goes into the step JSON. */
  readonly bodyLimit: number;
  /** What the walkthrough itself is rendered under. */
  readonly limits: RenderLimits;
}

export function flowRendering(settings: Settings): FlowRendering {
  return {
    maxTokens: settings['mcp.maxTokens'],
    raw: settings['mcp.raw'],
    maxImages: settings['mcp.maxImages'],
    bodyLimit: settings['mcp.bodyLimit'],
    limits: renderLimits(settings),
  };
}
