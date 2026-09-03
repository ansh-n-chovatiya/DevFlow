// @vitest-environment jsdom
/**
 * The page-side accessibility walk: what it measures and what it refuses to.
 *
 * `tests/a11y.test.ts` drives the rules with fixtures. This drives the half
 * that has to touch a DOM, and the cases worth having are the ones where the
 * measurement is *absent* — because an absent measurement is what stops
 * `core/a11y` from judging, and a walk that silently substituted a plausible
 * value would produce confident wrong findings with nothing to notice.
 *
 * jsdom computes styles from what the stylesheet and the inline attributes say,
 * which is exactly the part of a real browser this walk depends on. What it
 * cannot reproduce — a colour arrived at through a cascade of real paint — is
 * not what is being tested here; that the walk *asks* the engine rather than
 * reading the markup is.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { sampleA11y, sampleFocus } from '../src/injected/a11y.js';

function page(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('sampleA11y', () => {
  it('walks breadth-first from the body and stops at its cap', () => {
    page('<div><span>a</span><span>b</span></div><p>c</p>');
    const { sample } = sampleA11y(3);
    expect(sample.capped).toBe(true);
    expect(sample.walked).toBe(3);
  });

  it('hands back the elements in the walk’s own order, so an index cannot drift', () => {
    page('<button id="one">A</button><button id="two">B</button>');
    const { sample, elements } = sampleA11y(50);
    expect(elements.length).toBe(sample.nodes.length);
    for (const node of sample.nodes) {
      expect(elements[node.i].tagName.toLowerCase()).toBe(node.tag);
    }
  });

  it('reports no contrast when nothing behind the text is opaque', () => {
    page('<p style="color: rgb(10,10,10)">hello</p>');
    const node = sampleA11y(50).sample.nodes.find((n) => n.tag === 'p');
    expect(node?.contrast).toBeNull();
  });

  it('measures contrast once an opaque backdrop exists', () => {
    page('<div style="background-color: rgb(255,255,255)"><p style="color: rgb(0,0,0); font-size: 16px">hi</p></div>');
    const node = sampleA11y(50).sample.nodes.find((n) => n.tag === 'p');
    expect(node?.contrast).toMatchObject({ fg: [0, 0, 0], bg: [255, 255, 255] });
  });

  it('refuses a backdrop behind a background image rather than climbing past it', () => {
    page(
      '<div style="background-color: rgb(255,255,255)">' +
        '<div style="background-image: url(x.png)"><p style="color: rgb(0,0,0); font-size: 16px">hi</p></div>' +
        '</div>',
    );
    const node = sampleA11y(50).sample.nodes.find((n) => n.tag === 'p');
    expect(node?.contrast).toBeNull();
  });

  it('measures no contrast on an element whose text belongs to its children', () => {
    page('<div style="background-color: rgb(255,255,255); font-size: 16px"><span style="color:rgb(0,0,0); font-size: 16px">hi</span></div>');
    const nodes = sampleA11y(50).sample.nodes;
    expect(nodes.find((n) => n.tag === 'div')?.contrast).toBeNull();
    expect(nodes.find((n) => n.tag === 'span')?.contrast).not.toBeNull();
  });

  it('records which path found the accessible name, in the specified order', () => {
    page(
      '<button aria-label="From label">Text</button>' +
        '<button title="From title">   </button>' +
        '<button>From text</button>' +
        '<img alt="From alt">',
    );
    const nodes = sampleA11y(50).sample.nodes;
    // `body` is walked too and owns the whole page's text, so the comparison
    // is over the elements the case is actually about.
    expect(
      nodes.filter((n) => n.nameFrom && n.tag !== 'body').map((n) => [n.nameFrom, n.name]),
    ).toEqual([
      ['aria-label', 'From label'],
      ['title', 'From title'],
      ['text', 'From text'],
      ['alt', 'From alt'],
    ]);
  });

  it('reads aria-labelledby one level, and no further', () => {
    page('<span id="lbl">Named here</span><button aria-labelledby="lbl"></button>');
    const button = sampleA11y(50).sample.nodes.find((n) => n.tag === 'button');
    expect(button).toMatchObject({ name: 'Named here', nameFrom: 'aria-labelledby' });
  });

  it('calls a bare anchor unfocusable and one with an href focusable', () => {
    page('<a>no href</a><a href="/x">has one</a>');
    const anchors = sampleA11y(50).sample.nodes.filter((n) => n.tag === 'a');
    expect(anchors.map((a) => a.focusable)).toEqual([false, true]);
  });

  it('lets a negative tabindex take focusability away from a native control', () => {
    page('<button tabindex="-1">x</button><button>y</button>');
    expect(sampleA11y(50).sample.nodes.filter((n) => n.tag === 'button').map((b) => b.focusable))
      .toEqual([false, true]);
  });

  it('sees aria-hidden on an ancestor, not only on the element', () => {
    page('<div aria-hidden="true"><button>x</button></div>');
    expect(sampleA11y(50).sample.nodes.find((n) => n.tag === 'button')?.ariaHidden).toBe(true);
  });

  it('collects the aria attributes and the implicit role', () => {
    page('<h2 aria-level="2">Title</h2>');
    const heading = sampleA11y(50).sample.nodes.find((n) => n.tag === 'h2');
    expect(heading?.implicitRole).toBe('heading');
    expect(heading?.aria).toEqual({ 'aria-level': '2' });
  });
});

describe('sampleFocus', () => {
  it('finds a modal by role and aria-modal, and ignores a non-modal dialog role', () => {
    page('<div role="dialog" aria-modal="true">Modal</div><div role="dialog">Not modal</div>');
    expect(sampleFocus().dialogs.length).toBe(1);
  });

  it('finds an open <dialog> and not a closed one', () => {
    page('<dialog open>Open</dialog><dialog>Shut</dialog>');
    expect(sampleFocus().dialogs.length).toBe(1);
  });

  it('reports nothing focused when focus is on the body', () => {
    page('<button>x</button>');
    expect(sampleFocus().focus).toBeNull();
  });

  it('says whether the focused element is inside the modal', () => {
    page('<div role="dialog" aria-modal="true"><button id="inside">Yes</button></div><button id="outside">No</button>');

    (document.getElementById('inside') as HTMLElement).focus();
    expect(sampleFocus().focus?.inDialog).toBe(true);

    (document.getElementById('outside') as HTMLElement).focus();
    expect(sampleFocus().focus?.inDialog).toBe(false);
  });
});
