/**
 * `fiber._debugInfo` — where a server component's identity actually is.
 *
 * ## Why this file, and not the wire
 *
 * The project's position was that RSC is "a protocol to read, not a runtime tree
 * to adapt". `.ctx/spike-rsc.md` §3 measured that as backwards in dev: walking
 * up from `<div id="server-only">` and dumping `_debugInfo` yields
 * `ServerOnlyWidget`, `env:"Server"`, the owner chain up to `Page`, the props it
 * was called with, and a stack frame — while the HTTP flight stream carries only
 * *references* to that identity (`32:D"$34"`), and rows `33`, `34` and `35` are
 * not on it at all. They arrive on the HMR websocket.
 *
 * So a protocol-only reader would open a second connection, speak a
 * length-prefixed binary multiplexing frame format, and arrive at a fact that is
 * already sitting on the element. This reads the element.
 *
 * ## The frame, and the one number here that is inferred rather than measured
 *
 * A frame is a fixed seven-slot tuple, measured verbatim:
 *
 * ```
 * ["ServerOnlyWidget","…/[root-of-the-server]__0f3blm3._.js",93,263,91,1,false]
 *   name              file                                    ln  col enc enc  async
 * ```
 *
 * ## Both axes are 1-based, and that was checked rather than assumed
 *
 * The Svelte adapter found `__svelte_meta` recording a **1-based line beside a
 * 0-based column in one object**, so the two axes cross into `Pos1`
 * differently there. `pos1(column)` on such a runtime compiles, passes every
 * test that does not assert the number, and is one column wrong forever. So the
 * bases here were read off the captured frames rather than carried over.
 *
 * Every frame the spike printed has an **enclosing column of exactly `1`**:
 *
 * ```
 * ["ServerOnlyWidget", "…__0f3blm3._.js", 93, 263,  91, 1, false]
 * ["Page",             "…__0f3blm3._.js", 188, 263, 187, 1, false]
 * ["Page",             "…__0f3blm3._.js", 198, 264, 187, 1, false]
 * ["RootLayout",       "…_109tciv._.js",  17, 263,  16, 1, false]
 * ```
 *
 * Those enclosing positions are top-level declarations in a compiled chunk —
 * they begin at the start of their line. A 0-based column would record that as
 * `0`. Four independent frames record `1`. So the column is 1-based, the same
 * as the line, and the axes here do **not** cross. `pos1()` on both is
 * therefore the assertion `positions.ts` licenses (React records 1-based lines,
 * as `_debugSource` did) and not a guess wearing its clothes.
 *
 * What remains genuinely inferred is only the *direction*: `generatedPositionOf`
 * subtracts one from each axis to reach the 0-based base `lookupOriginal` reads
 * in. The spike ran its round trip through node's `module.SourceMap` and printed
 * the result (`93:263 → ServerOnlyWidget.tsx:7:5`) without printing whether it
 * subtracted first. That is confined to one three-line function with a test
 * pinning both axes, rather than spread across the call sites.
 *
 * There is deliberately no `toZeroBased()` and this does not invent one: a
 * generated position is a *bundle offset*, which `sourcemap.ts` documents as a
 * plain `number` precisely so that branding does not leak to the generated side.
 *
 * ## What the file it names is
 *
 * `declared.source` here is the **compiled server chunk**, because that is what
 * the runtime recorded, and the contract says so in as many words: *"As the
 * runtime recorded it — normalisation is the caller's job."* Turning it into
 * `app/components/ServerOnlyWidget.tsx` needs `/__nextjs_source-map?filename=…`
 * fetched over HTTP, which is not this layer's to do — `resolveDeclaredThrough`
 * takes the map once somebody impure has fetched it.
 *
 * Pure — no DOM, no Chrome, no network. It imports `core/locate/` and, by the
 * unit's rule and ADR 0026's, never `core/react/`: nothing here is a fiber walk,
 * it is a reader over one untyped property that a fiber walk hands it.
 */

import type { Resolution } from '../locate/adapter.js';
import { pos1, toOneBased, type Pos1 } from '../locate/positions.js';
import { lookupOriginal, type PreparedMap } from '../locate/sourcemap.js';

