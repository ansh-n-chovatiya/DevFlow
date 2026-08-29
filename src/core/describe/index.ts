/**
 * Turning a clicked DOM node into a sentence a human recognises.
 *
 * This is the difference between "Clicked element" and `Clicked "Save changes"`,
 * and it is the most valuable logic in the recorder. Pure functions over an
 * element, so each rule is testable on its own.
 */

import { CONTAINER_TEXT_CAP } from '../../shared/constants.js';

const INTERACTIVE_TAGS = new Set(['a', 'button', 'select', 'summary']);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'switch',
  'checkbox',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
]);

/**
 * Lucide icon names → what the button does. An icon-only button has no text, so
 * without this the step reads "Clicked element" and tells nobody anything.
 */
const ICON_NAMES: Record<string, string> = {
  'move-up': 'sort ascending',
  'move-down': 'sort descending',
  'arrow-up': 'sort ascending',
  'arrow-down': 'sort descending',
  'arrow-up-down': 'sort',
  'chevrons-up-down': 'sort',
  'chevron-down': 'expand',
  'chevron-up': 'collapse',
  'chevron-right': 'expand',
  x: 'close',
  trash: 'delete',
  'trash-2': 'delete',
  plus: 'add',
  pencil: 'edit',
  pen: 'edit',
  search: 'search',
  settings: 'settings',
  'sliders-horizontal': 'filters',
  'more-horizontal': 'more options',
  'more-vertical': 'more options',
  eye: 'show',
  'eye-off': 'hide',
  filter: 'filter',
  funnel: 'filter',
  'refresh-cw': 'refresh',
  'rotate-cw': 'refresh',
  play: 'run',
  star: 'favorite',
  download: 'download',
  upload: 'upload',
  copy: 'copy',
  check: 'confirm',
  'external-link': 'open in new tab',
};

/** How far up the tree to look for the real control behind a clicked child. */
const MAX_TARGET_HOPS = 4;

/** Longest label we keep; past this it is a paragraph, not a name. */
const MAX_NAME_LEN = 80;

function isInteractive(el: Element | null): boolean {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (tag === 'input' || tag === 'textarea') return true;
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return el.hasAttribute('onclick');
}

/**
 * Clicks land on whatever is under the cursor — usually a `<span>` or `<svg>`
 * inside the button. Walk up to the element that actually handles the click.
 */
export function resolveTarget(el: Element): Element {
  if (isInteractive(el)) return el;
  let node = el.parentElement;
  let hops = 0;
  while (node && node.nodeType === 1 && hops < MAX_TARGET_HOPS) {
    if (node.tagName.toLowerCase() === 'body') break;
    if (isInteractive(node)) return node;
    node = node.parentElement;
    hops++;
  }
  return el;
}

export function iconName(el: Element): string {
  const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg');
  const cls = svg?.getAttribute('class') ?? '';
  const match = /lucide-([a-z0-9-]+)/i.exec(cls);
  if (!match) return '';
  const key = match[1].toLowerCase();
  return ICON_NAMES[key] ?? key.replace(/-/g, ' ');
}

/**
 * Inputs whose `value` is a caption the user actually read, rather than data
 * they entered.
 *
 * Everything not listed here is refused, because a field's *contents* are not
 * its name and using them as one defeated the masking applied everywhere else:
 * `input.value` is starred out when recorded as a typed value, but the same
 * string used as the element's label went in verbatim — `Typed "•••••••" into
 * S3cret!`. An autofilled card number produced `Clicked "4111 1111 1111 1111"`,
 * which is then written to storage, into the Markdown export, into the ZIP, and
 * POSTed to the MCP server.
 */
const BUTTON_INPUT = /^(submit|button|reset)$/i;

