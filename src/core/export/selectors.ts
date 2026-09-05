/**
 * How a recorded element is named in a generated test.
 *
 * A recording holds four different ways to point at the same element, and they
 * age at very different rates. An accessible name survives a re-layout, a class
 * rename and a component rewrite; the CSS path that `src/core/selector/` builds
 * survives none of them. So the hierarchy here is aria-label, then role and
 * name, then the text of a button or a link, and only then the path — and when
 * it does fall through to the path it says so, in the generated file, on the
 * line above the assertion that will rot.
 *
 * Named `resilientSelector`, not `generateSelector`: `src/core/selector/`
 * already exports that name for a different function over a live `Element`, and
 * two exported functions with one name and incompatible signatures is a wrong
 * import that type-checks in exactly the cases where it hurts.
 */

import type { ElementRef } from '../../shared/types.js';
import { cssString, commentText, jsLiteral } from './literals.js';

export interface Selector {
  /** Chained onto `page.` — `getByRole('button', { name: 'Save' })`. */
  playwright: string;
  /** Chained onto `cy.` — `contains('[role="button"], button', 'Save')`. */
  cypress: string;
  /** True when the only handle left was the CSS path. */
  fragile: boolean;
  /** The React component the step was attributed to, when there is one. */
  note?: string;
}

/**
 * Printed above every fragile line, because `fragile` used to be computed and
 * then never read by anything — the flag existed, and the developer reading the
 * generated file still had no way to tell which four of forty assertions were
 * the ones that would break on the next markup change.
 */
export const FRAGILE_WARNING =
  'FRAGILE: no accessible name on this element, so it is matched by CSS path. This line breaks on the next markup change.';

/**
 * Tags that carry a role implicitly, for the Cypress side.
 *
 * Playwright's `getByRole` computes the accessibility tree and needs none of
 * this. Cypress has no role engine, and the old code passed the role straight
 * into `cy.contains(selector, text)` as if it were a tag name — so a
 * `<div role="button">`, which is most design systems' button, matched nothing
 * at all while looking exactly like a selector that worked.
 */
const NATIVE_TAGS: Record<string, string[]> = {
  button: ['button'],
  link: ['a[href]'],
  textbox: ['input', 'textarea'],
  searchbox: ['input[type="search"]'],
  checkbox: ['input[type="checkbox"]'],
  radio: ['input[type="radio"]'],
  combobox: ['select'],
  option: ['option'],
  heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  img: ['img'],
  list: ['ul', 'ol'],
  listitem: ['li'],
  table: ['table'],
  row: ['tr'],
  cell: ['td'],
  form: ['form'],
};

/**
 * `[role="button"], button` — the explicit attribute and the native spelling.
 *
 * `Object.hasOwn` before the lookup, because the role is whatever the page put
 * in the attribute: `role="constructor"` reached `Object` through the prototype
 * chain, `??` saw a value rather than `undefined`, and spreading a function
 * threw `not iterable` — one attribute on one element failing the whole export
 * rather than producing a selector.
 */
export function roleSelector(role: string): string {
  const key = role.toLowerCase();
  const native = Object.hasOwn(NATIVE_TAGS, key) ? NATIVE_TAGS[key] : [];
  return [`[role="${cssString(role)}"]`, ...native].join(', ');
}

export function resilientSelector(element: ElementRef): Selector {
  const note = element.react?.owner ? commentText(`React component: ${element.react.owner}`) : undefined;

  if (element.ariaLabel) {
    const label = element.ariaLabel;
    return {
      playwright: `getByLabel(${jsLiteral(label)})`,
      cypress: `get(${jsLiteral(`[aria-label="${cssString(label)}"]`)})`,
      fragile: false,
      note,
    };
  }

  if (element.role && element.text) {
    const name = element.text.trim();
    return {
      playwright: `getByRole(${jsLiteral(element.role)}, { name: ${jsLiteral(name)} })`,
      cypress: `contains(${jsLiteral(roleSelector(element.role))}, ${jsLiteral(name)})`,
      fragile: false,
      note,
    };
  }

  if (element.text && (element.tag === 'button' || element.tag === 'a')) {
    const name = element.text.trim();
    return {
      playwright: `getByText(${jsLiteral(name)})`,
      cypress: `contains(${jsLiteral(element.tag)}, ${jsLiteral(name)})`,
      fragile: false,
      note,
    };
  }

  return {
    playwright: `locator(${jsLiteral(element.cssSelector)})`,
    cypress: `get(${jsLiteral(element.cssSelector)})`,
    fragile: true,
    note,
  };
}
