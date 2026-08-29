/**
 * Screenshot annotation, service-worker safe.
 *
 * A worker has no `window`, `document`, `FileReader` or `URL.createObjectURL`,
 * so this uses `OffscreenCanvas` and manual base64 — anything else throws at
 * runtime with an error that looks nothing like the cause.
 */

import type { BoundingBox } from '../shared/types.js';

/** Chunk size for base64 encoding; larger blows the argument limit of `apply`. */
const CHUNK = 0x8000;

/** Padding around the highlight box, in CSS pixels. */
const BOX_PAD = 4;

/** How much of the stroke colour the wash inside the box is worth. */
const FILL_ALPHA = 0.08;

/**
 * The wash inside the highlight box: the stroke colour, at 8% alpha.
 *
 * Derived, never configured. The *stroke* is a setting because red is
 * invisible on a red error banner; a fill that stayed red while the stroke went
 * green would be a green box with a red middle, and a second colour control
 * would only let somebody produce that on purpose by accident. Phase 3 ruled
 * this explicitly and asked whoever wired `annotation.stroke` to derive the
 * fill in the same change. This is that.
 *
 * `resolve()` guarantees `#RRGGBB` — the field carries the pattern, and a value
 * that fails it falls back to the default rather than reaching here — so the
 * parse is total. The `?? 0` is for a caller outside the mechanism, which is a
 * thing only a test can be.
 */
export function fillFor(stroke: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(stroke.slice(at, at + 2), 16) || 0);
  return `rgba(${r}, ${g}, ${b}, ${FILL_ALPHA})`;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

/**
 * How far the page scrolled between measuring the box and taking the picture.
 *
 * `box` is viewport-relative and is measured in the content script at event
 * time; the capture happens at least `SETTLE_DELAY_MS` later. Anything that
 * scrolls in between — a control that calls `scrollIntoView()`, an anchor jump,
 * momentum from the user's own wheel — moves the element out from under its own
 * rect, and the highlight is then drawn over whatever took its place and
 * presented as the thing that was clicked.
 *
 * Both values are `scrollAtCapture - scrollAtMeasurement`, in CSS pixels, and
 * are subtracted from the box. Absent means "nobody measured", which is what
 * every caller that has not been wired up yet says.
 */
export interface ScrollDelta {
  x: number;
  y: number;
}

/** A rect in device pixels, as drawn. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The padded, scroll-corrected rect for a box, clamped to the image — or null
 * when there is nothing worth drawing.
 *
 * Two ways there is nothing. A zero-area box: clicking a `<label>` dispatches a
 * synthetic click on the control it labels, and a `display:none` file input has
 * a rect of all zeros, which drew an 8px red square at `(-4, -4)` — over the
 * site logo, captioned as the element the user clicked. And a box that has
 * scrolled clean off the capture, which clamping alone would smear into a
 * sliver against the nearest edge rather than drawing nowhere.
 */
export function highlightRect(
  box: BoundingBox,
  scale: number,
  scroll: ScrollDelta,
  image: Rect,
): Rect | null {
  const finite = [box.x, box.y, box.width, box.height, scroll.x, scroll.y].every((n) =>
    Number.isFinite(n),
  );
  if (!finite || box.width <= 0 || box.height <= 0) return null;

  const pad = BOX_PAD * scale;
  const left = (box.x - scroll.x) * scale - pad;
  const top = (box.y - scroll.y) * scale - pad;
  const right = left + box.width * scale + pad * 2;
  const bottom = top + box.height * scale + pad * 2;

  const clampedLeft = Math.max(left, image.x);
  const clampedTop = Math.max(top, image.y);
  const clampedRight = Math.min(right, image.x + image.w);
  const clampedBottom = Math.min(bottom, image.y + image.h);

  if (clampedRight <= clampedLeft || clampedBottom <= clampedTop) return null;

  return {
    x: clampedLeft,
    y: clampedTop,
    w: clampedRight - clampedLeft,
    h: clampedBottom - clampedTop,
  };
}

/**
 * Draw a highlight box over the captured element and return a new data URL.
 * `box` is in CSS pixels; `dpr` scales it into the device pixels the screenshot
 * is actually in. `scroll` corrects for the page moving between the two.
 *
 * Returns `dataUrl` itself — the same string, not a copy — whenever nothing was
 * drawn, which is how the caller tells an annotated image from an untouched one.
 */
export async function annotateScreenshot(
  dataUrl: string,
  box: BoundingBox | null,
  dpr: number,
  /**
   * The JPEG quality to re-encode at — the same the capture was taken at, so
   * annotating cannot quietly cost or add quality the recording never chose.
   * Required, and passed by the caller: a value read at import time here would
   * be the compiled-in default forever, whatever the user had set.
   */
  quality: number,
  /**
   * The highlight colour — `annotation.stroke`, and the fill is derived from
   * it. Passed for the same reason `quality` is: a value read at import time
   * would be the compiled-in red forever, whatever the user had set.
   */
  stroke: string,
  scroll?: ScrollDelta | null,
): Promise<string> {
  if (!box) return dataUrl;

  const scale = dpr || 1;
  const delta: ScrollDelta = scroll ?? { x: 0, y: 0 };

  // Cheap enough to check before decoding: a zero-area box is decided by the
  // box alone, and there is no point paying for a bitmap to draw nothing on.
  if (!(box.width > 0) || !(box.height > 0)) return dataUrl;

  /*
   * Every failure below returns the unannotated capture rather than throwing.
   *
   * A decode that fails, a canvas the worker will not hand out, an image too
   * large to allocate — none of them are reasons to lose the step. The caller
   * awaits this inside its capture queue and had no guard of its own, so a throw
   * here propagated out and dropped the whole step with nothing but a
   * `console.error`: no action, no selectors, no network, no console. That is
   * the exact opposite of the rule the worker states everywhere else, that a
   * step with no image still carries everything else it recorded.
   */
  try {
    const source = await (await fetch(dataUrl)).blob();
    const img = await createImageBitmap(source);

    const rect = highlightRect(box, scale, delta, { x: 0, y: 0, w: img.width, h: img.height });
    if (!rect) {
      img.close();
      return dataUrl;
    }

    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      img.close();
      return dataUrl;
    }

    ctx.drawImage(img, 0, 0);
    img.close();

    ctx.fillStyle = fillFor(stroke);
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    ctx.strokeStyle = stroke;
    ctx.lineWidth = 3 * scale;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

    // The same quality the capture itself was taken at. Hardcoding 0.6 here
    // meant re-encoding at a quality the rest of the extension did not agree
    // with, and drifted the moment the constant was tuned.
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
    return await blobToDataUrl(out);
  } catch (error) {
    console.warn('FlowSnap: could not annotate the capture', error);
    return dataUrl;
  }
}
