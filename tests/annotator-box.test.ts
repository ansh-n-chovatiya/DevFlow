/**
 * Where the highlight box actually lands.
 *
 * The red box is the only thing in a flow that says *this* is the element the
 * step is about, so a box in the wrong place is not a cosmetic bug — it is a
 * screenshot captioned as evidence of something that did not happen. The
 * drawing itself needs `OffscreenCanvas`; the geometry that decides where and
 * whether to draw is pure, and it is all of the wrongness.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fillFor, highlightRect, type Rect } from '../src/background/annotator.js';
import { ANNOTATION_STROKE } from '../src/shared/constants.js';
import { DEFAULTS, resolve } from '../src/features/settings/index.js';
import type { BoundingBox } from '../src/shared/types.js';

const IMAGE: Rect = { x: 0, y: 0, w: 1000, h: 800 };
const NO_SCROLL = { x: 0, y: 0 };

const box = (over: Partial<BoundingBox> = {}): BoundingBox => ({
  x: 100,
  y: 50,
  width: 200,
  height: 40,
  ...over,
});

describe('the ordinary case', () => {
  it('pads the box and scales it into device pixels', () => {
    // 4 CSS px of padding on each side, everything doubled for a 2× display.
    expect(highlightRect(box(), 2, NO_SCROLL, IMAGE)).toEqual({
      x: 192,
      y: 92,
      w: 416,
      h: 96,
    });
  });
});

/**
 * `box` is measured in the content script at event time; the picture is taken
 * at least 150ms later. Anything that scrolls in between — most obviously a
 * control that calls `scrollIntoView()` on itself — leaves the element
 * somewhere else, and the highlight was drawn over whatever moved into its
 * place, 500px from the thing that was clicked.
 */
describe('a scroll between measuring and capturing', () => {
  it('moves the box by what the page moved', () => {
    const scrolled = highlightRect(box({ y: 600 }), 1, { x: 0, y: 500 }, IMAGE);
    expect(scrolled?.y).toBe(96); // 600 measured − 500 scrolled − 4 padding
  });

  it('draws nothing at all once the element has scrolled off the capture', () => {
    expect(highlightRect(box({ y: 600 }), 1, { x: 0, y: 900 }, IMAGE)).toBeNull();
  });

  it('is the old behaviour when no delta is known', () => {
    expect(highlightRect(box(), 1, NO_SCROLL, IMAGE)).toEqual({ x: 96, y: 46, w: 208, h: 48 });
  });
});

/**
 * Clicking a `<label>` dispatches a synthetic click on the control it labels,
 * and a `display:none` file input has a rect of all zeros. Unguarded, that drew
 * an 8px red square at (−4, −4) — over the site logo, in a step that says the
 * user clicked "Upload a file".
 */
describe('boxes there is no honest way to draw', () => {
  it('refuses a zero-sized box', () => {
    expect(highlightRect(box({ width: 0, height: 0 }), 1, NO_SCROLL, IMAGE)).toBeNull();
    expect(highlightRect(box({ width: 200, height: 0 }), 1, NO_SCROLL, IMAGE)).toBeNull();
    expect(highlightRect(box({ width: 0, height: 40 }), 1, NO_SCROLL, IMAGE)).toBeNull();
  });

  it('refuses a negative-sized box', () => {
    expect(highlightRect(box({ width: -10 }), 1, NO_SCROLL, IMAGE)).toBeNull();
  });

  it('refuses a box that does not touch the image', () => {
    expect(highlightRect(box({ x: 2000 }), 1, NO_SCROLL, IMAGE)).toBeNull();
    expect(highlightRect(box({ x: -900 }), 1, NO_SCROLL, IMAGE)).toBeNull();
    expect(highlightRect(box({ y: -400 }), 1, NO_SCROLL, IMAGE)).toBeNull();
  });

  it('refuses anything that is not a number', () => {
    expect(highlightRect(box({ x: NaN }), 1, NO_SCROLL, IMAGE)).toBeNull();
    expect(highlightRect(box(), 1, { x: 0, y: Infinity }, IMAGE)).toBeNull();
  });
});

/**
 * A box that hangs off an edge is still the right element — only part of it was
 * on screen. That one is clamped rather than dropped, so the visible part is
 * highlighted and no coordinate is drawn outside the image.
 */
