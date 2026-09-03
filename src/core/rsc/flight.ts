/**
 * The React Flight wire format, read as bytes rather than as a runtime.
 *
 * ## Why a parser at all, when the fiber has the answer
 *
 * `.ctx/spike-rsc.md` §3 measured the thing that decides this file's scope: in
 * `next dev` the *fiber* carries the component identity and the HTTP flight
 * stream does not. So this is deliberately **not** the dev attribution path —
 * `debug.ts` is. What is left for a wire reader is the two jobs the fiber
 * cannot do:
 *
 *   - **Say which build this is, without walking anything.** `FrameworkAdapter.detect`
 *     is contracted to be cheap and to never walk the tree, and the payload
 *     answers it outright: a dev `I` row's module id is a *string path*, a prod
 *     `I` row's is an *integer* (§2). That is a build stamp read off three
 *     `<script>` tags.
 *   - **Say whether a given element was produced on the server.** In production
 *     nothing on the fiber distinguishes markup a server component emitted from
 *     markup a stripped client component emitted (§3: every debug field is
 *     `null`, every name is minified). The payload does: a server component's
 *     rendered element is *in* the flight rows, and a client component's is not
 *     — the client one survives only as a module reference plus its props.
 *     Without that join, `absent`/`server-rendered` would be a guess, and a
 *     guess is exactly what `AbsentReason` exists to stop being told.
 *
 * ## Read it out of the DOM, never out of `self.__next_f`
 *
 * Measured, both builds: `self.__next_f.length` is **0** by the time an
 * extension can read it, because the flight client replaces `push` and drains
 * the array. The inline `<script>` tags that called it are still in the DOM —
 * 7753 bytes across 3 tags in dev, 4584 across 3 in prod. A reader that goes to
 * the global gets an empty array and concludes, wrongly and silently, that the
 * page is not RSC at all.
 *
 * ## Concatenate, then split — in that order
 *
 * §6 timed the chunks: chunk 1 ends `…2:I[39756,` and chunk 2 begins mid-row.
 * A reader that splits each `push` fragment on its own drops the row that
 * straddles them, and the row it drops is not random — it is whichever row was
 * large, which is the shell. `joinFlightChunks` exists so that ordering is a
 * function call rather than a comment nobody reads, and `splitFlightRows`
 * returns its unterminated tail as `pending` rather than parsing it, so a
 * streaming caller can append the next chunk to it.
 *
 * ## One place the spike's prose and the spike's bytes disagree
 *
 * §1 describes the grammar as `<hex-id><optional-type-tag>:<payload>` and then
 * prints six rows, every one of which puts the tag **after** the colon. The
 * bytes are what this parses; see `ROW`.
 *
 * ## What this does not do
 *
 * It does not decode `T` rows (React's byte-length-prefixed raw text), because
 * the spike never saw one and a length prefix guessed wrong desynchronises the
 * whole rest of the stream rather than failing. Rows are split on `\n`, which is
 * correct for every row type the spike actually observed — all of them JSON,
 * where a newline is escaped — and is named here as the assumption it is.
 *
 * Pure — no DOM, no Chrome, no network, no clock. Reading the `<script>` tags
 * is the extension's; the filesystem half of production attribution is
 * `mcp-server/rsc.js`; this is only the grammar.
 */

/** One row of the stream, before its payload is interpreted. */
export interface FlightRow {
  /** Lowercase hex, as sent — `4e`, not 78. Never parsed to a number: it is a key. */
  id: string;
  /** The single-letter type tag, or `''` for an untagged JSON model row. */
  tag: string;
  /** Everything after the colon, verbatim. */
  payload: string;
}

/** What `splitFlightRows` gives back, including the part it refused to parse. */
export interface FlightSplit {
  rows: FlightRow[];
  /**
   * The trailing bytes with no newline after them.
   *
   * Not an error and usually not even a truncation — it is the ordinary state
   * of a stream mid-flight (§6: the last chunk arrived 1.5s after the rest).
   * A caller accumulating chunks prepends this to whatever comes next.
   */
  pending: string;
}

