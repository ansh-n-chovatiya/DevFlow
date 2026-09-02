/**
 * Types for the plugin, hand-written because the plugin is hand-written JS.
 *
 * The implementation is plain ESM, the way `mcp-server/` is: it runs in a
 * consumer's Babel process, not in this repo's build, so compiling it would put
 * a build step between an edit and the thing that runs. What that costs is a
 * declaration nothing checks against the implementation — so this stays small
 * enough to read beside `index.js` in one screen.
 *
 * It refers to `@babel/core`'s own types, which is a type-only reference to the
 * peer dependency the package already requires. Describing the shapes by hand
 * instead produced a plugin TypeScript would not accept in a `plugins` array,
 * which is the one place its type is ever read.
 */

import type { PluginAPI, PluginObject } from '@babel/core';

export interface DevflowStampOptions {
  /**
   * Stamp production builds too. Off, because a stamp puts the repository's
   * directory layout into the bundle.
   */
  includeInProduction?: boolean;
  /** The directory `f` is relative to. Defaults to Babel's own `root`. */
  root?: string;
}

export default function devflowComponentStamp(
  api: PluginAPI,
  options?: DevflowStampOptions,
): PluginObject;