/**
 * One frame of a React debug stack.
 *
 * Kept as a tuple rather than flattened into an object at the boundary so that
 * a frame whose arity is not seven can be rejected rather than read half-way —
 * the same trap as the element tuple in `flight.ts`, one layer up.
 */
export interface RscStackFrame {
  fn: string;
  file: string;
  /** 1-based, as React's stack recorder writes it. */
  line: Pos1;
  /** 1-based. */
  column: Pos1;
  isAsync: boolean;
}

/** One entry of `_debugInfo` that names a component. */
export interface RscDebugComponent {
  name: string;
  key: string | null;
  /** `"Server"` for a server component. Measured; the only value the spike saw. */
  env: string;
  /** The frames React recorded, outermost call last, as sent. */
  stack: RscStackFrame[];
  /** The owner entry, when the runtime inlined one. Untyped: it is a graph. */
  owner: unknown;
  props: unknown;
}

/** Reads one frame tuple. Null unless it has exactly the measured seven slots. */
export function readStackFrame(value: unknown): RscStackFrame | null {
  if (!Array.isArray(value) || value.length !== 7) return null;
  const [fn, file, line, column] = value as unknown[];
  const isAsync = (value as unknown[])[6];
  if (typeof file !== 'string' || typeof line !== 'number' || typeof column !== 'number') {
    return null;
  }
  return {
    fn: typeof fn === 'string' ? fn : '',
    file,
    line: pos1(line),
    column: pos1(column),
    isAsync: isAsync === true,
  };
}

/**
 * Reads one `_debugInfo` entry.
 *
 * The array is heterogeneous — measured, it interleaves `{ time: 7.06… }`
 * markers between the component records, and the `J` channel adds
 * `{ name, start, end, … }` timing records that also carry a `name`. A reader
 * that filtered on `name` alone would report `SlowServerData` twice, once as a
 * component and once as a stopwatch. `env` is what separates them.
 */
export function readDebugComponent(entry: unknown): RscDebugComponent | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;

  const name = record.name;
  const env = record.env;
  if (typeof name !== 'string' || name === '') return null;
  if (typeof env !== 'string' || env === '') return null;

  const rawStack = record.stack;
  const stack: RscStackFrame[] = [];
  if (Array.isArray(rawStack)) {
    for (const frame of rawStack) {
      const read = readStackFrame(frame);
      if (read) stack.push(read);
    }
  }

  return {
    name,
    key: typeof record.key === 'string' ? record.key : null,
    env,
    stack,
    owner: record.owner ?? null,
    props: record.props ?? null,
  };
}

/** Every component record on one fiber's `_debugInfo`, in the order recorded. */
export function readDebugInfo(debugInfo: unknown): RscDebugComponent[] {
  if (!Array.isArray(debugInfo)) return [];
  const out: RscDebugComponent[] = [];
  for (const entry of debugInfo) {
    const component = readDebugComponent(entry);
    if (component) out.push(component);
  }
  return out;
}

/** Ran on the server. The whole reason `server-rendered` is a distinct reason. */
export function isServerComponent(component: RscDebugComponent): boolean {
  return component.env === 'Server';
}

/**
 * The frame this component is attributed to — and it is the call site.
 *
 * Read the measurement carefully, because the obvious reading of it is wrong.
 * `ServerOnlyWidget`'s record on the fiber carries
 *
 * ```
 * "stack":[["Page","…/[root-of-the-server]__0f3blm3._.js",198,264,187,1,false]]
 * ```
 *
 * — the frame is named **`Page`**, and §4 resolved `188:263` and `198:264` in
 * that chunk to `app/page.tsx:11:5` and `app/page.tsx:13:7`. So this is where
 * `<ServerOnlyWidget/>` was *written in its parent*, not where the component was
 * declared. The declaration frame exists — `39:[["ServerOnlyWidget","…",93,263,…]]`,
 * which resolves to `ServerOnlyWidget.tsx:7:5` — and it is on the HMR websocket,
 * on a row the HTTP stream only references and never carries. It is not on the
 * fiber, at all, and this file will not pretend otherwise.
 *
 * That is not a defect for DevFlow, and the reason is `core/react/owner.ts`:
 * the answer this repository leads with is already the **owner's call site**,
 * because that is where a person goes to change what they clicked on. The
 * declaration is `stepEnclosing`'s kind of answer, and here it is a named gap
 * requiring the websocket rather than a number quietly filled in from the wrong
 * frame.
 *
 * The first frame rather than the last: the array is a stack, innermost first,
 * so the last frame is the root of the render and attributing everything to it
 * would name `RootLayout` for every element on the page.
 */
