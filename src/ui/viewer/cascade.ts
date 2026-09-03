/**
 * Drawing a cascade — the impure half of `core/cascade`.
 *
 * ## What is here and what is not
 *
 * Every decision about *what may be claimed* is in `core/cascade`: which
 * component hangs off which state change, on what evidence, and what the picture
 * has to say about its own limits. Nothing here re-decides any of that. What is
 * here is a DOM tree, a connector overlay and a reveal — the three things that
 * need a document and therefore could not live in `core/`.
 *
 * ## Columns in the DOM, wires in one SVG over the top
 *
 * The nodes are ordinary elements in ordinary flex columns, so they wrap, scroll,
 * take focus, read to a screen reader in causal order and inherit the product's
 * type and spacing without this file knowing any of it. Only the wires need
 * coordinates, and they are drawn into a single absolutely-positioned `<svg>`
 * sized to the stage after layout, from `getBoundingClientRect` of the two nodes
 * each one joins.
 *
 * The alternative — laying the whole graph out in SVG — means reimplementing
 * text wrapping, focus and theming inside a coordinate system, which is how a
 * diagram ends up with its own font stack and its own colours. Here a wire is
 * the only thing with an x and a y.
 *
 * Redrawn on resize and on dialog open, never on a timer. A stale wire is
 * visible, which is the good failure: nothing here can be quietly wrong.
 *
 * ## The reveal is the roadmap's "animated", and it is honest about time
 *
 * Layers appear in causal order, one after another, because the order *is* the
 * finding — a reader watching the error arrive after the request has learnt
 * something a static picture makes them work for. What it deliberately does not
 * do is imply duration: the intervals are fixed and have nothing to do with how
 * long anything took. A cascade animated at recorded speed would be a
 * stopwatch, and this is not one.
 *
 * It is skipped entirely under `prefers-reduced-motion`, and the **Replay**
 * button is what makes it a thing the reader controls rather than something
 * that happens at them.
 */

import {
  buildCascade,
  hasCascade,
  type Cascade,
  type CascadeEdge,
  type CascadeInput,
  type CascadeNode,
} from '../../core/cascade/index.js';
import type { EventRef } from '../../core/causal/index.js';
import { hydrateIcons } from '../icons.js';
import { clone, find } from './dom.js';

/** How long one layer waits before the next appears. Not a duration of anything. */
const REVEAL_STEP_MS = 260;

/*
 * Names from the generated Lucide set only — `docs/CONTRACTS.md` §5 is the
 * manifest and `tests/viewer-markup.test.ts` fails an icon that is not in it.
 * The first draft of this file invented five that do not exist, and every one
 * would have rendered as nothing at all rather than as an error.
 */
const ICON_FOR: Record<CascadeNode['kind'], string> = {
  step: 'mouse-pointer',
  // The shape of a store, which is what a state event names.
  state: 'braces',
  render: 'atom',
  // A request leaving the page, which is the direction that matters here.
  network: 'arrow-up-right',
  console: 'code',
};

interface Elements {
  dialog: HTMLDialogElement;
  subtitle: HTMLElement;
  stage: HTMLElement;
  wires: SVGSVGElement;
  layers: HTMLElement;
  notes: HTMLElement;
  replay: HTMLButtonElement;
  close: HTMLButtonElement;
}

let elements: Elements | null = null;
let drawn: Cascade | null = null;
let revealTimers: ReturnType<typeof setTimeout>[] = [];

/*
 * The columns and the wires this drawing made, held rather than looked up again.
 *
 * `render` and `drawWires` create both, and `reveal` needs both a moment later.
 * Re-querying the document for them would couple two functions in one file
 * through a CSS class name — a coupling nothing typechecks, and one
 * `tests/viewer-markup.test.ts` correctly refuses for markup it cannot see. A
 * `<path>` is pure geometry and has no business in a template, so the answer is
 * not to declare it but to stop asking the DOM for something already in hand.
 */
let columns: HTMLElement[] = [];
let wirePaths: SVGPathElement[] = [];