/**
 * `<hexid>:<tag><payload>` — and the tag is **after** the colon, not before it.
 *
 * The spike's prose says `<hex-id><optional-type-tag>:<payload>`, and every
 * row it actually printed contradicts it: `2:I[39756,…]`, `32:D"$34"`,
 * `74:J{"name":"SlowServerData",…}`. The bytes win over the sentence about the
 * bytes. Getting this backwards is not a parse error — it produces a row with
 * the right id, an empty tag, and `I[39756,…]` as its payload, which then fails
 * to be JSON and is silently dropped, so every `I` row disappears and the build
 * stamp reads `unknown` on every page.
 *
 * The tag is uppercase-only, which is what makes it unambiguous: an untagged row
 * is JSON, and JSON can begin with `{`, `[`, `"`, a digit, or `true`/`false`/`null`
 * — never an uppercase letter.
 *
 * Anchored, and the id is hex-only, so a line of ordinary text that happens to
 * contain a colon is not read as a row. That matters because the inline script
 * payloads are string literals a caller has unescaped, and a mis-unescape
 * should surface as "no rows" rather than as plausible rows.
 */
const ROW = /^([0-9a-f]+):([A-Z]?)([\s\S]*)$/;

/**
 * Joins the `self.__next_f.push([1, …])` fragments in document order.
 *
 * One line of code with a header, for the reason above: the ordering is the
 * whole content of the function and it is not recoverable from the call site.
 */
export function joinFlightChunks(chunks: readonly string[]): string {
  return chunks.join('');
}

/** Splits a flight stream into rows, keeping the unterminated tail out of them. */
export function splitFlightRows(text: string): FlightSplit {
  const rows: FlightRow[] = [];
  const lines = text.split('\n');
  const pending = lines.pop() ?? '';

  for (const line of lines) {
    const match = ROW.exec(line);
    if (!match) continue;
    rows.push({ id: match[1], tag: match[2], payload: match[3] });
  }

  return { rows, pending };
}

// ── References ───────────────────────────────────────────────────────────────

/**
 * A `"$…"` string, which is the format's only pointer.
 *
 * `lazy` and `back` are the same syntax with one letter between them and they
 * are *not* the same fact: §6 measured `"children":"$L7"` emitted 1.5 seconds
 * before row `7` existed, so a `lazy` that resolves to nothing is the ordinary
 * suspended case, while a `back` that resolves to nothing means a row went
 * missing — or, in dev, that the referent is on the HMR websocket and never on
 * the HTTP stream at all (§2: ids 33, 34, 35 are referenced and absent).
 */
export type FlightRef =
  | { kind: 'lazy'; id: string }
  | { kind: 'back'; id: string }
  | { kind: 'symbol'; name: string }
  | { kind: 'promise'; id: string }
  | { kind: 'undefined' }
  | { kind: 'omitted' }
  /**
   * A literal string that began with `$`, escaped by doubling.
   *
   * **Not measured.** The spike's inventory is "everything I saw", and it never
   * saw one. It is read rather than ignored because the alternative failure is
   * worse than being wrong here: an unread `"$$4"` is returned as a *reference
   * to row 4*, which resolves to a real value belonging to something else.
   * Unescaping at worst returns the string the page meant.
   */
  | { kind: 'escaped'; text: string }
  | { kind: 'unknown'; raw: string };

/** Reads a `"$…"` pointer, or null when the string is ordinary text. */
export function readReference(value: string): FlightRef | null {
  if (!value.startsWith('$')) return null;
  if (value === '$') return { kind: 'unknown', raw: value };
  if (value === '$undefined') return { kind: 'undefined' };
  if (value === '$Y') return { kind: 'omitted' };

  const rest = value.slice(1);
  if (rest.startsWith('$')) return { kind: 'escaped', text: rest };
  if (rest.startsWith('S')) return { kind: 'symbol', name: rest.slice(1) };
  if (rest.startsWith('L')) {
    const id = rest.slice(1);
    return isRowId(id) ? { kind: 'lazy', id } : { kind: 'unknown', raw: value };
  }
  if (rest.startsWith('@')) {
    const id = rest.slice(1);
    return isRowId(id) ? { kind: 'promise', id } : { kind: 'unknown', raw: value };
  }
  if (isRowId(rest)) return { kind: 'back', id: rest };
  return { kind: 'unknown', raw: value };
}

function isRowId(value: string): boolean {
  return value.length > 0 && /^[0-9a-f]+$/.test(value);
}

// ── Elements ─────────────────────────────────────────────────────────────────

/**
 * A JSX element as the wire carries it, and the arity trap that comes with it.
 *
 * Measured, §1, the same `<p>` in the two builds:
 *
 * ```
 * prod : ["$","p",null,{"children":"marker=…"}]
 * dev  : ["$","p",null,{"children":"marker=…"},"$37","$39",1]
 * ```
 *
 * Four slots against seven. The first four are positionally identical, which is
 * why this reads from the front and treats the extras as optional rather than
 * branching on the build: a parser that keys off length before reading gets to
 * be wrong about the build *and* lose the props, whereas this one is wrong
 * about nothing that is present in both.
 *
 * The three extras are `owner`, `stack`, `validated` — three, not two. The
 * roadmap's summary says two, and the count matters to anyone indexing from the
 * end of the tuple, which is why `shape` is derived from the real length rather
 * than asserted.
 */