describe('boxes that only partly fit', () => {
  it('clamps the padding that would fall outside the top-left corner', () => {
    expect(highlightRect(box({ x: 0, y: 0, width: 10, height: 10 }), 1, NO_SCROLL, IMAGE)).toEqual({
      x: 0,
      y: 0,
      w: 14,
      h: 14,
    });
  });

  it('clamps an element half off the bottom-right', () => {
    const rect = highlightRect(box({ x: 900, y: 750, width: 300, height: 300 }), 1, NO_SCROLL, IMAGE);
    expect(rect).toEqual({ x: 896, y: 746, w: 104, h: 54 });
    expect(rect!.x + rect!.w).toBeLessThanOrEqual(IMAGE.w);
    expect(rect!.y + rect!.h).toBeLessThanOrEqual(IMAGE.h);
  });
});


/**
 * The wash inside the box is the stroke, and cannot be anything else.
 *
 * The stroke is a setting because red is invisible on a red error banner.
 * Phase 0 called the fill a real gap rather than a judgement call: a fill that
 * stayed red while the stroke went green is a green box with a red middle, and
 * a *second* colour control would let somebody produce that on purpose by
 * accident. Phase 3 ruled that the answer is derivation, and this is the test
 * that the derivation actually happens — the only place the two colours could
 * ever come apart is gone, so what is left to check is that the arithmetic is
 * right and that the parse is total over what `resolve` can hand it.
 */
describe('the highlight fill is the stroke, at 8% alpha', () => {
  it('is the colour that used to be the hardcoded ANNOTATION_FILL', () => {
    // The literal this replaced, character for character. Wiring the setting
    // must not have moved the default recording's appearance by one shade.
    expect(fillFor(ANNOTATION_STROKE)).toBe('rgba(255, 59, 48, 0.08)');
  });

  it('follows the stroke wherever it goes', () => {
    expect(fillFor('#00FF00')).toBe('rgba(0, 255, 0, 0.08)');
    expect(fillFor('#000000')).toBe('rgba(0, 0, 0, 0.08)');
    expect(fillFor('#ffffff')).toBe('rgba(255, 255, 255, 0.08)');
  });

  it('is total over every value the setting can actually hold', () => {
    // `resolve` is the only thing that reaches this, and the field carries
    // `/^#[0-9a-fA-F]{6}$/` — so anything that is not six hex digits has already
    // become the default before it gets here. Both branches, so the claim is
    // checked rather than assumed.
    for (const attempt of ['#12ab34', '#ABCDEF', 'rebeccapurple', '#fff', '', null, 42]) {
      const held = resolve({ 'annotation.stroke': attempt })['annotation.stroke'];
      expect(fillFor(held)).toMatch(/^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.08\)$/);
    }
  });

  it('leaves a value that is not a colour at the shipped red', () => {
    expect(resolve({ 'annotation.stroke': 'green' })['annotation.stroke']).toBe(
      DEFAULTS['annotation.stroke'],
    );
  });
});


/**
 * The annotator names no colour of its own.
 *
 * `fillFor` is pure and tested above, but the line that *calls* it sits inside
 * `annotateScreenshot`, which needs `OffscreenCanvas` and so cannot be driven
 * here at all. The failure that matters is not the arithmetic — it is somebody
 * putting a literal back, next to the derivation, where it would look
 * deliberate and render a green box with a red middle on every screenshot.
 *
 * Structural, in the spirit of `react-server-guard.test.ts`: the guarantee is
 * about what this file never contains, and the only two colours it is allowed
 * to know are the ones it is handed.
 */
describe('every colour in the annotator arrives as an argument', () => {
  const source = readFileSync(
    resolvePath(dirname(fileURLToPath(import.meta.url)), '../src/background/annotator.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('declares no hex colour', () => {
    expect(source).not.toMatch(/['"`]#[0-9a-fA-F]{3,8}['"`]/);
  });

  it('declares no literal rgb or rgba', () => {
    // `fillFor` builds one from `${r}, ${g}, ${b}` — a template, never digits.
    expect(source).not.toMatch(/rgba?\(\s*\d/);
  });
});