/** The dialog's elements, or null on a page that does not have it. */
function ready(): Elements | null {
  if (elements) return elements;
  const dialog = document.getElementById('cascade-dialog') as HTMLDialogElement | null;
  const subtitle = document.getElementById('cascade-subtitle');
  const stage = document.getElementById('cascade-stage');
  const wires = document.getElementById('cascade-wires') as SVGSVGElement | null;
  const layers = document.getElementById('cascade-layers');
  const notes = document.getElementById('cascade-notes');
  const replay = document.getElementById('cascade-replay') as HTMLButtonElement | null;
  const close = document.getElementById('cascade-close') as HTMLButtonElement | null;
  // A missing element is a page without this dialog, which is a legitimate
  // answer — the library view has no steps to explain. Null rather than a throw,
  // the shape `mountSettingsDrawer` uses for the same reason.
  if (!dialog || !subtitle || !stage || !wires || !layers || !notes || !replay || !close) return null;

  elements = { dialog, subtitle, stage, wires, layers, notes, replay, close };

  close.addEventListener('click', () => dialog.close());
  replay.addEventListener('click', () => reveal());
  dialog.addEventListener('close', () => {
    clearReveal();
    drawn = null;
    columns = [];
    wirePaths = [];
  });
  window.addEventListener('resize', () => {
    if (dialog.open && drawn) drawWires(elements!, drawn);
  });

  return elements;
}

function clearReveal(): void {
  for (const timer of revealTimers) clearTimeout(timer);
  revealTimers = [];
}

/** Whether this step is worth offering the picture for. Re-exported so the card
 *  can ask without building one. */
export { hasCascade };

/**
 * Open the cascade for one step.
 *
 * Returns false when there is nothing to draw, so the caller can say so in its
 * own words rather than opening an empty dialog — the two are different answers
 * and only the step card knows the sentence.
 */
export function openCascade(input: CascadeInput, stepNumber: number): boolean {
  const el = ready();
  if (!el) return false;

  const cascade = buildCascade(input, stepNumber);
  if (!cascade) return false;

  drawn = cascade;
  render(el, cascade);
  el.dialog.showModal();
  // After `showModal`, because a dialog that has not been shown has no layout
  // and every rectangle would be zero.
  drawWires(el, cascade);
  reveal();
  return true;
}

function render(el: Elements, cascade: Cascade): void {
  el.subtitle.textContent = `Step ${cascade.step} — ${cascade.action}`;
  el.layers.replaceChildren();
  el.notes.replaceChildren();
  columns = [];

  for (const [index, layer] of cascade.layers.entries()) {
    const column = clone('tpl-cascade-layer');
    column.dataset.layer = String(index);
    // Hidden until the reveal reaches it, by opacity and never by `hidden`:
    // taking a column out of layout would move every node the wires were
    // measured against, so the geometry has to be stable from the first frame.
    column.dataset.revealed = 'false';

    for (const node of layer) column.append(nodeEl(node));
    el.layers.append(column);
    columns.push(column);
  }

  for (const note of cascade.notes) {
    const item = clone('tpl-cascade-note');
    item.textContent = note;
    el.notes.append(item);
  }

  hydrateIcons(el.layers);
}

function nodeEl(node: CascadeNode): HTMLElement {
  const box = clone('tpl-cascade-node');
  box.dataset.kind = node.kind;
  box.dataset.ref = node.ref;
  if (node.wasted) box.dataset.wasted = 'true';
  if (node.bounded) box.dataset.bounded = 'true';

  find(box, '[data-icon]').dataset.icon = ICON_FOR[node.kind];

  const label = find(box, '.cascade__node-label');
  label.textContent = node.label;
  label.title = node.label;

  // Removed rather than emptied: a chip with no text is a visible gap, and
  // these two are mutually exclusive by construction anyway.
  const wasted = find(box, '[data-flag="wasted"]');
  if (!node.wasted) wasted.remove();
  const bounded = find(box, '[data-flag="bounded"]');
  if (!node.bounded) bounded.remove();

  const detail = find(box, '.cascade__node-detail');
  if (node.detail) detail.textContent = node.detail;
  else detail.remove();

  return box;
}