export interface FlightElement {
  type: unknown;
  key: unknown;
  props: unknown;
  /** `prod` at four slots, `dev` at seven. Anything else is `unknown`. */
  shape: 'prod' | 'dev' | 'unknown';
  /** Present in dev only: a reference to the owning component's debug row. */
  owner?: unknown;
  /** Present in dev only: a reference to the row holding the stack frames. */
  stack?: unknown;
  /** Present in dev only: React's own "this element was validated" flag. */
  validated?: unknown;
}

/** Reads an element tuple, in either build's arity. Null when it is not one. */
export function readElement(value: unknown): FlightElement | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 4 || value[0] !== '$') return null;

  const element: FlightElement = {
    type: value[1],
    key: value[2],
    props: value[3],
    shape: value.length === 4 ? 'prod' : value.length === 7 ? 'dev' : 'unknown',
  };

  if (value.length >= 7) {
    element.owner = value[4];
    element.stack = value[5];
    element.validated = value[6];
  }

  return element;
}

// ── Client module references ─────────────────────────────────────────────────

/**
 * An `I` row: the one place a client component is named on the wire.
 *
 * `moduleId` is the measured asymmetry the whole production story turns on
 * (§2). Dev sends a path — `"[project]/app/components/ClientCounter.tsx [app-client] (ecmascript)"`
 * — and prod sends `56850`. The export name (`"default"`, `"OutletBoundary"`)
 * survives in both, which is worth having and is not a file.
 */
export interface ClientModuleRef {
  /** The row id this reference arrived on, so a `$L` can be joined back to it. */
  row: string;
  moduleId: number | string;
  chunks: string[];
  exportName: string;
  async?: boolean;
  /**
   * The source file, when the id was a path — dev only.
   *
   * Null in production is not a failure to parse; it is the finding. The
   * integer's file lives in `page_client-reference-manifest.js`, which 404s on
   * every served path the spike tried, so only `mcp-server/rsc.js` can close it.
   */
  sourceFile: string | null;
}

/**
 * Strips Turbopack's decoration off a module id.
 *
 * `[project]/app/components/ClientCounter.tsx [app-client] (ecmascript)` and the
 * bare `[project]/app/components/ClientCounter.tsx` that the on-disk manifest
 * uses as its key are the same file written two ways, and both reach a reader:
 * the first over the wire in dev, the second off the filesystem in prod. One
 * function rather than two so they cannot disagree about what a file is called.
 *
 * Returns null for an id that is not path-shaped, rather than returning the id
 * unchanged — a caller that gets a string back is entitled to treat it as a
 * path, and `56850` is not one.
 */
export function normalizeModulePath(id: unknown): string | null {
  if (typeof id !== 'string') return null;

  // ` [app-client] (ecmascript)` and its siblings — a space, then bracketed or
  // parenthesised annotations, all the way to the end.
  const undecorated = id.replace(/(?:\s+(?:\[[^\]]*\]|\([^)]*\)))+$/, '').trim();
  const withoutRoot = undecorated.startsWith('[project]/')
    ? undecorated.slice('[project]/'.length)
    : undecorated;

  if (withoutRoot === '' || !withoutRoot.includes('/')) return null;
  return withoutRoot;
}

function readClientModuleRef(row: FlightRow): ClientModuleRef | null {
  const parsed = parseJson(row.payload);
  if (!Array.isArray(parsed) || parsed.length < 3) return null;

  const moduleId: unknown = parsed[0];
  if (typeof moduleId !== 'number' && typeof moduleId !== 'string') return null;

  const chunks: unknown = parsed[1];
  const exportName: unknown = parsed[2];
  const async: unknown = parsed[3];

  return {
    row: row.id,
    moduleId,
    chunks: Array.isArray(chunks) ? chunks.filter((c): c is string => typeof c === 'string') : [],
    exportName: typeof exportName === 'string' ? exportName : '',
    ...(typeof async === 'number' || typeof async === 'boolean' ? { async: Boolean(async) } : {}),
    sourceFile: normalizeModulePath(moduleId),
  };
}

// ── The model ────────────────────────────────────────────────────────────────

