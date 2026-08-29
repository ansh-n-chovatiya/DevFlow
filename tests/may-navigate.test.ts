// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { mayNavigate } from '../src/core/describe/index.js';

function mount(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * These are the interactions whose screenshot has to be taken *before* the
 * click, because the page they describe is gone milliseconds later.
 */
describe('mayNavigate', () => {
  it('is true for a link with an href', () => {
    mount('<a href="/orders">Orders</a>');
    expect(mayNavigate(document.querySelector('a')!)).toBe(true);
  });

  it('is false for an anchor used as a button', () => {
    mount('<a>Toggle</a>');
    expect(mayNavigate(document.querySelector('a')!)).toBe(false);
  });

  it('is true for anything with role=link', () => {
    mount('<div role="link">Go</div>');
    expect(mayNavigate(document.querySelector('div')!)).toBe(true);
  });

  it('is true for a submit button, typed or untyped', () => {
    mount('<button type="submit">Save</button>');
    expect(mayNavigate(document.querySelector('button')!)).toBe(true);

    // No type attribute is `submit`, which is why the old `closest('form')`
    // clause added nothing for the buttons that do navigate.
    mount('<form><button>Save</button></form>');
    expect(mayNavigate(document.querySelector('button')!)).toBe(true);
  });

  /*
   * A false positive here costs the step its picture. The pre-capture is the
   * frame from *before* the gesture and the click claims it in place of the
   * settled capture, so `Clicked "Advanced"` came out beside a photograph of the
   * panel still collapsed. `type="button"` and `type="reset"` exist precisely
   * because they do not submit — being inside a form says nothing about them.
   */
  it('is false for a non-submitting button, form or no form', () => {
    mount('<form><button type="button">Add row</button></form>');
    expect(mayNavigate(document.querySelector('button')!)).toBe(false);

    mount('<form><button type="reset">Clear</button></form>');
    expect(mayNavigate(document.querySelector('button')!)).toBe(false);
  });

  it('is false for a standalone button', () => {
    mount('<button type="button">Open menu</button>');
    expect(mayNavigate(document.querySelector('button')!)).toBe(false);
  });

  it('is true for submit and image inputs', () => {
    mount('<input type="submit" value="Go">');
    expect(mayNavigate(document.querySelector('input')!)).toBe(true);

    mount('<input type="image" alt="Go">');
    expect(mayNavigate(document.querySelector('input')!)).toBe(true);
  });

  it('is false for a text input', () => {
    mount('<input type="text">');
    expect(mayNavigate(document.querySelector('input')!)).toBe(false);
  });

  it('resolves through the icon inside a link, which is what gets clicked', () => {
    mount('<a href="/x"><svg class="lucide lucide-external-link"></svg></a>');
    expect(mayNavigate(document.querySelector('svg')!)).toBe(true);
  });

  it('is false for ordinary page content', () => {
    mount('<p id="p">Some text</p>');
    expect(mayNavigate(document.getElementById('p')!)).toBe(false);
  });
});
