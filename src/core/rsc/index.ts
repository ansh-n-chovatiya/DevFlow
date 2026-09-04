/**
 * React Server Components, as much of them as a browser can be told.
 *
 * Three files, and the split between them is forced by measurement rather than
 * taste (`.ctx/spike-rsc.md`):
 *
 *   `debug.ts`   the **dev** path. `fiber._debugInfo` names every server
 *                component, its owner chain, its props and a frame that resolves
 *                through the served map to `app/page.tsx:13:7` — the call site,
 *                which is the answer `core/react/owner.ts` already leads with.
 *                This is the richest route and it never touches the wire.
 *   `flight.ts`  the wire, used for the two things the fiber cannot say: which
 *                build this is, without walking the tree, and whether a given
 *                element's markup came off the server.
 *   `adapter.ts` the `FrameworkAdapter`, which forks on the build and refuses to
 *                invent a production answer that does not exist.
 *
 * The fourth piece is not here and cannot be: in production the only route from
 * a wire fact to a source file is a build artefact on the filesystem
 * (`.next/server/**`), which the extension cannot reach and the MCP server can.
 * That half is `mcp-server/rsc.js`.
 *
 * Nothing in here imports `core/react/`. The RSC reader is not a fiber walk —
 * it is a reader over data a fiber walk hands it — and an import saying
 * otherwise is how the second copy of the locate engine gets written (ADR 0026).
 */

export {
  buildFlightModel,
  buildFromFlight,
  flightClientModuleFor,
  flightElementFor,
  joinFlightChunks,
  normalizeModulePath,
  parseFlightPayload,
  readElement,
  readReference,
  resolveValue,
  rowValue,
  splitFlightRows,
} from './flight.js';
export type {
  ClientModuleRef,
  ElementDescriptor,
  FlightElement,
  FlightModel,
  FlightRef,
  FlightRow,
  FlightSplit,
  UnresolvedRef,
} from './flight.js';

export {
  attributionFrame,
  devSourceMapUrl,
  generatedPositionOf,
  isServerComponent,
  readDebugComponent,
  readDebugInfo,
  readStackFrame,
  resolutionFor,
  resolveDeclaredThrough,
} from './debug.js';
export type { RscDebugComponent, RscStackFrame } from './debug.js';

export { createRscAdapter } from './adapter.js';
export type { RscFiberReading, RscPort } from './adapter.js';