export function attributionFrame(component: RscDebugComponent): RscStackFrame | null {
  return component.stack[0] ?? null;
}

/**
 * The component record turned into the contract's `declared` arm.
 *
 * `absent` with `server-rendered` when there is no frame — which is a real
 * measured state, not a defect: `b:{"name":"RootLayout",…,"stack":[]}` has an
 * empty stack, and `Page`'s stack was `[["Promise.all","",0,0,0,0,true]]`, a
 * frame with no file at all. Reporting those as `declared` with an empty
 * `source` would put a blank path in front of a reader; reporting them as
 * absent-with-a-name says what is true, which is that the runtime named the
 * component and not the file.
 */
export function resolutionFor(component: RscDebugComponent): Resolution {
  const frame = attributionFrame(component);
  if (!frame || frame.file === '') {
    return {
      kind: 'absent',
      name: component.name,
      reason: 'server-rendered',
      detail:
        `${component.name} ran on the server and this build named it without a source ` +
        `frame, so there is no file to open. Its props and owner chain are still readable.`,
    };
  }

  return {
    kind: 'declared',
    name: component.name,
    source: frame.file,
    line: frame.line,
    column: frame.column,
  };
}

/**
 * The 0-based generated position `lookupOriginal` takes.
 *
 * This is the inferred subtraction named in the header. Kept as one function so
 * that if it is ever measured to be wrong, exactly one place changes and one
 * test goes red — rather than every call site having quietly done its own
 * arithmetic on a branded type, which is the failure `positions.ts` exists for.
 */
export function generatedPositionOf(frame: RscStackFrame): { line: number; column: number } {
  return { line: frame.line - 1, column: frame.column - 1 };
}

/**
 * Upgrades a compiled-chunk `declared` to the `.tsx` it was written in.
 *
 * Takes an already-prepared map rather than a URL, because fetching is impure
 * and because the map in question is an **indexed (`sections`) map** whose
 * top-level `sources` is `[]` and `mappings` is `""` — the shape a flat-only
 * reader silently reports as empty. `core/locate/sourcemap.ts` handles it, and
 * writing a second decoder to find that out again is the failure this call
 * avoids.
 *
 * Returns the input unchanged when the map has no segment covering the frame,
 * which is legitimate and common: the client components in the spike's own
 * RSC-side map resolved only to a generated `__nextjs-internal-proxy.mjs`.
 */
export function resolveDeclaredThrough(resolution: Resolution, map: PreparedMap): Resolution {
  if (resolution.kind !== 'declared' || resolution.column === undefined) return resolution;

  const frame: RscStackFrame = {
    fn: resolution.name,
    file: resolution.source,
    line: resolution.line,
    column: resolution.column,
    isAsync: false,
  };
  const generated = generatedPositionOf(frame);
  const original = lookupOriginal(map, generated.line, generated.column);
  if (!original) return resolution;

  return {
    kind: 'declared',
    name: resolution.name,
    source: original.source,
    line: toOneBased(original.line),
    column: toOneBased(original.column),
  };
}

/**
 * Where dev serves the map for a compiled chunk.
 *
 * Measured: `GET /__nextjs_source-map?filename=<uri-encoded absolute path>` →
 * 200, `application/json`, 7413 bytes. Built here rather than at the fetch site
 * so the encoding is beside the measurement that established it — the path
 * contains `[root-of-the-server]__0f3blm3._.js`, and an unencoded `[` is the
 * kind of thing that works on one server and 400s on another.
 *
 * Next's own `POST /__nextjs_original-stack-frames` is deliberately not used:
 * the spike called it and it returned `"line1": null` for every frame while
 * reporting `status: "fulfilled"`, so it is a shortcut that answers nothing and
 * does not say so.
 */
export function devSourceMapUrl(origin: string, compiledFile: string): string {
  return `${origin.replace(/\/$/, '')}/__nextjs_source-map?filename=${encodeURIComponent(compiledFile)}`;
}
