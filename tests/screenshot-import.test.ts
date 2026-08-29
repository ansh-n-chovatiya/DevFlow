/**
 * Replacing a step's screenshot with one the user supplies.
 *
 * The recorder captures on a timer, and a timer misses things — a menu that
 * closed on blur, a toast that lasted 800ms. The step is still right; only its
 * picture is wrong. What is tested here is everything that decision touches
 * besides the canvas: what is refused before decoding, how big the result is
 * allowed to be, which entry in a drop or a paste is the one we want, and the
 * three fields that have to move together on the step itself.
 */

import { describe, expect, it } from 'vitest';
import { withImportedScreenshot } from '../src/core/flow/index.js';
import {
  checkPixelBudget,
  fitWithin,
  firstImage,
  MAX_EDGE,
  MAX_FILE_BYTES,
  MAX_PIXELS,
  validateImageFile,
} from '../src/features/screenshots/import.js';
import type { BoundingBox, Step } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;
const BOX: BoundingBox = { x: 10, y: 20, width: 100, height: 40 };

function step(over: Partial<Step> = {}): Step {
  return {
    type: 'click',
    url: 'https://shop.example.com/cart',
    timestamp: NOW,
    action: 'Clicked "Buy"',
    element: { tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null },
    ...over,
  } as Step;
}

describe('what is refused, and why', () => {
  it('accepts the image types a screenshot actually arrives as', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/avif']) {
      expect(validateImageFile({ type, size: 1024 }).ok, type).toBe(true);
    }
  });

  it('refuses a non-image, naming the file so the message is actionable', () => {
    const result = validateImageFile({ type: 'application/pdf', size: 1024, name: 'flow.pdf' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('flow.pdf');
  });

  /**
   * An SVG is an image the way a web page is an image: it can carry script and
   * fetch remote content, and it would be drawn by the same engine that renders
   * the page it is drawn into.
   */
  it('refuses SVG even though it passes the image/ prefix', () => {
    expect(validateImageFile({ type: 'image/svg+xml', size: 1024 }).ok).toBe(false);
  });

  it('refuses a file too large to decode without taking the tab down', () => {
    expect(validateImageFile({ type: 'image/png', size: MAX_FILE_BYTES + 1 }).ok).toBe(false);
    expect(validateImageFile({ type: 'image/png', size: MAX_FILE_BYTES }).ok).toBe(true);
  });

  it('refuses an empty file rather than producing a blank screenshot', () => {
    expect(validateImageFile({ type: 'image/png', size: 0 }).ok).toBe(false);
  });
});

/**
 * The byte cap bounds the *compressed* file and nothing else, and the two are
 * barely related: a 200KB PNG of 30000x30000 flat pixels is well inside every
 * byte check and decodes to about 3.6GB, which is the viewer tab gone along
 * with any review the user had not saved. `fitWithin` cannot help — it runs
 * after the decode, and bounds only what is kept.
 */
describe('what the byte cap does not bound', () => {
  it('refuses a decompression bomb that passes every byte check', () => {
    expect(validateImageFile({ type: 'image/png', size: 200 * 1024 }).ok).toBe(true);
    expect(checkPixelBudget(30_000, 30_000).ok).toBe(false);
  });

  it('accepts the screenshots people actually import', () => {
    expect(checkPixelBudget(3840, 2160).ok).toBe(true); // a 4K capture
    expect(checkPixelBudget(6016, 3384).ok).toBe(true); // a 6K retina display
    expect(checkPixelBudget(3000, 8000).ok).toBe(true); // a long scrolling capture
  });

  it('draws the line at the budget itself', () => {
    expect(checkPixelBudget(MAX_PIXELS / 1000, 1000).ok).toBe(true);
    expect(checkPixelBudget(MAX_PIXELS / 1000, 1001).ok).toBe(false);
  });

  it('says how big the image is and how big it may be', () => {
    const refused = checkPixelBudget(30_000, 30_000, 'poster.png');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain('poster.png');
    expect(refused.error.message).toContain('30000');
    expect(refused.error.message).toContain('40 megapixel');
  });
});

