/**
 * The selection box and component label drawn over the page during a pick.
 *
 * Ported from react-source-locator `src/injected/overlay.ts` @ 6eb7a30.
 *
 * Shared by the picker (the user hovering the page) and the highlighter (the
 * user hovering a row in the panel's component tree), so both look and behave
 * identically — one component, one box, wherever the pointer happens to be.
 *
 * The geometry half — `placeLabel`, `offscreenDirection`, `unionBox` — is pure
 * and has no `document` in it, which is what lets `tests/overlay.test.ts` cover
 * the label-visibility guarantee without a DOM at all. Keep it that way: nothing
 * about fibers, React or the picker belongs in this file.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Where the target sits relative to the viewport, when it is not inside it. */
export type OffscreenDirection = 'none' | 'up' | 'down' | 'left' | 'right';

export interface LabelPlacement {
  left: number;
  top: number;
  direction: OffscreenDirection;
}

/**
 * Arrows, not icons.
 *
 * Every other glyph in DevFlow comes from the icon manifest (CONTRACTS §5), and
 * this is the one surface that cannot: the label is a single text node drawn
 * into someone else's document by a script with no access to the extension's
 * sprite, its fonts or its stylesheet. An arrow character costs nothing, renders
 * in every font, and says the one thing the label has to say when the component
 * is off screen — which way it lies.
 */