/**
 * Every row, keyed by id, with the references left unfollowed.
 *
 * Accumulate-then-resolve, and §6 is why it is not optional: the stitch is by
 * row id alone, there is no envelope and no ordering guarantee, and a reference
 * is *routinely* seen before its referent — the shell in chunk 2 pointed at row
 * `7`, which arrived 1.5 seconds later. Resolving eagerly at parse time would
 * therefore be wrong on the ordinary path and not merely on a pathological one,
 * which is the same hazard `buildSpanTree` faces with leaf-first spans and
 * solves the same way: store everything, join afterwards.
 *
 * One id can carry several rows — `32:D"$34"`, `32:D"$33"`, then `32:[…]` — so
 * `rows` is a list per id and `value` reads only the untagged one.
 */
export interface FlightModel {
  rows: Map<string, FlightRow[]>;
  /** `I` rows by row id. */
  modules: Map<string, ClientModuleRef>;
  /** Ids that something referenced and no row defines. */
  unresolved: string[];
}

/** The parsed JSON of the untagged row with this id, or undefined. */
export function rowValue(model: FlightModel, id: string): unknown {
  const rows = model.rows.get(id);
  if (!rows) return undefined;
  for (const row of rows) {
    if (row.tag === '') return parseJson(row.payload);
  }
  return undefined;
}

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

/** Indexes rows and records which references have no row to point at. */
export function buildFlightModel(rows: readonly FlightRow[]): FlightModel {
  const byId = new Map<string, FlightRow[]>();
  const modules = new Map<string, ClientModuleRef>();

  for (const row of rows) {
    const existing = byId.get(row.id);
    if (existing) existing.push(row);
    else byId.set(row.id, [row]);

    if (row.tag === 'I') {
      const ref = readClientModuleRef(row);
      if (ref) modules.set(row.id, ref);
    }
  }

  const model: FlightModel = { rows: byId, modules, unresolved: [] };

  const wanted = new Set<string>();
  for (const rowList of byId.values()) {
    for (const row of rowList) collectReferences(parseJson(row.payload), wanted);
  }
  for (const id of wanted) {
    if (!byId.has(id)) model.unresolved.push(id);
  }
  model.unresolved.sort();

  return model;
}

function collectReferences(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    const ref = readReference(value);
    if (ref && (ref.kind === 'lazy' || ref.kind === 'back' || ref.kind === 'promise')) {
      into.add(ref.id);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectReferences(item, into);
  }
}

/** A reference the model cannot follow, left in place of the value. */
export interface UnresolvedRef {
  unresolved: true;
  id: string;
}

/**
 * Follows every `$L`/`$`/`$@` pointer it can, in place, depth-first.
 *
 * A pointer with no row becomes an `UnresolvedRef` rather than `undefined` or a
 * throw. Suspended content is the ordinary case, and a caller that cannot tell
 * "not here yet" from "the page rendered nothing" will draw the second.
 *
 * `seen` breaks cycles by row id. The format has no ordering guarantee and
 * therefore no acyclicity guarantee either; a mutually referencing pair would
 * otherwise be a stack overflow inside a content script.
 */
export function resolveValue(model: FlightModel, value: unknown, seen = new Set<string>()): unknown {
  if (typeof value === 'string') {
    const ref = readReference(value);
    if (!ref) return value;
    switch (ref.kind) {
      case 'lazy':
      case 'back':
      case 'promise': {
        if (seen.has(ref.id)) return { unresolved: true, id: ref.id } satisfies UnresolvedRef;
        if (!model.rows.has(ref.id)) return { unresolved: true, id: ref.id } satisfies UnresolvedRef;
        const next = new Set(seen);
        next.add(ref.id);
        return resolveValue(model, rowValue(model, ref.id), next);
      }
      case 'escaped':
        return ref.text;
      case 'undefined':
        return undefined;
      default:
        return value;
    }
  }

  if (Array.isArray(value)) return value.map((item) => resolveValue(model, item, seen));

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveValue(model, item, seen);
    return out;
  }

  return value;
}

// ── What the payload says about the build ────────────────────────────────────

/**
 * Development or production, from the payload alone.
 *
 * `FrameworkAdapter.detect` is contracted to never walk the tree, so the build
 * cannot be answered by looking for `_debugInfo` on a fiber — and it has to be
 * answered, because every other decision in this adapter forks on it.
 *
 * The measured discriminator is the `I` row's module id: a path in dev, an
 * integer in prod (§2). `D` rows are a second dev-only signal and are used as a
 * fallback, because a page whose client components are all in one already-loaded
 * chunk could in principle carry no `I` row at all.
 *
 * `unknown` rather than a default, for `AbsentReason`'s reason: guessing
 * "production" would make every dev page report its components as stripped.
 */
