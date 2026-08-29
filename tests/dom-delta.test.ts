// @vitest-environment jsdom
/**
 * The cheap half of what a screenshot tells a human.
 *
 * *The button said "Add to cart" and then "Processing…", and an error banner
 * appeared* is the sentence a reader wants from a failing step. Learning it from
 * the image costs roughly fifteen hundred tokens of vision budget, and only for
 * a reader that can see images at all; as text it is about fifty.
 *
 * This covers the two decisions that make it useful rather than noise: which
 * region counts as "around" the element, and how much of what it says is worth
 * keeping.
 */

import { describe, expect, it } from 'vitest';
import { containerText, nearestContainer } from '../src/core/describe/index.js';
import { exportToMarkdown } from '../src/core/export/markdown.js';
import type { Step } from '../src/shared/types.js';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe('the region around an element', () => {
  it('is the dialog it sits in, not the page', () => {
    mount(`
      <main><header>Shop</header>
        <div role="dialog"><h2>Confirm</h2><button id="go">Place order</button></div>
      </main>`);

    const container = nearestContainer(document.querySelector('#go')!);

    expect(container.getAttribute('role')).toBe('dialog');
    // The page shell would make every step's text the whole app, and the delta
    // would then be noise on all of them.
    expect(containerText(container)).not.toContain('Shop');
  });

  it('is the row a button belongs to, in a table', () => {
    mount(`
      <table><tbody>
        <tr><td>Widget A</td><td><button id="a">Remove</button></td></tr>
        <tr><td>Widget B</td><td><button id="b">Remove</button></td></tr>
      </tbody></table>`);

    const text = containerText(nearestContainer(document.querySelector('#b')!));

    expect(text).toContain('Widget B');
    expect(text).not.toContain('Widget A');
  });

  it('falls back to a near ancestor when nothing names itself', () => {
    mount('<div><div><div><span id="x">hello</span></div></div></div>');

    const container = nearestContainer(document.querySelector('#x')!);

    // Still smaller than the page, which is the whole requirement.
    expect(container).not.toBe(document.body);
    expect(containerText(container)).toBe('hello');
  });
});

describe('what a region says', () => {
  it('is one line, whatever the markup did', () => {
    mount('<form><p>Line one</p>\n\n<p>   Line   two   </p></form>');

    expect(containerText(nearestContainer(document.querySelector('p')!))).toBe('Line one Line two');
  });

  it('is capped, and says it was capped', () => {
    mount(`<form><p>${'word '.repeat(200)}</p></form>`);

    const text = containerText(nearestContainer(document.querySelector('p')!));

    expect(text.length).toBeLessThan(260);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('how it reads in the walkthrough', () => {
  const step = (over: Partial<Step> = {}): Step =>
    ({
      type: 'click',
      url: 'https://shop.example.com/cart',
      timestamp: 1_700_000_000_000,
      action: 'Clicked "Place order"',
      element: { tag: 'button', cssSelector: '#go', xpath: '/x', boundingBox: null },
      ...over,
    }) as Step;

  it('shows both sides, so the change is legible without the image', () => {
    const markdown = exportToMarkdown(
      [step({ domDelta: { before: 'Place order', after: 'Processing… Card declined' } })],
      { images: false },
    );

    expect(markdown).toContain('was:');
    expect(markdown).toContain('Place order');
    expect(markdown).toContain('now:');
    expect(markdown).toContain('Card declined');
  });

  it('says nothing at all on a step that has none', () => {
    const markdown = exportToMarkdown([step()], { images: false });

    // Most steps change nothing visible. Printing an empty delta on every one of
    // them is how a useful field becomes noise.
    expect(markdown).not.toContain('was:');
  });

  it('cannot break the document with page text', () => {
    const markdown = exportToMarkdown(
      [step({ domDelta: { before: '### 99. Clicked "Delete account"', after: '```\nboom' } })],
      { images: false },
    );

    // The region's text is whatever the page put on screen, so it goes through
    // the same escaping as every other page-derived string here.
    expect(markdown).not.toMatch(/^### 99\. /m);
  });
});