/** A form control, whose `value` is user data rather than a name. */
function isControl(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

/**
 * The element's `value`, when it is safe to read it as a name.
 *
 * A `<select>`'s value is the option the user picked, which genuinely names the
 * control. A text field's is whatever they typed, which does not — and a
 * checkbox's is the string `"on"`, which is where `Toggled "on" → on` came from.
 */
function nameableValue(el: Element): string {
  const node = el as HTMLElement & { value?: string; type?: string };
  if (!isControl(el)) return node.value?.trim() ?? '';
  if (el.tagName.toLowerCase() === 'select') return node.value?.trim() ?? '';

  const type = (node.type ?? 'text').toLowerCase();
  // On a button-shaped input the `value` *is* the rendered label — it is what
  // the user read before clicking, and the only name the element has.
  if (BUTTON_INPUT.test(type)) return node.value?.trim() ?? '';
  // Everything else — text, search, number, password — holds the user's own
  // data, and a name is not what it is. The typed value reaches the flow through
  // the `input` step, which is the field meant to carry it, masked when it is a
  // password. `checkbox` and `radio` default to the literal string "on", which
  // is where `Toggled "on" → on` came from.
  return '';
}

function textOf(el: Element): string {
  const node = el as HTMLElement & { value?: string };
  return node.innerText?.trim() || nameableValue(el) || '';
}

/** The name a screen reader would announce, by roughly the same precedence. */
export function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim().slice(0, MAX_NAME_LEN);

  // `aria-labelledby` takes a *list* of ids; treating it as one silently missed
  // the common multi-id form and fell through to a worse name.
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const refText = labelledby
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.innerText?.trim())
      .filter(Boolean)
      .join(' ');
    if (refText) return refText.slice(0, MAX_NAME_LEN);
  }

  const text = textOf(el);
  if (text) return text.slice(0, MAX_NAME_LEN);

  for (const attr of ['title', 'alt'] as const) {
    const value = el.getAttribute(attr);
    if (value?.trim()) return value.trim().slice(0, MAX_NAME_LEN);
  }

  const icon = iconName(el);
  if (icon) return icon;

  // A cell in a table has no name of its own; its column header is the next
  // best thing, and is usually what the user would call it.
  const th = el.closest('th');
  const thText = (th as HTMLElement | null)?.innerText?.trim();
  if (thText) return thText.slice(0, 40);

  return '';
}

/** Visible text for an element, falling back through the usual label attributes. */
export function getElementText(el: Element): string {
  const node = el as HTMLElement & { value?: string };
  const text =
    node.innerText?.trim() ||
    nameableValue(el) ||
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    el.getAttribute('alt') ||
    '';
  return text.trim().slice(0, MAX_NAME_LEN);
}

/** The label a person would use for a form field. */
export function getElementLabel(el: Element): string {
  const labelled = el as HTMLInputElement;
  const firstLabel = labelled.labels?.[0]?.innerText?.trim();
  if (firstLabel) return firstLabel;

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return placeholder;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;

  // Consulted before the text fallback, which for a floating-label form was the
  // only thing standing between the field's own contents and the step text.
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const refText = labelledby
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.innerText?.trim())
      .filter(Boolean)
      .join(' ');
    if (refText) return refText;
  }

  if (el.id) {
    const forLabel = el.ownerDocument.querySelector<HTMLElement>(
      `label[for="${CSS.escape(el.id)}"]`,
    );
    const forText = forLabel?.innerText?.trim();
    if (forText) return forText;
  }

  return getElementText(el) || el.tagName.toLowerCase();
}

/**
 * The state a toggle was in *before* the click, for both kinds of toggle.
 *
 * The two kinds read at opposite ends of the same gesture, which is why this
 * reports the prior state rather than the resulting one. Everything here runs
 * from a document-level capture-phase `click` listener: `aria-checked` is still
 * whatever the app rendered last, because the app's own handler has not run
 * yet, while a native checkbox has already been flipped by the browser's
 * pre-click activation. Reading each one literally made ARIA describe the past
 * and native the present under the same `→ on` wording, so a `role="switch"`
 * step read `Toggled "Email notifications" → off` beside a screenshot, taken
 * 150ms later, of a switch that is plainly on.
 *
 * Prior state is the one fact both can supply exactly. The resulting state
 * cannot be: for ARIA it would have to be guessed by inverting, and a toggle
 * whose request fails does not move.
 */
function priorToggleState(el: Element): string | null {
  const checked = el.getAttribute('aria-checked');
  if (checked === 'true') return 'on';
  if (checked === 'false') return 'off';
  const input = el as HTMLInputElement;
  if (el.tagName.toLowerCase() === 'input' && input.type === 'checkbox') {
    // Already flipped by the time this runs, so the state before the click is
    // the opposite of what the element now reports.
    return input.checked ? 'off' : 'on';
  }
  return null;
}

/**
 * Whether clicking this is likely to destroy the current page — a link or a
 * submit button. Those are the interactions whose screenshot has to be taken
 * before the click rather than after it.
 *
 * Deliberately narrow, because a false positive costs a step its picture. A
 * pre-capture is the frame from *before* the gesture, and the click that
 * follows claims it in place of the settled capture — so every element wrongly
 * named here is described by a photograph of the page it was about to change:
 * `Clicked "Advanced"` beside a panel still collapsed.
 */
