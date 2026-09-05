/**
 * Measuring a page's accessibility without taking part in it.
 *
 * ## One walk, at the settled sample, and nothing installed
 *
 * This is `render.ts`'s and `state.ts`'s discipline applied to the DOM: no
 * `MutationObserver`, no focus listener of our own, no attribute written, no
 * global defined. It reads, at the two moments the recorder already samples,
 * and holds no module-level state at all — so "inert when not recording" is not
 * a property this file maintains, there is nothing here to be running.
 *
 * The cost is deliberately asymmetric between the two samples, because the
 * first one runs **inside the user's gesture**. The before-sample takes only
 * what the focus checks need — which element has focus and which modals are
 * open — and visits no other element. The full walk, with the `getComputedStyle`
 * calls that are the expensive part, happens only at the settled sample, off
 * the gesture. A recorder that costs a person latency on every click is one
 * they turn off.
 *
 * ## The backdrop is resolved or the check is skipped
 *
 * `getComputedStyle(el).backgroundColor` is `rgba(0, 0, 0, 0)` on nearly
 * everything, so the colour a user actually sees behind text is an ancestor's.
 * `resolveBackdrop` climbs until it finds a fully opaque background and returns
 * null if it does not — or if anything on the way carries a `background-image`,
 * which covers gradients, sprites and every `url()`. Compositing a translucent
 * stack would be arithmetic the reader could not check, and assuming white is
 * the mistake that produces confident wrong ratios on every dark theme ever
 * shipped. `core/a11y` skips a node with no backdrop and the step's note says
 * how many were skipped, so a missing finding is never read as a passing one.
 *
 * ## What this does not walk, and why that is a unit of work rather than a line
 *
 * The walk descends `el.children`, so an open shadow root is never entered and
 * nothing a web component renders is ever audited. That is a real gap and it is
 * named here rather than half-closed, because pushing `el.shadowRoot.children`
 * onto the queue is the one line of it that is easy. Every reading taken per
 * node is document-scoped and would answer *wrongly* rather than not at all
 * across the boundary: `hiddenFromAT`'s `closest` stops at the shadow root, so
 * an `aria-hidden="true"` host would stop hiding its own subtree and every
 * unnamed control inside a closed drawer would be reported — the exact defect
 * that function's header records fixing; `readName` resolves `aria-labelledby`
 * through `ownerDocument.getElementById`, and ids inside a shadow root are
 * scoped to it, so the name would come from whatever element in the outer
 * document happened to share the id; `resolveBackdrop` climbs `parentElement`,
 * which is null at the top of a root, so contrast would silently stop being
 * measured there; and `sampleFocus` reads `document.activeElement`, which is
 * retargeted to the *host*, and finds modals with a `document` query that a
 * dialog inside a root never matches.
 *
 * Closing it honestly is five shadow-aware readings, a decision about whether
 * shadow children spend the same `nodeCap` as the light DOM — they would
 * displace the top-of-tree nodes the breadth-first order exists to keep — and
 * the fixtures for each. `core/dom/walk.ts` does not shorten it: `climb` crosses
 * a boundary *upward*, out of a root to its host, which is the direction the
 * component join already needs and the opposite of the one this would.
 *
 * ## Why the name is approximated here rather than solved
 *
 * The accname specification is a document of its own. What this computes is the
 * path that answers for almost all real markup — `aria-label`, then
 * `aria-labelledby` resolved one level, then a native `<label>`, then `alt`,
 * then `title`, then trimmed text content — and it records **which** of them
 * answered, so `core/a11y` can say what a "no name" finding actually means. A
 * partial implementation that did not say it was partial would be the worse
 * thing to ship.
 */

import { NATIVELY_FOCUSABLE, type A11yNode, type A11ySample, type ContrastReading } from '../core/a11y/index.js';

/** How far up the tree a backdrop is looked for before giving up. */
const BACKDROP_CLIMB = 12;

/** Text long enough to be worth measuring the contrast of. */
const MIN_TEXT_LENGTH = 1;

/** Longest name or label kept — a report is read, not stored. */
const LABEL_CAP = 80;

/**
 * The elements HTML lets `disabled` mean anything on.
 *
 * `A11yNode.disabled` is documented as "a native `disabled`, not
 * `aria-disabled`", and `core/a11y` spends it twice: it suppresses
 * `keyboard-unreachable`, and it raises `aria-disabled-contradiction` against an
 * `aria-disabled="false"`. Read as a bare `hasAttribute` on any tag, the very
 * common hand-rolled `<div role="button" tabindex="0" disabled>` claimed a
 * native disabled state it does not have — the attribute is inert on a `div` —
 * so a fully keyboard-reachable control was reported as contradicting itself,
 * and `isFocusable` answered false about an element the browser will happily
 * focus.
 */
const NATIVELY_DISABLEABLE = new Set([
  'button',
  'fieldset',
  'input',
  'optgroup',
  'option',
  'select',
  'textarea',
]);

