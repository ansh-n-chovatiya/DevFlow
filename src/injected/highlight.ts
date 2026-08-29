/**
 * Highlighting a component the user is pointing at from *outside* the page.
 *
 * Ported from react-source-locator `src/injected/highlight.ts` @ 6eb7a30.
 *
 * Hovering a row in the parent-tree or siblings list draws the same box the
 * picker draws over the page, so the user can see where that component actually
 * sits and how much of the page it covers — including the components that render
 * no visible box of their own but wrap a large region, which is most of what a
 * parent tree contains.
 *
 * The picker draws for itself, per animation frame, from the pointer. This draws
 * for someone else, and stays up until it is told otherwise — which is the whole
 * difference between the two files and the reason for the viewport tracking
 * below.
 */

import { pickedEntry, getAllDOMNodes, type PickedEntry } from './picker.js';
import type { TreeGroup } from '../shared/types.js';
import { hideOverlay, drawOverlay, type OffscreenDirection } from './overlay.js';

export interface HighlightOutcome {
  /** False when the component renders nothing currently in the document. */
  found: boolean;
  /** Which way the component lies when it is scrolled out of view. */
  direction: OffscreenDirection;
}

/**
 * The component's host nodes, as they are *now*.
 *
 * A pick and the highlight that follows it are separated by however long the
 * user spent reading the result, and a live app re-renders in between. The nodes
 * captured at pick time are therefore checked for still being in the document,
 * and the fiber — which survives a re-render, where its host nodes may not — is
 * what finds the replacements. Upstream kept only the nodes and drew nothing at
 * all once a re-render had swapped them.
 */
function nodesFor(entry: PickedEntry): Element[] {
  const live = entry.nodes.filter((node) => node?.isConnected);
  if (live.length > 0) return live;

  const refound = getAllDOMNodes(entry.fiber).filter((node) => node.isConnected);
  // Cached back, so a component that re-renders on every frame does not pay for
  // a fresh subtree walk on every frame of the highlight that is tracking it.
  entry.nodes = refound;
  return refound;
}

// ── Viewport tracking ────────────────────────────────────────────────────────
//
// The overlay is positioned in viewport coordinates (`position: fixed`), so a
// box drawn once goes stale the moment anything scrolls — it stays put while the
// content it marks slides away. While a highlight is up we therefore follow the
// target: scroll is captured so nested scroll containers count too, not just the
// document, and resize covers layout changes.
//
// Like the picker's listeners, none of this is attached until something is
// actually being highlighted.

let active: PickedEntry | null = null;
let frame = 0;
let tracking = false;

/**
 * Catches movement that fires no scroll event at all — a lazy image loading
 * above the target, an accordion opening, a font swapping in. Without this the
 * box only re-syncs once the user happens to scroll.
 */
const resizeObserver =
  typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => onViewportChange());

function repaint(): void {
  frame = 0;
  if (!active) return;

  const nodes = nodesFor(active);
  if (nodes.length === 0) {
    // The component unmounted while highlighted.
    stopTracking();
    hideOverlay();
    return;
  }

  drawOverlay(nodes, active.name);
}

const onViewportChange = (): void => {
  if (frame) return;
  frame = requestAnimationFrame(repaint);
};

function startTracking(nodes: Element[]): void {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver.observe(document.documentElement);
    for (const node of nodes) resizeObserver.observe(node);
  }

  if (tracking) return;
  tracking = true;
  // Capture phase: scroll does not bubble, so a listener on window would miss
  // every scrollable panel, drawer and carousel inside the page.
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
}

function stopTracking(): void {
  resizeObserver?.disconnect();

  if (!tracking) return;
  tracking = false;
  active = null;
  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  window.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
}

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Draws and tracks the box for one component of the last pick.
 *
 * `found: false` is an ordinary outcome, not an error: the pick is minutes old
 * by now and the component may have unmounted, or the tree index may belong to a
 * pick that a newer one replaced. It is what `HIGHLIGHT_COMPONENT` answers `ok`
 * from, so the surface asking can grey the row rather than pretend it drew
 * something.
 */
export function highlight(group: TreeGroup, index: number): HighlightOutcome {
  const entry = pickedEntry(group, index);
  const nodes = entry ? nodesFor(entry) : [];

  if (!entry || nodes.length === 0) {
    stopTracking();
    hideOverlay();
    return { found: false, direction: 'none' };
  }

  active = entry;
  startTracking(nodes);

  return { found: true, direction: drawOverlay(nodes, entry.name) };
}

/** Clears the highlight and stops following the page. */
export function hide(): void {
  stopTracking();
  hideOverlay();
}
