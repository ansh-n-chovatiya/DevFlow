/**
 * Where the selection box and its label end up.
 *
 * Ported from react-source-locator `tests/overlay.test.ts` @ 6eb7a30, unchanged
 * — the geometry is the half of the overlay that survived the merge untouched,
 * and the guarantee it encodes is the reason: the label must land inside the
 * viewport whatever the target does, because a component highlighted off screen
 * is a highlight the user cannot see, and the arrow on the label is the only
 * thing that tells them which way to scroll.
 *
 * No jsdom. `placeLabel`, `offscreenDirection` and `unionBox` take numbers and
 * return numbers, which is why they are in `overlay.ts` rather than in the
 * drawing code that calls them; keeping them that way is what keeps this file
 * able to enumerate the awkward cases cheaply.
 */

import { describe, expect, it } from 'vitest';
import { offscreenDirection, placeLabel, unionBox, type Box } from '../src/injected/overlay.js';

const VIEWPORT = { width: 1000, height: 800 };
const LABEL = { width: 120, height: 18 };

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe('offscreenDirection', () => {
  it('reports none for a target inside the viewport', () => {
    expect(offscreenDirection(box(100, 100, 200, 50), VIEWPORT)).toBe('none');
  });

  it('reports none for a target only partly visible', () => {
    expect(offscreenDirection(box(-50, -10, 200, 50), VIEWPORT)).toBe('none');
  });

  it('reports up for a target scrolled above the viewport', () => {
    expect(offscreenDirection(box(100, -500, 200, 50), VIEWPORT)).toBe('up');
  });

  it('reports down for a target below the viewport', () => {
    expect(offscreenDirection(box(100, 900, 200, 50), VIEWPORT)).toBe('down');
  });

  it('reports left and right for horizontal overflow', () => {
    expect(offscreenDirection(box(-400, 100, 200, 50), VIEWPORT)).toBe('left');
    expect(offscreenDirection(box(1200, 100, 200, 50), VIEWPORT)).toBe('right');
  });
});

describe('placeLabel', () => {
  it('sits just above the target when there is room', () => {
    const { top, direction } = placeLabel(box(100, 200, 300, 60), LABEL, VIEWPORT);
    expect(direction).toBe('none');
    expect(top).toBeLessThan(200);
    expect(top).toBeGreaterThan(150);
  });

  it('flips below when the target is against the top edge', () => {
    const target = box(100, 2, 300, 60);
    const { top } = placeLabel(target, LABEL, VIEWPORT);
    expect(top).toBeGreaterThanOrEqual(target.bottom);
  });

  it('aligns to the target’s left edge', () => {
    expect(placeLabel(box(240, 300, 300, 60), LABEL, VIEWPORT).left).toBe(240);
  });

  /*
   * The visibility guarantee: whatever the target does, the label must land
   * fully inside the viewport, or hovering an off-screen row tells the user
   * nothing about which component they are on.
   */
  const CASES: [string, Box][] = [
    ['far above', box(100, -5000, 300, 60)],
    ['far below', box(100, 5000, 300, 60)],
    ['far left', box(-5000, 300, 300, 60)],
    ['far right', box(5000, 300, 300, 60)],
    ['past the right edge', box(980, 300, 300, 60)],
    ['past the bottom edge', box(100, 795, 300, 60)],
    ['larger than the viewport', box(-200, -200, 2000, 2000)],
    ['zero-sized at the origin', box(0, 0, 0, 0)],
  ];

  for (const [label, target] of CASES) {
    it(`keeps the label on screen when the target is ${label}`, () => {
      const { left, top } = placeLabel(target, LABEL, VIEWPORT);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(left + LABEL.width).toBeLessThanOrEqual(VIEWPORT.width);
      expect(top + LABEL.height).toBeLessThanOrEqual(VIEWPORT.height);
    });
  }

  it('still returns a placement when the label is wider than the viewport', () => {
    const wide = { width: 2000, height: 18 };
    const { left } = placeLabel(box(100, 100, 50, 50), wide, { width: 300, height: 800 });
    expect(Number.isFinite(left)).toBe(true);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it('reports the direction alongside the clamped position', () => {
    expect(placeLabel(box(100, -900, 300, 60), LABEL, VIEWPORT).direction).toBe('up');
  });
});

describe('unionBox', () => {
  it('returns null for no boxes', () => {
    expect(unionBox([])).toBeNull();
  });

  it('returns the single box unchanged', () => {
    expect(unionBox([box(10, 20, 30, 40)])).toEqual(box(10, 20, 30, 40));
  });

  it('spans every box, so a fragment highlights as one region', () => {
    const merged = unionBox([box(10, 10, 40, 40), box(100, 200, 50, 50)]);
    expect(merged).toEqual({ left: 10, top: 10, right: 150, bottom: 250, width: 140, height: 240 });
  });

  it('ignores zero-sized boxes from undisplayed nodes', () => {
    const merged = unionBox([box(10, 10, 40, 40), box(0, 0, 0, 0)]);
    expect(merged).toEqual(box(10, 10, 40, 40));
  });

  it('returns null when every box is zero-sized', () => {
    expect(unionBox([box(0, 0, 0, 0), box(5, 5, 0, 0)])).toBeNull();
  });
});