/**
 * Draw one path per edge, from the right edge of the cause to the left edge of
 * the effect.
 *
 * Coordinates are relative to the stage rather than to the viewport, so the
 * overlay stays correct while the stage scrolls. The curve is a cubic with its
 * control points pushed horizontally, which is the standard shape for a layered
 * graph and the one that keeps two wires between adjacent columns visually
 * separable.
 *
 * An edge whose endpoints are not both on screen is skipped rather than clamped:
 * a wire drawn to a node that is not there is a line pointing at nothing, and
 * `core/cascade` has already dropped edges into budget-cut nodes. This is the
 * belt to that braces.
 */
function drawWires(el: Elements, cascade: Cascade): void {
  const stage = el.stage.getBoundingClientRect();
  el.wires.setAttribute('viewBox', `0 0 ${Math.max(1, stage.width)} ${Math.max(1, stage.height)}`);
  el.wires.setAttribute('width', String(Math.max(1, stage.width)));
  el.wires.setAttribute('height', String(Math.max(1, stage.height)));
  el.wires.replaceChildren();
  wirePaths = [];

  const boxOf = (ref: EventRef): DOMRect | null => {
    const node = el.layers.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"]`);
    return node ? node.getBoundingClientRect() : null;
  };

  for (const edge of cascade.edges) {
    const from = boxOf(edge.from);
    const to = boxOf(edge.to);
    if (!from || !to) continue;

    const x1 = from.right - stage.left + el.stage.scrollLeft;
    const y1 = from.top + from.height / 2 - stage.top + el.stage.scrollTop;
    const x2 = to.left - stage.left + el.stage.scrollLeft;
    const y2 = to.top + to.height / 2 - stage.top + el.stage.scrollTop;
    const bend = Math.max(24, (x2 - x1) / 2);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`);
    path.setAttribute('class', 'cascade__wire');
    path.dataset.basis = edge.basis;
    path.dataset.confidence = edge.confidence;
    path.dataset.to = edge.to;
    // The evidence, on the wire itself. A reader hovering an arrow is asking
    // exactly this question, and an answer that lives only in a legend is an
    // answer they have to hold in their head while they look somewhere else.
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = describeEdge(edge);
    path.append(title);
    el.wires.append(path);
    wirePaths.push(path);
  }
}

/** The sentence on an arrow: what was seen, then how much it is worth. */
function describeEdge(edge: CascadeEdge): string {
  return `${edge.detail} (${edge.basis}, ${edge.confidence} confidence)`;
}

/**
 * Reveal the columns in causal order.
 *
 * Under `prefers-reduced-motion` every column is revealed at once, which is not
 * a degraded version of this — it is the same information without the timing,
 * and the timing was never data.
 */
function reveal(): void {
  clearReveal();
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (still) {
    for (const column of columns) column.dataset.revealed = 'true';
    for (const wire of wirePaths) wire.dataset.revealed = 'true';
    return;
  }

  for (const column of columns) column.dataset.revealed = 'false';
  for (const wire of wirePaths) wire.dataset.revealed = 'false';

  for (const [index, column] of columns.entries()) {
    revealTimers.push(
      setTimeout(() => {
        column.dataset.revealed = 'true';
        // A wire arrives with the column it points into, so nothing is ever
        // drawn pointing at a box that is not there yet. Matched on the refs
        // this column actually holds rather than by asking the DOM, for the
        // reason `columns` and `wirePaths` are held at all.
        const arriving = new Set(refsIn(column));
        for (const wire of wirePaths) {
          if (arriving.has(wire.dataset.to ?? '')) wire.dataset.revealed = 'true';
        }
      }, index * REVEAL_STEP_MS),
    );
  }
}

/** The node refs one column holds, read off the elements this file created. */
function refsIn(column: HTMLElement): string[] {
  return [...column.children]
    .map((child) => (child as HTMLElement).dataset?.ref)
    .filter((ref): ref is string => Boolean(ref));
}
