/**
 * Finding a component's compiled position inside a bundle.
 *
 * The one bundle search, and it is handed text rather than fetching any. That is
 * D4: `src/core/` is bundled into `mcp-server/core.js` for a Node process with
 * no `chrome` object, so a `fetch` or a `chrome.*` in here fails
 * `npm run build:mcp` — the purity rule is CI-enforced, not a convention. The
 * copy that listed the page's resources and loaded them itself is replaced by
 * `BundleProvider`, which is also what owns the concurrency, size and cache
 * budgets those loads have to respect. What is left is a function over a string,
 * which is also what makes it testable with no browser at all.
 *
 * Needle building lives in `needle.ts`, because it runs in the page on the click
 * path while this runs in the worker, or in the panel, some time afterwards.
 *
 * Positions are `Pos0`: a position in a served bundle, which is what
 * `ComponentSource.compiled` carries and what DevTools' own Sources API takes.
 * Nothing here ever crosses to a 1-based number — see `positions.ts`.
 *
 * Pure — no DOM, no Chrome, no network.
 */

import { MAX_MATCHES_TRACKED } from '../../shared/constants.js';
import type { Needle } from './needle.js';
import { pos0, type Pos0, type Position0 } from './positions.js';

/**
 * Converts a character offset into a line/column pair.
 *
 * 0-based on both axes, and branded so: this is a position in generated code,
 * and the only two things that ever read one are a source map lookup and
 * DevTools' Sources panel, both of which are 0-based too. The conversion to
 * something a person reads happens once, much later, on the *original* position
 * this one is mapped to.
 */
export function offsetToLineColumn(content: string, offset: number): Position0 {
  let line = 0;
  let lineStart = 0;

  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }

  return { line: pos0(line), column: pos0(offset - lineStart) };
}

/** Counts occurrences of `text`, stopping at `cap` so huge bundles stay cheap. */
export function countOccurrences(content: string, text: string, cap = MAX_MATCHES_TRACKED): number {
  if (text.length === 0) return 0;

  let count = 0;
  let from = 0;

  while (count < cap) {
    const at = content.indexOf(text, from);
    if (at === -1) break;
    count++;
    from = at + text.length;
  }

  return count;
}

export interface BundleHit {
  /**
   * Position of the function's start in the bundle text — or, when a body-needle
   * hit could not be walked back to one, of the hit itself. Either way it is a
   * position *inside* the component's compiled code, which is the property the
   * source map lookup depends on. See `searchBundle`.
   */
  line: Pos0;
  column: Pos0;
  /** Distinct occurrences in this bundle, capped at `MAX_MATCHES_TRACKED`. */
  matchCount: number;
  /** The needle that hit, so later bundles can be checked for the same text. */
  needleText: string;
}

/**
 * How much further back than `bodyOffset` the enclosing function may start.
 *
 * A rename is the whole reason the body needle exists, and a rename changes the
 * prefix length in either direction — `function ProductDetailPanel(` becomes
 * `function n(`, but a bundler that hoists can also make it longer. This bounds
 * how far the scan below will look for it, so that a bundle with no function
 * keyword anywhere near the hit falls back rather than reaching into whatever
 * module happens to sit before this one.
 */
const START_SCAN_SLACK = 64;

/** Tokens that open a function: the keyword, and the arrow of an arrow function. */
const START_TOKENS = ['function', '=>'];

/**
 * The start of the function containing `at`, or null when it cannot be found.
 *
 * Scans backwards for the nearest token that opens a function. Nearest rather
 * than furthest: a token closer to the hit is more certainly inside the same
 * module, and the failure this guards against is landing *before* the module the
 * hit is in.
 */
function functionStartBefore(content: string, at: number, lookBack: number): number | null {
  const from = Math.max(0, at - lookBack);
  // The window runs a little past the hit, because a short `bodyOffset` can put
  // the hit *inside* the keyword — the body needle starts wherever it starts.
  // Anything beginning after the hit is body, not head, so `limit` drops it.
  const window = content.slice(from, at + 'function'.length);
  const limit = at - from;

  let best = -1;
  for (const token of START_TOKENS) {
    let found = window.lastIndexOf(token);
    while (found > limit) found = window.lastIndexOf(token, found - 1);
    if (found > best) best = found;
  }

  return best === -1 ? null : from + best;
}

/**
 * Looks for one component in one bundle.
 *
 * The head needle is tried first: it is the most specific, and a hit on it puts
 * the position exactly at the function's start.
 *
 * The body needle is the fallback for a bundler that renamed the function, and
 * the reported position for it cannot be `at - bodyOffset`. That subtraction
 * assumes the bundle's copy of the function has the same prefix length as the
 * source `toString()` returned — which is exactly what a rename changes, and the
 * body needle is only ever reached *because* of a rename. Shortening
 * `function Cart(` to `function n(` moves the reported position four characters
 * before the function starts, and four characters before a minified module
 * starts is the end of the previous one: the source map then answered
 * truthfully about a position that belongs to a different file, and the flow
 * named `src/Helper.ts` for a click in `src/Cart.tsx`, `status: 'resolved'` and
 * no caveat.
 *
 * So the start is *found* rather than computed, by scanning back from the hit
 * for the token that opens the function. When there is none within reach — a
 * class or object method, which has neither — the hit itself is reported. That
 * is a position in the middle of the component rather than at its head, which
 * costs a few lines of precision and keeps the file right.
 */
export function searchBundle(content: string, needle: Needle): BundleHit | null {
  const head = content.indexOf(needle.head);
  if (head !== -1) {
    const { line, column } = offsetToLineColumn(content, head);
    return {
      line,
      column,
      matchCount: countOccurrences(content, needle.head),
      needleText: needle.head,
    };
  }

  if (needle.body === undefined || needle.bodyOffset === undefined) return null;

  const at = content.indexOf(needle.body);
  if (at === -1) return null;

  const start = functionStartBefore(content, at, needle.bodyOffset + START_SCAN_SLACK) ?? at;
  const { line, column } = offsetToLineColumn(content, start);

  return {
    line,
    column,
    matchCount: countOccurrences(content, needle.body),
    needleText: needle.body,
  };
}
