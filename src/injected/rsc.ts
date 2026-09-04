/**
 * The impure half of the RSC reader: the DOM, and the fibers.
 *
 * `src/core/rsc/` is a pure parser over strings — it is bundled into
 * `mcp-server/core.js` for a Node process with no `window` — so everything that
 * touches the page is here, behind `RscPort`.
 *
 * ## Two measured traps this file exists to avoid
 *
 * **The payload is not in `self.__next_f`.** It is the obvious place and it is
 * empty: hydration drains the array to length 0 in *both* `next dev` and
 * `next build`, so a port reading the global returns nothing and the adapter
 * concludes the page is not RSC. What survives is the inline `<script>` tags
 * that pushed into it, which are still in the document afterwards. That is what
 * this reads.
 *
 * **A row can straddle two pushes.** So the chunks are handed over as a list and
 * joined by the core before anything is split into rows — joining after the
 * split loses the row that spanned the boundary.
 *
 * ## Why this may import `core/react/`
 *
 * A Next.js App Router page *is* React. `core/rsc/` may not import
 * `core/react/` because it is the pure wire reader and must stay runtime-free,
 * but this file's whole job is to read React's fibers on a React page, so
 * borrowing the fiber walk is reuse rather than a violation — and writing a
 * second one would be the failure ADR 0026 exists to prevent.
 *
 * Installs nothing, patches nothing, subscribes to nothing. Every function here
 * reads and returns.
 */

import type { ElementDescriptor } from '../core/rsc/flight.js';
import type { RscFiberReading, RscPort } from '../core/rsc/adapter.js';
import { createRscAdapter } from '../core/rsc/adapter.js';
import type { FrameworkAdapter } from '../core/locate/adapter.js';
import { getDisplayName, getFiber, type Fiber } from '../core/react/fiber.js';
import { MAX_COMPONENT_CHAIN } from '../shared/constants.js';

/**
 * The pushed payload of one `self.__next_f.push([n, "…"])` call.
 *
 * The string is a JSON string literal in the source text, so it is parsed
 * rather than sliced: the payload is full of escaped quotes and newlines, and
 * slicing returns them still escaped, which the row splitter then fails to
 * recognise.
 */
const PUSH_RE = /self\.__next_f\.push\(\s*\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")/g;

/** Attributes worth matching a production row on. Ids and data-* only. */
function matchableAttributes(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const id = el.getAttribute('id');
  if (id) out.id = id;
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-')) out[attr.name] = attr.value;
  }
  return out;
}

/**
 * A host fiber is one React renders to a DOM element, and React marks that by
 * giving it a string `type` — `'div'` — where a component's is a function or an
 * object. Read off the fiber rather than off the DOM node, because an element
 * has a fiber whether or not a component is the thing that made it.
 */
function isHostFiber(fiber: Fiber): boolean {
  return typeof fiber.type === 'string';
}

/** `_debugInfo` is not on the `Fiber` interface: React attaches it in dev only. */
function debugInfoOf(fiber: Fiber): unknown {
  return (fiber as unknown as { _debugInfo?: unknown })._debugInfo;
}

function fnSourceOf(fiber: Fiber): string | null {
  const type = fiber.type;
  if (typeof type !== 'function') return null;
  try {
    return Function.prototype.toString.call(type);
  } catch {
    // A revoked proxy or an exotic callable. A missing needle is a fact the
    // contract can carry; a throw here would take the whole interaction down.
    return null;
  }
}

export function flightChunks(doc: Document = document): readonly string[] {
  const out: string[] = [];
  for (const script of Array.from(doc.querySelectorAll('script'))) {
    const text = script.textContent;
    if (!text || !text.includes('__next_f')) continue;

    PUSH_RE.lastIndex = 0;
    for (let m = PUSH_RE.exec(text); m; m = PUSH_RE.exec(text)) {
      try {
        const parsed: unknown = JSON.parse(m[1]);
        if (typeof parsed === 'string' && parsed.length > 0) out.push(parsed);
      } catch {
        // A push whose payload is not a JSON string is not ours to interpret.
      }
    }
  }
  return out;
}

export function readingsFor(el: Element): readonly RscFiberReading[] | null {
  const first = getFiber(el);
  if (!first) return null;

  const out: RscFiberReading[] = [];
  let fiber: Fiber | null = first;
  // Bounded for `collectChain`'s reason: the far end of a deep tree is `App`
  // wrapped in nine providers, which is cost without information.
  for (let hops = 0; fiber && hops < MAX_COMPONENT_CHAIN; hops += 1) {
    out.push({
      name: isHostFiber(fiber) ? null : getDisplayName(fiber),
      host: isHostFiber(fiber),
      debugInfo: debugInfoOf(fiber),
      fnSource: fnSourceOf(fiber),
    });
    fiber = fiber.return;
  }
  return out;
}

export function describe(el: Element): ElementDescriptor | null {
  const tag = el.tagName?.toLowerCase();
  if (!tag) return null;
  return { tag, attributes: matchableAttributes(el) };
}

/**
 * Next.js states its own version on `window.next`. Never inferred from
 * behaviour: a version guessed from which properties exist is a claim that goes
 * quietly wrong the first time the framework moves one.
 */
export function nextVersion(): string | null {
  try {
    const next = (window as unknown as { next?: { version?: unknown } }).next;
    return typeof next?.version === 'string' ? next.version : null;
  } catch {
    return null;
  }
}

export const rscPort: RscPort = {
  flightChunks: () => flightChunks(),
  readingsFor,
  describe,
  version: nextVersion,
};

export const rscAdapter: FrameworkAdapter = createRscAdapter(rscPort);
