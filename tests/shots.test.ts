/**
 * The screenshot side-table.
 *
 * Two properties matter and neither is visible on screen: a step must come back
 * carrying the image it was captured with, and an image must not outlive the
 * step that named it. The second is the one that fails quietly — a leaked
 * screenshot is 335 KB in a storage area the user is told is 12 MB full, under a
 * key nothing will ever ask for again.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dehydrate,
  hydrate,
  hydrateTail,
  shotKey,
  shotPatch,
  SHOT_PREFIX,
  withoutImages,
} from '../src/features/flows/shots.js';
import type { Step } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

/** Stands in for ~335 KB of base64 without costing the test suite 335 KB. */
const IMAGE = 'data:image/jpeg;base64,AAAA';
const ORIGINAL = 'data:image/jpeg;base64,BBBB';

function step(n: number, over: Partial<Step> = {}): Step {
  return {
    type: 'click',
    url: 'https://shop.example.com/cart',
    timestamp: NOW + n * 1000,
    action: `Clicked "Item ${n}"`,
    stepNumber: n,
    element: { tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null },
    screenshot: IMAGE,
    screenshotOriginal: null,
    ...over,
  } as Step;
}

/** The local area, as much of it as this module touches. */
let area: Record<string, unknown> = {};

beforeEach(() => {
  area = {};
  vi.stubGlobal('chrome', {
    runtime: { lastError: undefined },
    storage: {
      local: {
        get: (keys: string | string[] | null, cb: (items: Record<string, unknown>) => void) => {
          if (keys === null) return cb({ ...area });
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of wanted) if (key in area) out[key] = area[key];
          cb(out);
        },
        set: (items: Record<string, unknown>, cb: () => void) => {
          Object.assign(area, items);
          cb();
        },
        remove: (keys: string | string[], cb: () => void) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete area[key];
          cb();
        },
      },
    },
  });
});

describe('a step and its image', () => {
  it('comes back carrying what it was captured with', async () => {
    const one = step(1, { screenshotOriginal: ORIGINAL });
    Object.assign(area, shotPatch(one, IMAGE, ORIGINAL));

    const [back] = await hydrate([withoutImages(one)]);

    expect(back.screenshot).toBe(IMAGE);
    expect(back.screenshotOriginal).toBe(ORIGINAL);
  });

  it('is stored without the image that would be rewritten on every capture', () => {
    const lean = withoutImages(step(1, { screenshotOriginal: ORIGINAL }));

    expect(lean).not.toHaveProperty('screenshot');
    expect(lean).not.toHaveProperty('screenshotOriginal');
    // Everything that is not an image is still there — this is a move, not a cut.
    expect(lean.action).toBe('Clicked "Item 1"');
    expect(lean.element?.cssSelector).toBe('button');
  });

  it('reads as a capture that failed when there is no image to find', async () => {
    const [back] = await hydrate([withoutImages(step(1))]);

    // The same shape a failed `captureVisibleTab` has always produced. There is
    // no third state for "an image exists somewhere but I could not reach it".
    expect(back.screenshot).toBeNull();
  });

  it('files nothing at all for a step that has no image', () => {
    expect(shotPatch(step(1, { screenshot: null }), null, null)).toBeNull();
  });

  it('keys on identity, so two steps in the same millisecond do not collide', () => {
    const clicked = step(1);
    const navigated = { ...step(1), type: 'navigate' } as Step;

    expect(shotKey(clicked)).not.toBe(shotKey(navigated));
    expect(shotKey(clicked).startsWith(SHOT_PREFIX)).toBe(true);
  });
});

describe('the popup only pays for what it draws', () => {
  it('hydrates the tail and leaves the rest alone', async () => {
    const steps = Array.from({ length: 50 }, (_, i) => step(i + 1));
    for (const one of steps) Object.assign(area, shotPatch(one, IMAGE, null));

    const back = await hydrateTail(steps.map(withoutImages), 3);

    expect(back).toHaveLength(50);
    expect(back.slice(-3).every((s) => s.screenshot === IMAGE)).toBe(true);
    // The other 47 were never read: opening the popup on a long recording must
    // not decode a recording's worth of base64 to draw three pictures.
    expect(back.slice(0, 47).every((s) => s.screenshot === undefined)).toBe(true);
  });
});

describe('an image never outlives its step', () => {
  it('names the image of a step that was deleted', () => {
    const kept = step(1);
    const dropped = step(2);

    const { orphans, shots } = dehydrate([kept], [kept, dropped]);

    expect(orphans).toEqual([shotKey(dropped)]);
    expect(Object.keys(shots)).toEqual([shotKey(kept)]);
  });

  it('names every image when the recording is emptied', () => {
    const steps = [step(1), step(2), step(3)];

    const { orphans } = dehydrate([], steps);

    expect(orphans).toEqual(steps.map(shotKey));
  });

  it('names nothing when a step is merely edited', () => {
    const before = [step(1), step(2)];
    const after = [{ ...before[0], notes: 'the 500 happens here' } as Step, before[1]];

    expect(dehydrate(after, before).orphans).toEqual([]);
  });

  it('keeps the image of a step that arrived after the edit began', () => {
    const edited = step(1);
    const arrivedLater = step(2);

    // `writeCurrent` merges the worker's later capture in; it came from storage
    // and so carries no image, and must not be read as a step that lost one.
    const { shots, orphans } = dehydrate(
      [edited, withoutImages(arrivedLater)],
      [edited, arrivedLater],
    );

    expect(orphans).toEqual([]);
    expect(shots[shotKey(edited)]).toEqual({ s: IMAGE, o: null });
    expect(shots).not.toHaveProperty(shotKey(arrivedLater));
  });
});
