/**
 * Walking the DOM the way an interaction actually reaches it.
 *
 * ## Why this is not in `core/react/`
 *
 * It was, and Wave 2 proved it should not have been. Neither of these functions
 * knows anything about React: one asks whether a node is an element, and the
 * other two answer *"what is above this element"* and *"what did the user
 * actually touch"*. Both questions are asked identically by a Vue adapter, a
 * Svelte adapter and anything else that starts from a clicked element.
 *
 * Because they lived in `fiber.ts`, and because `core/vue/` is forbidden to
 * import `core/react/` (ADR 0026, gated by `npm run lint:locate`), the Vue
 * adapter re-implemented `climb` — three lines, slightly weaker, testing
 * `nodeType === 1` inline rather than through `isElement`. That is this
 * repository's named recurring failure caught early instead of late: it has
 * grown a second markdown renderer and a second a11y renderer already, and the
 * mechanism was the same each time — the shared thing was reachable only
 * through a specialised home.
 *
 * This lives in `core/dom/` rather than `core/locate/` because it takes DOM
 * nodes as arguments, and `core/dom` is where CLAUDE.md draws that line: it is
 * not in `mcp-bundle.ts`, so nothing here reaches the Node process that has no
 * `window`.
 */

/** A node that is an element, narrowed for callers holding `unknown`. */
export function isElement(node: unknown): node is Element {
  return !!node && (node as Node).nodeType === 1;
}

/**
 * The next element up, crossing out of a shadow root when it has to.
 *
 * `parentElement` is null on the top node inside a shadow root, which would end
 * the walk one hop short of the component that rendered the host. Web components
 * wrapping an app — and an app rendering *into* a shadow root — are both real,
 * and in both cases the answer the reader wants is on the other side of the
 * boundary.
 */
export function climb(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;

  const root = node.getRootNode();
  const host = (root as ShadowRoot | null)?.host;
  return isElement(host) ? host : null;
}

/**
 * The element an interaction actually happened on.
 *
 * `event.target` is retargeted at a shadow boundary — it reports the *host*
 * rather than the node inside that was clicked — so a passive listener on
 * `document` sees the wrong element. `composedPath()[0]` is the real one. A
 * picker never meets this, because it is handed the element the user pointed
 * at; a recorder listening at the document meets it constantly.
 */
export function interactionTarget(event: Event): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const first = path[0];
  if (isElement(first)) return first;

  return isElement(event.target) ? event.target : null;
}
