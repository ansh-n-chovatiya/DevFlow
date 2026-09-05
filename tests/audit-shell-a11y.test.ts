// @vitest-environment jsdom
/**
 * Two facts the accessibility walk gets from the DOM, and used to get wrong.
 *
 * Both failed the same way: quietly, and by producing a *plausible* finding
 * rather than none. An audit that reports violations on a panel nobody can see,
 * or that accuses a working control of contradicting itself, is worse than an
 * audit that reports nothing — a reader stops believing the ones that are real.
 */

import { describe, expect, it } from 'vitest';

import { sampleA11y } from '../src/injected/a11y.js';
import { auditA11y } from '../src/core/a11y/index.js';

function page(html: string): void {
  document.body.innerHTML = html;
}

/** The walked node for the first element matching `selector`. */
function nodeFor(selector: string) {
  const { sample, elements } = sampleA11y(500);
  const target = document.querySelector(selector);
  const index = elements.indexOf(target as Element);
  expect(index, `${selector} was not reached by the walk`).toBeGreaterThanOrEqual(0);
  return { node: sample.nodes[index], sample };
}

/**
 * `aria-hidden` is inherited by the whole subtree, with no depth limit anywhere
 * in the specification.
 *
 * The climb used to stop after twelve ancestors, borrowing the constant the
 * *backdrop* search gives up at — and twelve is well inside the wrapper depth
 * of an ordinary application. A closed drawer is exactly the markup this bites
 * on: it is marked `aria-hidden="true"` at the top and the controls inside it
 * are deep.
 */
describe('aria-hidden on a distant ancestor', () => {
  const DEPTH = 20;

  const drawer = (): string =>
    `<div aria-hidden="true">${'<div>'.repeat(DEPTH)}<button></button>${'</div>'.repeat(DEPTH)}</div>`;

  it('is seen however far up it is', () => {
    page(drawer());
    expect(nodeFor('button').node.ariaHidden).toBe(true);
  });

  it('stops the hidden control being reported as an unnamed one', () => {
    page(drawer());
    const { sample } = nodeFor('button');
    const checks = auditA11y(null, sample).map((finding) => finding.check);
    expect(checks).not.toContain('no-accessible-name');
  });

  it('still reports focusable content stranded inside the hidden subtree', () => {
    // The check that exists for what is left behind a modal — and the thing
    // behind a modal is, by construction, the deep half of the page.
    page(
      `<div aria-hidden="true">${'<div>'.repeat(DEPTH)}<button tabindex="0">go</button>${'</div>'.repeat(DEPTH)}</div>`,
    );
    const { sample } = nodeFor('button');
    expect(auditA11y(null, sample).map((f) => f.check)).toContain('aria-hidden-focusable');
  });
});

/**
 * `disabled` means something on seven elements and nothing on any other.
 *
 * `A11yNode.disabled` is documented as a *native* disabled, and `core/a11y`
 * spends it on a contradiction check. Read as a bare attribute test, the very
 * ordinary hand-rolled `<div role="button" tabindex="0" disabled>` claimed a
 * state it does not have.
 */
describe('a `disabled` attribute where HTML gives it no meaning', () => {
  it('is not read as a native disabled state', () => {
    page('<div role="button" tabindex="0" disabled aria-disabled="false">Save</div>');
    const { node } = nodeFor('div[role="button"]');
    expect(node.disabled).toBe(false);
    // The browser will focus it, so the audit must not think otherwise.
    expect(node.focusable).toBe(true);
  });

  it('raises no contradiction against the element it does not disable', () => {
    page('<div role="button" tabindex="0" disabled aria-disabled="false">Save</div>');
    const { sample } = nodeFor('div[role="button"]');
    expect(auditA11y(null, sample).map((f) => f.check)).not.toContain(
      'aria-disabled-contradiction',
    );
  });

  it('still raises one where the attribute really does disable', () => {
    page('<button disabled aria-disabled="false">Save</button>');
    const { node, sample } = nodeFor('button');
    expect(node.disabled).toBe(true);
    expect(auditA11y(null, sample).map((f) => f.check)).toContain('aria-disabled-contradiction');
  });
});