/** The roles this file recognises from a tag alone. */
const IMPLICIT_ROLE: Record<string, string> = {
  a: 'link',
  button: 'button',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  select: 'combobox',
  textarea: 'textbox',
};

const trim = (value: string | null | undefined): string | null => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, LABEL_CAP) : null;
};

/** `rgb()` / `rgba()` as the browser always serialises it, or null. */
function parseColour(value: string): { rgb: [number, number, number]; alpha: number } | null {
  const match = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i);
  if (!match) return null;
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![r, g, b].every(Number.isFinite)) return null;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  return { rgb: [r, g, b], alpha: Number.isFinite(alpha) ? alpha : 1 };
}

/**
 * The nearest fully opaque background behind an element, or null.
 *
 * Null is a real answer and the common one on a page that uses images. See the
 * header: a guess here is the failure mode that matters.
 */
function resolveBackdrop(el: Element): [number, number, number] | null {
  let node: Element | null = el;
  for (let climbed = 0; node && climbed < BACKDROP_CLIMB; climbed += 1) {
    const style = getComputedStyle(node);
    if (style.backgroundImage && style.backgroundImage !== 'none') return null;
    const colour = parseColour(style.backgroundColor);
    if (colour && colour.alpha === 1) return colour.rgb;
    // A translucent layer would have to be composited against whatever is
    // behind it, which is arithmetic nobody reading the report can check.
    if (colour && colour.alpha > 0) return null;
    node = node.parentElement;
  }
  return null;
}

/** The text this element owns directly, ignoring what its children own. */
function ownText(el: Element): string {
  let text = '';
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) text += child.nodeValue ?? '';
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** Foreground, backdrop and the type size — or null when any of it is unmeasurable. */
function readContrast(el: Element): ContrastReading | null {
  if (ownText(el).length < MIN_TEXT_LENGTH) return null;

  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return null;

  const fg = parseColour(style.color);
  if (!fg || fg.alpha !== 1) return null;

  const bg = resolveBackdrop(el);
  if (!bg) return null;

  /*
   * A size this cannot read is a threshold this cannot pick, so the check does
   * not run — the same rule the backdrop keeps. A browser always computes
   * `font-size` to a length; a keyword reaching here means the engine did not
   * resolve it, and guessing 16px would decide the large-text boundary on a
   * value nobody measured.
   */
  const fontPx = Number.parseFloat(style.fontSize);
  if (!Number.isFinite(fontPx)) return null;

  /*
   * Numeric or the keyword. A browser computes `font-weight` to a number and
   * every real page arrives that way, but the keyword is a legal serialisation
   * and reading it as "not bold" would pick the stricter 4.5:1 threshold for
   * large bold text — over-reporting, which costs an audit its credibility as
   * surely as under-reporting costs it its point.
   */
  const weight = Number(style.fontWeight);
  const bold = Number.isFinite(weight) ? weight >= 700 : /^(bold|bolder)$/i.test(style.fontWeight);
  return { fg: fg.rgb, bg, fontPx, bold };
}

/** The accessible name by the common paths, and which of them answered. */
function readName(el: Element): { name: string | null; from: A11yNode['nameFrom'] } {
  const label = trim(el.getAttribute('aria-label'));
  if (label) return { name: label, from: 'aria-label' };

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    // One level only, and deliberately: the specification recurses, and a
    // recursion here would be a second half-implementation to keep honest.
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => trim(el.ownerDocument.getElementById(id)?.textContent))
      .filter(Boolean);
    if (parts.length) return { name: trim(parts.join(' ')), from: 'aria-labelledby' };
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const native = trim(el.labels?.[0]?.textContent);
    if (native) return { name: native, from: 'native-label' };
  }

  const alt = trim(el.getAttribute('alt'));
  if (alt) return { name: alt, from: 'alt' };

  const title = trim(el.getAttribute('title'));
  if (title) return { name: title, from: 'title' };

  const text = trim(el.textContent);
  if (text) return { name: text, from: 'text' };

  return { name: null, from: null };
}

/** Whether the browser will put focus here, from what the element actually is. */
function isFocusable(el: Element, tag: string, tabIndex: number | null, disabled: boolean): boolean {
  if (disabled) return false;
  if (tabIndex !== null && tabIndex >= 0) return true;
  if (tabIndex !== null && tabIndex < 0) return false;
  if (tag === 'a') return el.hasAttribute('href');
  return NATIVELY_FOCUSABLE.has(tag);
}

/** A short handle a person can find the element by. */
function handle(el: Element, tag: string, name: string | null): string {
  const id = el.getAttribute('id');
  const base = id ? `${tag}#${id}` : tag;
  return name ? `${base} “${name}”` : base;
}

