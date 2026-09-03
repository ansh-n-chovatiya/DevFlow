/**
 * Reading the build stamp `@devflow/compiler-plugin` leaves on a component.
 *
 * The plugin writes `Cart.__devflow = { f: "src/Cart.tsx", l: 12 }` — a static
 * property on the component function itself, chosen over a JSX attribute
 * because an attribute reaches the DOM and changes the user's application, and
 * over a module registry because a registry needs names to be unique and they
 * are not. DevFlow already holds the component function off the fiber
 * (`getComponentFn`), so this needs no React internals at all — which is why it
 * is the one part of source attribution that cannot rot when React moves
 * something. `_debugSource` is the counter-example: React 19 dropped it.
 *
 * ## Why this validates rather than trusts
 *
 * The property is on an object out of a page DevFlow does not control. Nothing
 * stops an application — or a script on it — from defining `__devflow` as
 * something else entirely, and there is no version marker that could
 * distinguish "our plugin wrote this" from "someone else happened to pick this
 * name". So the shape is the whole of the check: `f` a non-empty string, `l` a
 * positive integer, own property, and anything else is not a stamp. Nothing
 * here throws, including on a property whose getter does — this runs inside the
 * page agent while a chain is being captured, and a page with a strange object
 * on it is a page to record, not a recording to abandon.
 *
 * The length cap is the same reasoning one step further. A path is bounded in
 * practice by a filesystem; a string on a page object is bounded by nothing,
 * and this value travels into a stored flow and out to the MCP server. A
 * megabyte of text in a `source` field is not a path however it is spelled.
 *
 * ## The one place `pos1` is asserted here
 *
 * The plugin emits Babel's `loc.start.line`, which is 1-based, and
 * `ComponentSource.line` is 1-based. There is no conversion — `pos1` states
 * what the number already is, at the edge where an untyped number comes in from
 * outside. See the positions invariant in `CLAUDE.md`.
 *
 * Pure — no DOM, no Chrome, no network.
 */

import { pos1, type Pos1 } from '../locate/positions.js';

/** The property name. `compiler-plugin/index.js` writes it; these two agree. */
const STAMP_KEY = '__devflow';

/**
 * Longest `f` accepted.
 *
 * Generous against any real repo-relative path and small enough that a hostile
 * or broken value cannot ride into a flow. Deliberately not a setting: nothing
 * a user could tune here would make a longer string more likely to be a path.
 */
const MAX_SOURCE_LENGTH = 1024;

/** Where the build said this component was defined, or nothing. */
export interface ComponentStamp {
  source: string;
  line: Pos1;
}

/**
 * The stamp on one component function, or `null`.
 *
 * Takes `unknown` because every caller has one: a fiber's `type` is whatever the
 * page put there, and the function inside a `forwardRef` or `memo` wrapper is
 * reached through two more properties that may be anything at all.
 */
export function readStamp(fn: unknown): ComponentStamp | null {
  if (fn === null || (typeof fn !== 'object' && typeof fn !== 'function')) return null;

  let f: unknown;
  let l: unknown;
  try {
    // Own property only: a page that put `__devflow` on `Function.prototype`
    // would otherwise make every function in the app claim one file.
    if (!Object.hasOwn(fn, STAMP_KEY)) return null;

    const raw = (fn as Record<string, unknown>)[STAMP_KEY];
    if (raw === null || typeof raw !== 'object') return null;

    // Reading `f` and `l` is inside the `try` and not after it. They are two
    // more property reads on an object off somebody's page, so a getter or a
    // proxy trap can throw on either — and a throw here does not merely lose a
    // stamp. It escapes `describeEntry`, which is called from the agent's
    // interaction listener, so the step is emitted with no component chain at
    // all, silently, for the life of the page.
    ({ f, l } = raw as { f?: unknown; l?: unknown });
  } catch {
    // A throwing getter or an exotic proxy. This runs inside the page agent, on
    // somebody else's page, in the middle of capturing a chain — a throw here
    // would cost the whole step. There is no stamp; that is the whole answer.
    return null;
  }

  if (typeof f !== 'string' || f === '' || f.length > MAX_SOURCE_LENGTH) return null;
  if (typeof l !== 'number' || !Number.isInteger(l) || l < 1) return null;

  return { source: f, line: pos1(l) };
}
