/**
 * The highlight outline lands inside the picture, including at its edges.
 *
 * `highlightRect` clamps the box to the image, and then `strokeRect` centred a
 * `3 × dpr` line on that clamped path — so half the line was outside the rect
 * and, on the sides the clamp had just cut, outside the canvas. The box was
 * drawn with one, two or three edges missing, and it happened exactly where the
 * elements are that live against a page edge: headers, footers, sticky bars,
 * a cookie banner pinned to the bottom. The step still says "this is what you
 * clicked" while pointing at a box that looks broken.
 *
 * Geometry only. The drawing needs `OffscreenCanvas` and a worker; where the
 * ink actually falls is arithmetic, and it is all of the wrongness.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { highlightRect, strokeInside, type Rect } from '../src/background/annotator.js';
import type { BoundingBox } from '../src/shared/types.js';

const IMAGE: Rect = { x: 0, y: 0, w: 1000, h: 800 };
const NO_SCROLL = { x: 0, y: 0 };

/** Where the ink actually falls: the path, grown by half the line each way. */
function inked(outline: { rect: Rect; width: number }): Rect {
  const half = outline.width / 2;
  return {
    x: outline.rect.x - half,
    y: outline.rect.y - half,
    w: outline.rect.w + outline.width,
    h: outline.rect.h + outline.width,
  };
}

describe('the outline stays inside the rect it outlines', () => {
  it('insets the path by half the line, so the ink fills the box exactly', () => {
    const rect: Rect = { x: 100, y: 50, w: 200, h: 80 };

    const outline = strokeInside(rect, 6);

    expect(outline).toEqual({ rect: { x: 103, y: 53, w: 194, h: 74 }, width: 6 });
    expect(inked(outline)).toEqual(rect);
  });

  it('draws nothing outside a box the clamp cut at the top-left corner', () => {
    // Measured at (2, 2): padding alone takes it negative, so `highlightRect`
    // clamps to the image origin and the old stroke put 1.5px at x = −1.5.
    const box: BoundingBox = { x: 2, y: 2, width: 300, height: 40 };
    const rect = highlightRect(box, 1, NO_SCROLL, IMAGE);
    expect(rect).not.toBeNull();
    if (!rect) return;
    expect(rect.x).toBe(IMAGE.x);

    const ink = inked(strokeInside(rect, 3));

    expect(ink.x).toBeGreaterThanOrEqual(IMAGE.x);
    expect(ink.y).toBeGreaterThanOrEqual(IMAGE.y);
  });

  it('draws nothing outside a box the clamp cut at the bottom-right corner', () => {
    const box: BoundingBox = { x: 900, y: 760, width: 200, height: 60 };
    const rect = highlightRect(box, 1, NO_SCROLL, IMAGE);
    expect(rect).not.toBeNull();
    if (!rect) return;
    expect(rect.x + rect.w).toBe(IMAGE.x + IMAGE.w);

    const ink = inked(strokeInside(rect, 3));

    expect(ink.x + ink.w).toBeLessThanOrEqual(IMAGE.x + IMAGE.w);
    expect(ink.y + ink.h).toBeLessThanOrEqual(IMAGE.y + IMAGE.h);
  });

  it('scales with the display, and stays inside at 2×', () => {
    const box: BoundingBox = { x: 0, y: 0, width: 300, height: 40 };
    const rect = highlightRect(box, 2, NO_SCROLL, IMAGE);
    expect(rect).not.toBeNull();
    if (!rect) return;

    const outline = strokeInside(rect, 3 * 2);

    expect(outline.width).toBe(6);
    expect(inked(outline)).toEqual(rect);
  });
});

describe('the drawing path uses it', () => {
  /*
   * Structural, because the canvas call itself needs a worker. The arithmetic
   * above can be perfect while `annotateScreenshot` goes on stroking the
   * clamped rect, and nothing in the suite would notice.
   */
  const source = readFileSync(
    resolvePath(dirname(fileURLToPath(import.meta.url)), '../src/background/annotator.ts'),
    'utf8',
  );

  it('no longer centres the line on the rect the clamp produced', () => {
    expect(source).not.toMatch(/strokeRect\(\s*rect\.x/);
    expect(source).toMatch(/strokeInside\(rect,/);
  });
});

describe('a box thinner than the line it is drawn with', () => {
  it('narrows the line rather than spilling out of a 2px sliver', () => {
    // A box clamped down to almost nothing at the edge of the capture. Capping
    // the inset alone would still centre a 6px line on a 2px box.
    const outline = strokeInside({ x: 0, y: 0, w: 2, h: 100 }, 6);

    expect(outline.width).toBe(2);
    expect(inked(outline)).toEqual({ x: 0, y: 0, w: 2, h: 100 });
  });

  it('never returns a negative dimension, which strokeRect would draw as nothing', () => {
    for (const rect of [
      { x: 10, y: 10, w: 1, h: 1 },
      { x: 10, y: 10, w: 3, h: 90 },
      { x: 10, y: 10, w: 90, h: 3 },
    ]) {
      const outline = strokeInside(rect, 6);
      expect(outline.rect.w).toBeGreaterThanOrEqual(0);
      expect(outline.rect.h).toBeGreaterThanOrEqual(0);
      expect(inked(outline)).toEqual(rect);
    }
  });
});
