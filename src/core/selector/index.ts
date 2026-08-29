/**
 * Selector generation.
 *
 * Pure functions over a DOM element — no `chrome.*`, no module-level state — so
 * they can be exercised in jsdom rather than by clicking around a real page.
 */

/** Classes that represent transient UI state rather than stable identity. */
const STATE_CLASS_RE = /^(active|hover|focus|selected|disabled|visible|hidden)$/;

/** Framework-generated ids, which change on every render. */
const GENERATED_ID_RE = /radix|:r[0-9a-z]*:|_r_/i;

/**
 * Where to ask "does anything else answer to this?".
 *
 * `getRootNode()` rather than the document, so an element inside a shadow root
 * is checked against its own tree — the document cannot see into it, and would
 * report every shadow selector as matching nothing.
 */
function scopeOf(el: Element): ParentNode {
  const root = el.getRootNode();
  // Document (9), DocumentFragment/ShadowRoot (11) and Element (a detached
  // subtree's top node) all answer `querySelectorAll`; anything else cannot.
  return root.nodeType === 9 || root.nodeType === 11 || root.nodeType === 1
    ? (root as ParentNode)
    : el.ownerDocument;
}

/**
 * Whether a candidate selector resolves to this element and nothing else.
 *
 * Nothing verified uniqueness before, and a selector that matches several
 * elements is not a weaker hook — it is a wrong one. A table where every row's
 * button carries `data-testid="row-delete"` recorded row 7's click as
 * `button[data-testid="row-delete"]`, which resolves to row 1: replay, and any
 * AI reading the flow, then acts on a different row than the user did. A form
 * rendered both in-page and in a modal duplicates ids the same way.
 */
function matchesOnly(el: Element, selector: string): boolean {
  // A detached element cannot be looked up — `querySelectorAll` on its own
  // subtree never returns it — and refusing every candidate for one would throw
  // away good hooks over a question that was never asked about the page.
  if (!el.isConnected) return true;

  try {
    const found = scopeOf(el).querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    // An id or attribute value `CSS.escape` produced something the parser still
    // refuses. Unusable, so it is not a candidate.
    return false;
  }
}

/**
 * The `#id` selector for an element, when the id is worth anchoring on.
 *
 * Two ways an id is not. A framework-generated one — `id=":r3:"` on a Radix
 * dialog, `_r_` on React 19 — is a new string on the next mount, so the
 * selector matches nothing the moment anything re-renders; `GENERATED_ID_RE`
 * was already written for exactly these, but only `isStableSelector` consulted
 * it, and that is display-only. A duplicated one points at whichever copy comes
 * first in the document, which is not the one that was clicked.
 */
function anchorId(el: Element): string | null {
  const id = el.id;
  if (!id || GENERATED_ID_RE.test(id)) return null;
  const selector = `#${CSS.escape(id)}`;
  return matchesOnly(el, selector) ? selector : null;
}

/**
 * Build a selector for an element, preferring the most robust hook available:
 * id > data-testid > aria-label > full CSS path.
 *
 * Every candidate above the path has to resolve to this element and nothing
 * else; one that does not is not recorded as a near-miss, it is skipped, and
 * the path — which disambiguates every level by position — is what remains.
 */
export function generateSelector(el: Element | null): string {
  if (!el || el.nodeType !== 1) return '';

  const id = anchorId(el);
  if (id) return id;

  const tag = el.tagName.toLowerCase();

  const testId = el.getAttribute('data-testid');
  if (testId) {
    const candidate = `${tag}[data-testid="${CSS.escape(testId)}"]`;
    if (matchesOnly(el, candidate)) return candidate;
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const candidate = `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
    if (matchesOnly(el, candidate)) return candidate;
  }

  return buildCSSPath(el);
}

/**
 * Walk up to `<body>` building a descendant path. An ancestor id short-circuits
 * the walk — a unique, author-written id is a good enough anchor, and stopping
 * there keeps the selector short enough to stay readable. An id that is
 * generated or repeated anchors nothing: the walk carries on past it and the
 * positional segments do the work instead.
 */
export function buildCSSPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;

  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'body') {
    const anchor = anchorId(node);
    if (anchor) {
      parts.unshift(anchor);
      break;
    }

    let segment = node.tagName.toLowerCase();

    // Filter out state classes and cap at 2 stable classes.
    const classes = Array.from(node.classList)
      .filter((cls) => !STATE_CLASS_RE.test(cls))
      .slice(0, 2);
    for (const cls of classes) segment += `.${CSS.escape(cls)}`;

    // Disambiguate with nth-of-type when there are multiple same-tag siblings.
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((sib) => sib.tagName === node!.tagName);
      if (sameTag.length > 1) segment += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }

    parts.unshift(segment);
    node = node.parentElement;
  }

  return parts.join(' > ');
}

/** Build a positional XPath from the document root to the element. */
export function generateXPath(el: Element | null): string {
  if (!el || el.nodeType !== 1) return '';

  const parts: string[] = [];
  let node: Node | null = el;

  while (node && node.nodeType === 1) {
    const current = node as Element;
    let index = 1;
    let sibling = current.previousSibling;
    while (sibling) {
      if (sibling.nodeType === 1 && (sibling as Element).tagName === current.tagName) index++;
      sibling = sibling.previousSibling;
    }

    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);

    node = current.parentNode;
    if (!node || node.nodeType !== 1) break;
  }

  return `/${parts.join('/')}`;
}

/**
 * Whether a selector is worth showing to a human or an AI: a short, stable hook
 * that maps to source code. Long ancestor chains and framework-generated ids are
 * hundreds of tokens of noise per step, and belong only in the replay JSON.
 */
export function isStableSelector(selector: string | null | undefined): boolean {
  if (!selector || selector.length > 60) return false;
  if (GENERATED_ID_RE.test(selector)) return false;
  if (selector.includes(' ')) return false; // descendant chain → brittle
  return (
    selector.startsWith('#') ||
    selector.includes('[data-testid') ||
    selector.includes('[aria-label')
  );
}