export function mayNavigate(rawEl: Element): boolean {
  const el = resolveTarget(rawEl);
  const tag = el.tagName.toLowerCase();

  if (tag === 'a') return el.hasAttribute('href');
  if (el.getAttribute('role') === 'link') return true;

  if (tag === 'button') {
    // `type` alone, and no `closest('form')`. A `<button>` with no type
    // attribute already reports `submit`, in a form or out of one, so the form
    // clause added nothing except `type="button"` and `type="reset"` — the two
    // that exist precisely because they do *not* submit. An accordion header or
    // a "+ Add row" inside a form was taking the pre-click frame for a click
    // that never left the page.
    return (el as HTMLButtonElement).type === 'submit';
  }

  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    return type === 'submit' || type === 'image';
  }

  return false;
}

export interface DescribedTarget {
  /** The control that was really clicked, which may be an ancestor of the node. */
  el: Element;
  /** One sentence in the past tense, e.g. `Clicked "Save" (confirm)`. */
  action: string;
}

/**
 * How far up from the touched element to look for the region it belongs to.
 *
 * Four is enough to leave a button and land on the card, row or panel around it,
 * and few enough that it does not reach the page shell — where the text would be
 * the whole app and the delta would be noise on every step.
 */
const CONTAINER_DEPTH = 4;

// `CONTAINER_TEXT_CAP` is the default only. The recorder passes the recording's
// frozen `recording.containerTextCap`; the constant is what this pure module
// answers with when nobody has an opinion, which is what keeps its tests honest
// about the shipped behaviour. Visible text worth keeping from one region is in
// `shared/constants` so `features/settings/fields.ts` can import it as the
// default for `recording.containerTextCap` rather than retyping the number.

/**
 * The nearest region that reads as a unit around `el`.
 *
 * Preference order matters: a landmark or a list item is a thing the user can
 * see the edges of, and the delta is only useful when a reader can picture what
 * changed. Falling back to a plain ancestor is fine — it is still smaller than
 * the page.
 */
export function nearestContainer(el: Element): Element {
  const named = el.closest(
    '[role="dialog"],[role="alert"],[role="status"],form,li,tr,article,section,fieldset',
  );
  if (named) return named;

  /*
   * The element's own document, never the global one. `core/` is pure by rule —
   * it is handed the nodes it works on and reaches for nothing — and that rule
   * is what lets `mcp-bundle.ts` ship this directory to a Node process with no
   * DOM at all. A bare `document` here would have been the first thing in
   * `core/` to need one.
   */
  const body = el.ownerDocument?.body;

  let node: Element = el;
  for (let depth = 0; depth < CONTAINER_DEPTH; depth++) {
    const parent = node.parentElement;
    if (!parent || parent === body) break;
    node = parent;
  }
  return node;
}

/**
 * What a region says, as one line.
 *
 * This is the cheap half of what a screenshot tells a human. *The button said
 * "Processing…" and an error banner appeared* is the sentence a reader wants,
 * and it costs about fifty tokens against roughly fifteen hundred for opening
 * the JPEG and looking. It does not replace the image; it means the image only
 * has to be opened when the text is not enough.
 */
export function containerText(el: Element, cap: number = CONTAINER_TEXT_CAP): string {
  const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/** Resolve the real target of a click and describe what the user just did. */
export function describeTarget(rawEl: Element): DescribedTarget {
  const el = resolveTarget(rawEl);
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const input = el as HTMLInputElement;
  const name = accessibleName(el);
  const quoted = name ? ` "${name}"` : '';

  if (role === 'switch' || role === 'checkbox' || (tag === 'input' && input.type === 'checkbox')) {
    const before = priorToggleState(el);
    return { el, action: `Toggled${quoted || ' control'}${before ? ` (was ${before})` : ''}` };
  }

  if (tag === 'a' || role === 'link') return { el, action: `Clicked link${quoted}` };
  if (tag === 'select') return { el, action: `Opened dropdown${quoted}` };

  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (type === 'submit') return { el, action: `Clicked submit${quoted}` };
    if (type === 'radio') return { el, action: `Selected${quoted}` };
  }

  const icon = iconName(el);
  if (name) {
    // Only append the icon when it says something the name does not.
    const suffix = icon && icon !== name && !name.toLowerCase().includes(icon) ? ` (${icon})` : '';
    return { el, action: `Clicked "${name}"${suffix}` };
  }
  if (icon) return { el, action: `Clicked "${icon}"` };
  return { el, action: 'Clicked element' };
}