export function buildFromFlight(model: FlightModel): 'development' | 'production' | 'unknown' {
  for (const ref of model.modules.values()) {
    if (typeof ref.moduleId === 'string') return 'development';
    if (typeof ref.moduleId === 'number') return 'production';
  }

  for (const rowList of model.rows.values()) {
    for (const row of rowList) {
      if (row.tag === 'D' || row.tag === 'J') return 'development';
    }
  }

  return 'unknown';
}

// ── Joining an element on screen back to the payload ─────────────────────────

/** As much of a DOM element as a pure module is willing to be handed. */
export interface ElementDescriptor {
  /** Lowercase tag name — `div`, not `DIV`. */
  tag: string;
  attributes: Record<string, string>;
}

/**
 * Whether this element's markup came out of a server component.
 *
 * The measured implication, §3 and §1: a server component's rendered element is
 * *in* the flight rows — `["$","div",null,{"id":"slow-server-data",…}]` — while
 * a client component's rendered DOM is not, because the client component is on
 * the wire as a module reference and its output is produced in the browser. So
 * a hit here means server-rendered. A miss means only that: no claim.
 *
 * It refuses rather than guesses when the element carries nothing distinctive.
 * A bare `<div>` matches the first `<div>` in any payload, and the wrong answer
 * this would give is not "no idea" — it is a confident `server-rendered` on a
 * client component, which is the one lie `AbsentReason` was added to prevent.
 * `needleRejection` makes the same call for the same reason.
 */
export function flightElementFor(
  model: FlightModel,
  descriptor: ElementDescriptor,
): FlightElement | null {
  const distinguishing = distinguishingAttributes(descriptor.attributes);
  if (distinguishing.length === 0) return null;

  for (const rowList of model.rows.values()) {
    for (const row of rowList) {
      if (row.tag !== '') continue;
      const found = findElement(parseJson(row.payload), descriptor.tag, distinguishing, 0);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Attributes worth matching on.
 *
 * `id` first because it is unique by definition and because the spike's own
 * server-rendered elements carried one. `data-*` next: they are the author's
 * own words and survive to the wire as props verbatim. Everything else —
 * `class`, `style`, ARIA — is either framework-generated or repeated across a
 * page, so matching on it would manufacture the confident wrong answer above.
 */
function distinguishingAttributes(attributes: Record<string, string>): [string, string][] {
  const out: [string, string][] = [];
  const id = attributes.id;
  if (typeof id === 'string' && id !== '') out.push(['id', id]);
  for (const [name, value] of Object.entries(attributes)) {
    if (name.startsWith('data-') && value !== '') out.push([name, value]);
  }
  return out;
}

/** Depth is capped for `resolveValue`'s reason: the format guarantees no shape. */
const MAX_ELEMENT_DEPTH = 64;

function findElement(
  value: unknown,
  tag: string,
  distinguishing: readonly [string, string][],
  depth: number,
): FlightElement | null {
  if (depth > MAX_ELEMENT_DEPTH) return null;

  const element = readElement(value);
  if (element && element.type === tag && propsMatch(element.props, distinguishing)) {
    return element;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findElement(item, tag, distinguishing, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findElement(item, tag, distinguishing, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

/**
 * A DOM attribute is always a string; the prop behind it need not be.
 *
 * Measured: `{"id":"server-only","data-computed":29}` — the same element whose
 * DOM attribute reads `data-computed="29"`. So the comparison is against the
 * primitive's own text, and a prop that is an object or an array matches
 * nothing rather than stringifying to `[object Object]` and matching whatever
 * attribute happened to say that.
 */
function propsMatch(props: unknown, distinguishing: readonly [string, string][]): boolean {
  if (!props || typeof props !== 'object') return false;
  const record = props as Record<string, unknown>;

  return distinguishing.every(([name, value]) => {
    const prop = record[name];
    if (typeof prop === 'string') return prop === value;
    if (typeof prop === 'number' || typeof prop === 'boolean') return String(prop) === value;
    return false;
  });
}

/** Split, index and stamp in one call — what a caller with whole bytes wants. */
export function parseFlightPayload(text: string): {
  model: FlightModel;
  pending: string;
  build: 'development' | 'production' | 'unknown';
} {
  const { rows, pending } = splitFlightRows(text);
  const model = buildFlightModel(rows);
  return { model, pending, build: buildFromFlight(model) };
}