export const ARROWS: Record<OffscreenDirection, string> = {
  none: '',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

const MARGIN = 4;
const GAP = 6;

/**
 * Positions the label for a target box.
 *
 * The label is *always* placed inside the viewport, even when the target is
 * scrolled entirely out of view — otherwise hovering a tree row for an
 * off-screen component would highlight something the user cannot see and give
 * them no clue which component it was. When the target is outside the viewport
 * the label sticks to the nearest edge and `direction` says which way it lies.
 */
export function placeLabel(
  target: Box,
  label: Size,
  viewport: Size,
  margin = MARGIN,
): LabelPlacement {
  const direction = offscreenDirection(target, viewport);

  // Prefer directly above the target, flipping below when there is no room.
  let top = target.top - label.height - GAP;
  if (top < margin) top = target.bottom + GAP;

  let left = target.left;

  // Clamping is what guarantees visibility; it also handles the off-screen case,
  // where the target's own coordinates are far outside the viewport.
  left = clamp(left, margin, Math.max(margin, viewport.width - label.width - margin));
  top = clamp(top, margin, Math.max(margin, viewport.height - label.height - margin));

  return { left, top, direction };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Which way an entirely-invisible target lies. Vertical wins, since pages scroll that way. */
export function offscreenDirection(target: Box, viewport: Size): OffscreenDirection {
  if (target.bottom <= 0) return 'up';
  if (target.top >= viewport.height) return 'down';
  if (target.right <= 0) return 'left';
  if (target.left >= viewport.width) return 'right';
  return 'none';
}

/** Smallest box containing every rect, so a fragment component highlights as one region. */
export function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const b of boxes) {
    if (b.width === 0 && b.height === 0) continue; // display:none contributes nothing
    left = Math.min(left, b.left);
    top = Math.min(top, b.top);
    right = Math.max(right, b.right);
    bottom = Math.max(bottom, b.bottom);
  }

  if (left === Infinity) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// ── DOM ──────────────────────────────────────────────────────────────────────

/*
 * Element ids, `devflow-` prefixed like `INDICATOR_ID`.
 *
 * Not in `shared/constants.ts` beside it, because nothing outside this file has
 * ever needed to name them: the indicator's id is there because the content
 * script creates the element and `withIndicatorHidden` looks it up, whereas
 * these two elements are created, found and removed entirely within these
 * hundred lines. A constant that only one file reads is a constant in the wrong
 * place.
 *
 * Upstream's carried the other product's storage prefix, which is on the banned
 * list (CONTRACTS §4.5) and which Wave 3 greps the tree for.
 */
const BOX_ID = 'devflow-pick-box';
const LABEL_ID = 'devflow-pick-label';

/*
 * The overlay's palette, written as literals here rather than taken from
 * `tokens.css` — the one place in DevFlow where that is the right answer, for
 * the same reason `public/content.css` is exempt from `lint:tokens`.
 *
 * This box is drawn by the MAIN-world agent into a document the extension does
 * not own. `tokens.css` is linked by extension pages only, so `var(--accent)`
 * resolves to nothing here; and `content.css`, which *is* injected into the
 * page, cannot be used either, because the whole styling strategy below is
 * `all:initial` plus an inline `cssText` — the only combination a hostile or
 * merely enthusiastic page stylesheet cannot reach into.
 *
 * The values are the **light** accent, deliberately, and they do not follow the
 * page's theme or the user's — exactly the rule the recording indicator states
 * for itself. The overlay has to read on a white site and a black one alike, and
 * of the two accents the light one (#0e7c70, a deep teal) is the one that holds
 * contrast against both; the dark accent (#2bb3a3) all but vanishes on white.
 * `tokens.css` remains the authority for the values — these are copies of
 * `--accent` and `--on-accent`, and should move when those do.
 *
 * Google's blue (#1a73e8) came across from upstream and does not survive: an
 * overlay in another product's accent is the same tell as another product's
 * icon set.
 */
const ACCENT = '#0e7c70';
const ACCENT_WASH = 'rgb(14 124 112 / 12%)';
const ON_ACCENT = '#ffffff';
const LABEL_SHADOW = 'rgb(0 0 0 / 30%)';

/*
 * `all:initial` first, so no page stylesheet can reach in and restyle the
 * overlay; the declarations after it re-establish everything we rely on.
 */
const BOX_STYLE = [
  'all:initial',
  'position:fixed',
  'z-index:2147483646',
  'pointer-events:none',
  'box-sizing:border-box',
  `outline:2px solid ${ACCENT}`,
  `background:${ACCENT_WASH}`,
  'border-radius:2px',
  'display:none',
].join(';');

/*
 * The monospace stack has no `IBM Plex Mono` in front of it, unlike `--font-mono`
 * in `tokens.css`. The vendored face is only served to extension pages — the
 * page's own document never links `fonts.css` — so naming it here would resolve
 * to nothing and fall through to the same system stack, one silent step later.
 */
const LABEL_STYLE = [
  'all:initial',
  'position:fixed',
  'z-index:2147483647',
  'pointer-events:none',
  'box-sizing:border-box',
  'display:none',
  'max-width:60vw',
  'overflow:hidden',
  'text-overflow:ellipsis',
  'white-space:nowrap',
  `background:${ACCENT}`,
  `color:${ON_ACCENT}`,
  'padding:2px 8px',
  'border-radius:3px',
  `box-shadow:0 1px 4px ${LABEL_SHADOW}`,
  'font:600 11px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
].join(';');

let boxEl: HTMLElement | null = null;
let labelEl: HTMLElement | null = null;

/**
 * Creates the overlay elements, adopting any left over from an earlier pick.
 *
 * `isConnected` rather than a null check: a single-page app that replaces
 * `document.documentElement`'s children — or a framework that clears the body on
 * a route change — leaves the module holding a live object that is no longer in
 * the document, and drawing into it paints nothing at all.
 */
function ensureElements(): { box: HTMLElement; label: HTMLElement } {
  if (!boxEl?.isConnected) {
    boxEl = document.getElementById(BOX_ID) ?? document.createElement('div');
    boxEl.id = BOX_ID;
    boxEl.style.cssText = BOX_STYLE;
    document.documentElement.append(boxEl);
  }
  if (!labelEl?.isConnected) {
    labelEl = document.getElementById(LABEL_ID) ?? document.createElement('div');
    labelEl.id = LABEL_ID;
    labelEl.style.cssText = LABEL_STYLE;
    document.documentElement.append(labelEl);
  }
  return { box: boxEl, label: labelEl };
}

/**
 * Draws the highlight over `nodes` and labels it `name`.
 *
 * Returns the direction the target lies in, so a caller that is highlighting on
 * the user's behalf — a hovered tree row, rather than the pointer — can say that
 * the component it just highlighted is not on screen.
 */
export function drawOverlay(nodes: Element[], name: string): OffscreenDirection {
  // DOMRect already satisfies Box structurally.
  const target = unionBox(nodes.map((n) => n.getBoundingClientRect()));

  if (!target) {
    hideOverlay();
    return 'none';
  }

  const { box, label } = ensureElements();

  box.style.display = 'block';
  box.style.left = `${target.left}px`;
  box.style.top = `${target.top}px`;
  box.style.width = `${target.width}px`;
  box.style.height = `${target.height}px`;

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const direction = offscreenDirection(target, viewport);

  label.textContent = direction === 'none' ? `<${name}>` : `${ARROWS[direction]} <${name}>`;
  label.style.display = 'block';

  // Measured after the text is set, so clamping uses the real rendered width.
  const size = { width: label.offsetWidth, height: label.offsetHeight };
  const placement = placeLabel(target, size, viewport);

  label.style.left = `${placement.left}px`;
  label.style.top = `${placement.top}px`;

  return direction;
}

export function hideOverlay(): void {
  if (boxEl) boxEl.style.display = 'none';
  if (labelEl) labelEl.style.display = 'none';
}

/**
 * Removes the overlay from the page entirely.
 *
 * Distinct from `hideOverlay` because the agent is a permanent resident: it is
 * injected at `document_start` on every page whether or not anyone is picking,
 * so leaving two hidden `<div>`s in every document the user visits would be the
 * extension making itself visible in the DOM inspector of every site on the web.
 */
export function destroyOverlay(): void {
  boxEl?.remove();
  labelEl?.remove();
  boxEl = null;
  labelEl = null;
}
