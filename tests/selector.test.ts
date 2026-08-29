// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  generateSelector,
  generateXPath,
  isStableSelector,
} from '../src/core/selector/index.js';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('generateSelector', () => {
  it('prefers an id over everything else', () => {
    mount('<button id="save" data-testid="save-btn" aria-label="Save">Save</button>');
    expect(generateSelector(document.querySelector('button'))).toBe('#save');
  });

  it('falls back to data-testid, then aria-label', () => {
    mount('<button data-testid="save-btn" aria-label="Save">Save</button>');
    expect(generateSelector(document.querySelector('button'))).toBe(
      'button[data-testid="save-btn"]',
    );

    mount('<button aria-label="Save">Save</button>');
    expect(generateSelector(document.querySelector('button'))).toBe('button[aria-label="Save"]');
  });

  it('builds a path when the element has no stable hook', () => {
    mount('<div class="wrap"><span><button>Go</button></span></div>');
    expect(generateSelector(document.querySelector('button'))).toBe('div.wrap > span > button');
  });

  it('anchors the path on the nearest ancestor id and stops there', () => {
    mount('<div id="panel"><div class="row"><button>Go</button></div></div>');
    expect(generateSelector(document.querySelector('button'))).toBe('#panel > div.row > button');
  });

  it('drops transient state classes', () => {
    mount('<div class="card active hover"><button>Go</button></div>');
    expect(generateSelector(document.querySelector('button'))).toBe('div.card > button');
  });

  it('keeps at most two classes so the selector stays readable', () => {
    mount('<div class="a b c d"><button>Go</button></div>');
    expect(generateSelector(document.querySelector('button'))).toBe('div.a.b > button');
  });

  it('disambiguates repeated siblings by position', () => {
    mount('<ul><li>one</li><li>two</li></ul>');
    const second = document.querySelectorAll('li')[1];
    expect(generateSelector(second)).toBe('ul > li:nth-of-type(2)');
  });

  it('returns empty for a missing element', () => {
    expect(generateSelector(null)).toBe('');
  });
});

/**
 * A selector that matches several elements is not a weaker hook — it is a wrong
 * one. Nothing checked, so the recorder was writing down selectors that resolve
 * to an element the user never touched, and `isStableSelector` then presented
 * them as the trustworthy ones.
 */
describe('a selector has to resolve to exactly one element', () => {
  it('does not record a repeated test id, which would replay on the first row', () => {
    mount(`
      <table><tbody>
        <tr><td><button data-testid="row-delete">Delete</button></td></tr>
        <tr><td><button data-testid="row-delete">Delete</button></td></tr>
        <tr><td><button data-testid="row-delete">Delete</button></td></tr>
      </tbody></table>
    `);
    const third = document.querySelectorAll('button')[2];

    const selector = generateSelector(third);
    expect(selector).not.toBe('button[data-testid="row-delete"]');
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(third);
  });

  it('keeps a test id that really is unique', () => {
    mount('<div><button data-testid="save">Save</button><button>Cancel</button></div>');
    expect(generateSelector(document.querySelector('button'))).toBe(
      'button[data-testid="save"]',
    );
  });

  it('does not record a duplicated id — a form in the page and the same form in a modal', () => {
    mount(`
      <form class="page"><button id="save">Save</button></form>
      <div class="modal"><form><button id="save">Save</button></form></div>
    `);
    const inModal = document.querySelectorAll('#save')[1];

    const selector = generateSelector(inModal);
    expect(selector).not.toBe('#save');
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(inModal);
  });

  it('does not anchor a path on a duplicated ancestor id either', () => {
    mount(`
      <div id="panel"><span>first</span></div>
      <div id="panel"><span><button>Go</button></span></div>
    `);
    const button = document.querySelector('button')!;

    const selector = generateSelector(button);
    expect(selector).not.toContain('#panel');
    expect(document.querySelector(selector)).toBe(button);
  });

  it('falls back to a repeated aria-label the same way', () => {
    mount('<div><button aria-label="Remove"></button><button aria-label="Remove"></button></div>');
    const second = document.querySelectorAll('button')[1];

    expect(generateSelector(second)).not.toBe('button[aria-label="Remove"]');
    expect(document.querySelector(generateSelector(second))).toBe(second);
  });
});

/**
 * `GENERATED_ID_RE` was written for these and only `isStableSelector` consulted
 * it, which is display-only — so the selector actually recorded anchored on the
 * id anyway. React reissues `:r3:` as `:r7:` on the next mount, and the flow
 * carried a selector that matches nothing while claiming it was the element's
 * stable hook.
 */
describe('framework-generated ids anchor nothing', () => {
  it('skips the element’s own generated id', () => {
    mount('<div class="dialog"><button id=":r3:">Confirm</button></div>');
    const button = document.querySelector('button')!;

    const selector = generateSelector(button);
    expect(selector).not.toContain(':r3:');
    expect(isStableSelector(selector)).toBe(false); // and it says so, too
    expect(document.querySelector(selector)).toBe(button);
  });

  it('prefers a real test hook over a generated id', () => {
    mount('<button id=":r7:" data-testid="confirm">Confirm</button>');
    expect(generateSelector(document.querySelector('button'))).toBe(
      'button[data-testid="confirm"]',
    );
  });

  it('walks past a generated ancestor id instead of stopping on it', () => {
    mount('<div id="radix-:r1:"><div class="row"><button>Go</button></div></div>');
    const button = document.querySelector('button')!;

    const selector = generateSelector(button);
    expect(selector).not.toContain('radix');
    expect(document.querySelector(selector)).toBe(button);
  });

  it('still anchors on an id a human wrote', () => {
    mount('<div id="checkout-panel"><div class="row"><button>Go</button></div></div>');
    expect(generateSelector(document.querySelector('button'))).toBe(
      '#checkout-panel > div.row > button',
    );
  });
});

describe('generateXPath', () => {
  it('numbers each level from the root', () => {
    mount('<div><p>one</p><p>two</p></div>');
    const second = document.querySelectorAll('p')[1];
    expect(generateXPath(second)).toBe('/html[1]/body[1]/div[1]/p[2]');
  });

  it('returns empty for a missing element', () => {
    expect(generateXPath(null)).toBe('');
  });
});

describe('isStableSelector', () => {
  it('accepts ids and test hooks', () => {
    expect(isStableSelector('#save')).toBe(true);
    expect(isStableSelector('button[data-testid="save"]')).toBe(true);
    expect(isStableSelector('button[aria-label="Save"]')).toBe(true);
  });

  it('rejects descendant chains, which break on any markup change', () => {
    expect(isStableSelector('div.wrap > span > button')).toBe(false);
  });

  it('rejects framework-generated ids, which change every render', () => {
    expect(isStableSelector('#radix-1')).toBe(false);
    expect(isStableSelector('#:r3:')).toBe(false);
  });

  it('rejects anything long enough to be noise in an export', () => {
    expect(isStableSelector(`#${'x'.repeat(70)}`)).toBe(false);
  });

  it('rejects nothing at all', () => {
    expect(isStableSelector('')).toBe(false);
    expect(isStableSelector(null)).toBe(false);
  });
});