/** Is this element a modal container as ARIA or HTML defines one? */
function isModal(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'dialog' && el.hasAttribute('open')) return true;
  const role = el.getAttribute('role');
  return (role === 'dialog' || role === 'alertdialog') && el.getAttribute('aria-modal') === 'true';
}

/**
 * Whether this element, or anything above it, hides it from assistive
 * technology.
 *
 * `closest` rather than a bounded climb, and the bound is what was wrong: this
 * used to stop after `BACKDROP_CLIMB` ancestors, a constant declared for the
 * *backdrop* search, where giving up early is the documented answer because a
 * colour nobody can resolve must not be guessed. `aria-hidden` is not that
 * shape — it is inherited by the whole subtree with no depth limit in the
 * specification — and twelve levels is well inside an ordinary app's wrapper
 * depth.
 *
 * Both directions were wrong, and both quietly. A closed drawer marked
 * `aria-hidden="true"` reported every unnamed icon button beneath it as a real
 * `no accessible name` violation on a panel nobody can see; and
 * `aria-hidden-focusable` — the check that exists for focusable content left
 * behind a modal, which is the deepest thing on such a page — could not fire at
 * all.
 */
function hiddenFromAT(el: Element): boolean {
  return el.closest('[aria-hidden="true"]') !== null;
}

/**
 * What has focus and which modals are open — the whole of the before-sample.
 *
 * Cheap on purpose: this is the reading taken inside the user's gesture, so it
 * touches `document.activeElement` and the modal containers and nothing else.
 */
export function sampleFocus(): Pick<A11ySample, 'focus' | 'dialogs'> {
  const dialogs: string[] = [];
  for (const el of Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'))) {
    if (!isModal(el)) continue;
    dialogs.push(handle(el, el.tagName.toLowerCase(), readName(el).name));
  }

  const active = document.activeElement;
  const focus =
    active && active !== document.body
      ? {
          label: handle(active, active.tagName.toLowerCase(), readName(active).name),
          inDialog: Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'))
            .some((el) => isModal(el) && el.contains(active)),
        }
      : null;

  return { focus, dialogs };
}

/**
 * The full reading, taken once the app has settled.
 *
 * A bounded breadth-first walk, the same shape and the same reason as
 * `sampleRenders`: depth-first would spend the whole budget in one deep corner
 * of the page, and the elements a person interacts with are near the top.
 */
export function sampleA11y(nodeCap: number): { sample: A11ySample; elements: Element[] } {
  const nodes: A11yNode[] = [];
  /*
   * The elements, in the walk's own order, handed back with the reading.
   *
   * The first draft re-walked the tree in a second function to map a finding's
   * index onto an element, and that is a silent-drift hazard rather than a
   * duplication one: the two walks have to enumerate identically forever, and
   * the day one of them skips a node the indices shift and every finding is
   * attributed to the wrong component — with nothing to notice, because a
   * plausible component name is exactly what it would print. One walk, one
   * order, and the caller uses the array before it drops it.
   */
  const elements: Element[] = [];
  const queue: Element[] = document.body ? [document.body] : [];
  let walked = 0;
  let capped = false;

  while (queue.length) {
    if (walked >= nodeCap) {
      capped = true;
      break;
    }
    const el = queue.shift() as Element;
    walked += 1;
    /*
     * Bounded per node, as `render.ts` bounds its sibling chain and for its
     * reason: `Array.from(el.children)` on a virtualised list materialises
     * fifty thousand elements the walk will never reach, and it does so before
     * `nodeCap` gets a chance to bite.
     */
    const children = el.children;
    for (let i = 0; i < children.length && i < nodeCap; i += 1) queue.push(children[i]);

    elements.push(el);
    const tag = el.tagName.toLowerCase();
    const rawTabIndex = el.getAttribute('tabindex');
    const parsedTabIndex = rawTabIndex === null ? null : Number.parseInt(rawTabIndex, 10);
    const tabIndex = parsedTabIndex !== null && Number.isFinite(parsedTabIndex) ? parsedTabIndex : null;
    const disabled = NATIVELY_DISABLEABLE.has(tag) && el.hasAttribute('disabled');

    const aria: Record<string, string> = {};
    for (const attribute of Array.from(el.attributes)) {
      if (attribute.name.startsWith('aria-')) aria[attribute.name.toLowerCase()] = attribute.value;
    }

    const { name, from } = readName(el);

    nodes.push({
      i: nodes.length,
      tag,
      role: trim(el.getAttribute('role'))?.toLowerCase() ?? null,
      implicitRole: IMPLICIT_ROLE[tag] ?? null,
      name,
      nameFrom: from,
      aria,
      focusable: isFocusable(el, tag, tabIndex, disabled),
      tabIndex,
      disabled,
      ariaHidden: hiddenFromAT(el),
      contrast: readContrast(el),
      label: handle(el, tag, name),
    });
  }

  return { sample: { nodes, walked, capped, ...sampleFocus() }, elements };
}