describe('the size it is stored at', () => {
  it('leaves anything already within the bound alone', () => {
    expect(fitWithin(1440, 900)).toEqual({ width: 1440, height: 900 });
  });

  it('never enlarges — the pixels are not there to add', () => {
    expect(fitWithin(320, 200)).toEqual({ width: 320, height: 200 });
  });

  it('scales the longest edge down to the bound, keeping the ratio', () => {
    const fitted = fitWithin(8000, 4000);

    expect(Math.max(fitted.width, fitted.height)).toBe(MAX_EDGE);
    expect(fitted.width / fitted.height).toBeCloseTo(2, 5);
  });

  it('bounds a tall image by its height, not its width', () => {
    const fitted = fitWithin(1000, 6000);

    expect(fitted.height).toBe(MAX_EDGE);
    expect(fitted.width).toBeLessThan(MAX_EDGE);
  });

  it('never rounds a thin image away to nothing', () => {
    expect(fitWithin(9000, 1).height).toBe(1);
  });

  it('survives a zero-sized image instead of dividing by it', () => {
    expect(fitWithin(0, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe('picking the image out of a drop or a paste', () => {
  /**
   * A paste from a screenshot tool carries the image alongside plain text, and
   * a drag out of a browser carries an HTML fragment — taking the first entry
   * would fail on both.
   */
  it('skips past the text a clipboard carries alongside the image', () => {
    const picked = firstImage([
      { type: 'text/plain', size: 12 },
      { type: 'text/html', size: 40 },
      { type: 'image/png', size: 2048, name: 'shot.png' },
    ]);

    expect(picked?.name).toBe('shot.png');
  });

  it('takes the first image when there are several', () => {
    const picked = firstImage([
      { type: 'image/png', size: 1, name: 'first.png' },
      { type: 'image/jpeg', size: 1, name: 'second.jpg' },
    ]);

    expect(picked?.name).toBe('first.png');
  });

  it('reports nothing rather than guessing when there is no image', () => {
    expect(firstImage([{ type: 'text/plain', size: 12 }])).toBeNull();
    expect(firstImage([])).toBeNull();
  });
});

describe('the step that comes back', () => {
  it('carries the new image', () => {
    expect(withImportedScreenshot(step(), 'data:image/jpeg;base64,AAA').screenshot).toBe(
      'data:image/jpeg;base64,AAA',
    );
  });

  /**
   * The annotator bases on `screenshotOriginal` where there is one. Leaving the
   * old one behind means opening the editor on a replaced step silently reverts
   * to the picture that was replaced.
   */
  it('drops the un-annotated original of the image it replaced', () => {
    const before = step({ screenshot: 'data:old', screenshotOriginal: 'data:older' });
    const after = withImportedScreenshot(before, 'data:new');

    expect(after.screenshotOriginal).toBeUndefined();
  });

  /** The box is in the replaced capture's coordinate space. */
  it('drops the capture-time highlight box', () => {
    const after = withImportedScreenshot(step({ highlightBox: BOX }), 'data:new');
    expect(after.highlightBox).toBeNull();
  });

  it('records that the image was supplied rather than captured', () => {
    expect(withImportedScreenshot(step(), 'data:new').screenshotImported).toBe(true);
  });

  it('keeps everything that made it a step', () => {
    const after = withImportedScreenshot(
      step({ notes: 'the modal was open here', networkCalls: [] }),
      'data:new',
    );

    expect(after.action).toBe('Clicked "Buy"');
    expect(after.url).toBe('https://shop.example.com/cart');
    expect(after.timestamp).toBe(NOW);
    expect(after.notes).toBe('the modal was open here');
  });

  it('leaves the step it was given untouched, so undo has something to restore', () => {
    const before = step({ screenshot: 'data:old', highlightBox: BOX });
    withImportedScreenshot(before, 'data:new');

    expect(before.screenshot).toBe('data:old');
    expect(before.highlightBox).toEqual(BOX);
  });

  /** A step that never had a picture is the main reason this exists. */
  it('works on a step that had no screenshot at all', () => {
    const after = withImportedScreenshot(step(), 'data:new');

    expect(after.screenshot).toBe('data:new');
    expect(after.screenshotImported).toBe(true);
  });
});
