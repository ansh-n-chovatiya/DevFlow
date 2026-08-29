/**
 * Line and column numbers, with their base in the type.
 *
 * ## Why this file exists
 *
 * The two extensions DevFlow merges disagreed about what a line number is.
 * react-source-locator was 0-based end to end — source maps are 0-based, and it
 * never converted. FlowSnap converts once, at the source-map edge
 * (`lookupOriginal`), so everything downstream of that edge is 1-based, which is
 * what an editor, a stack trace and a human all expect.
 *
 * Both were right inside their own repo, and the consequence was that
 * `buildEditorUrl` meant **opposite things** by `{line1}` in the two copies of
 * the file. `docs/SHARED-CORE.md` rejected the obvious fix — a `base: 0 | 1`
 * parameter — for the right reason: a call site that passes the wrong one opens
 * every file one line off, silently, forever. Nothing fails, no test goes red,
 * and the number on screen looks entirely plausible.
 *
 * So the base is not a parameter. It is a type.
 *
 * ```ts
 * const seg = lookupOriginal(map, line, col);   // → Pos0, spec-true
 * buildEditorUrl(template, { line: seg.line }); // ✗ compile error
 * buildEditorUrl(template, { line: toOneBased(seg.line) }); // ✓
 * ```
 *
 * ## The rules
 *
 * 1. **Core lookup returns `Pos0`.** A source map says 0-based, so the module
 *    that reads one says 0-based. It does not editorialise.
 * 2. **`buildEditorUrl` accepts `Pos1` only**, as does anything stored on
 *    `ComponentSource` or shown to a person.
 * 3. **`toOneBased()` is the only bridge.** There is deliberately no
 *    `toZeroBased()`: nothing in DevFlow needs to walk back across the edge, and
 *    a symmetric pair is an invitation to convert twice.
 * 4. **`pos0` / `pos1` are assertions, not conversions.** They add no arithmetic
 *    — they state what an untyped number coming in from outside already is.
 *    Every use is a place a reviewer should look, and there are only three kinds
 *    of them: decoding a source map, reading a stored `ComponentSource`, and
 *    parsing a number a person typed.
 *
 * Pure — no DOM, no Chrome, no network.
 */

declare const ZERO_BASED: unique symbol;
declare const ONE_BASED: unique symbol;

/**
 * A 0-based line or column, as source maps and the V8 stack API record them.
 *
 * The first line of a file is `0`.
 */
export type Pos0 = number & { readonly [ZERO_BASED]: true };

/**
 * A 1-based line or column, as editors, stack traces and people write them.
 *
 * The first line of a file is `1`. This is what `ComponentSource.line` holds and
 * what every `{line1}` in an editor template is filled with.
 */
export type Pos1 = number & { readonly [ONE_BASED]: true };

/**
 * Assert that a raw number is already 0-based.
 *
 * Legitimate at exactly one kind of boundary: reading a value out of a source
 * map, a `SourceMapConsumer`-shaped object, or a V8 stack frame. Negative input
 * is clamped to 0 — a malformed map should not be able to produce a position
 * that formats as `-1`.
 */
export function pos0(value: number): Pos0 {
  return (value > 0 ? Math.floor(value) : 0) as Pos0;
}

/**
 * Assert that a raw number is already 1-based.
 *
 * Legitimate when reading a stored `ComponentSource`, a `debugSource` React
 * attached (React records 1-based lines), or a number a person typed. Clamped to
 * a minimum of 1 for the same reason `pos0` clamps to 0.
 */
export function pos1(value: number): Pos1 {
  return (value > 1 ? Math.floor(value) : 1) as Pos1;
}

/** The one bridge. 0-based `n` is 1-based `n + 1`. */
export function toOneBased(value: Pos0): Pos1 {
  return (value + 1) as Pos1;
}

/** A position in a file, 0-based on both axes. What a source map hands back. */
export interface Position0 {
  line: Pos0;
  column: Pos0;
}

/** A position in a file, 1-based on both axes. What is stored, shown and linked. */
export interface Position1 {
  line: Pos1;
  column: Pos1;
}

/** Both axes across the bridge at once, so a pair cannot be half-converted. */
export function positionToOneBased(position: Position0): Position1 {
  return { line: toOneBased(position.line), column: toOneBased(position.column) };
}

/**
 * `line:column`, 1-based, for display beside a path.
 *
 * Typed to `Position1` rather than taking two numbers because the whole failure
 * this file exists to prevent is a plausible-looking wrong number on a screen.
 */
export function formatPosition(position: Position1): string {
  return `${position.line}:${position.column}`;
}
