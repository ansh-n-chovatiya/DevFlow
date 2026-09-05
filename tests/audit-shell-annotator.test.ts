/**
 * What the annotator does with the bitmap it decoded.
 *
 * `tests/annotator-box.test.ts` covers the geometry, which is the pure half and
 * is where a wrong answer is visible. This covers the half that needs a canvas,
 * and the one thing that goes wrong there is invisible: a decoded `ImageBitmap`
 * that is never closed. A 4K capture at DPR 2 decodes to roughly 33 MB, this
 * runs once per step of every recording, and the failure it leaks on — an
 * `OffscreenCanvas` the worker will not allocate — is exactly the one an
 * oversized capture provokes.
 *
 * The three globals are stubbed rather than polyfilled: what is being asserted
 * is the module's own bookkeeping around them, and a real canvas would only
 * make the leak harder to observe.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { annotateScreenshot } from '../src/background/annotator.js';
import { ANNOTATION_STROKE } from '../src/shared/constants.js';

const DATA_URL = 'data:image/jpeg;base64,AAAA';
const BOX = { x: 10, y: 10, width: 100, height: 40 };

interface Globals {
  fetch?: unknown;
  createImageBitmap?: unknown;
  OffscreenCanvas?: unknown;
}

const globals = globalThis as Globals;
const original: Globals = {
  fetch: globals.fetch,
  createImageBitmap: globals.createImageBitmap,
  OffscreenCanvas: globals.OffscreenCanvas,
};

afterEach(() => {
  globals.fetch = original.fetch;
  globals.createImageBitmap = original.createImageBitmap;
  globals.OffscreenCanvas = original.OffscreenCanvas;
  vi.restoreAllMocks();
});

/** Stubs the decode path and returns the `close` spy for the bitmap it hands out. */
function stubDecode(): ReturnType<typeof vi.fn> {
  const close = vi.fn();
  globals.fetch = () => Promise.resolve({ blob: () => Promise.resolve({}) });
  globals.createImageBitmap = () => Promise.resolve({ width: 1000, height: 800, close });
  return close;
}

describe('a canvas the worker will not allocate', () => {
  it('frees the decoded bitmap anyway', async () => {
    const close = stubDecode();
    globals.OffscreenCanvas = class {
      constructor() {
        throw new Error('out of memory');
      }
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      annotateScreenshot(DATA_URL, BOX, 2, 70, ANNOTATION_STROKE),
    ).resolves.toBe(DATA_URL);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('frees it when there is no 2d context either', async () => {
    const close = stubDecode();
    globals.OffscreenCanvas = class {
      getContext(): null {
        return null;
      }
    };

    await expect(
      annotateScreenshot(DATA_URL, BOX, 2, 70, ANNOTATION_STROKE),
    ).resolves.toBe(DATA_URL);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('a box that lands nowhere on the capture', () => {
  it('frees the bitmap before giving the capture back untouched', async () => {
    const close = stubDecode();
    globals.OffscreenCanvas = class {
      getContext(): null {
        return null;
      }
    };

    // Scrolled clean off the image: `highlightRect` returns null, which is the
    // earliest of the three exits and the one that runs on ordinary pages.
    await expect(
      annotateScreenshot(DATA_URL, BOX, 1, 70, ANNOTATION_STROKE, { x: 0, y: 5000 }),
    ).resolves.toBe(DATA_URL);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
