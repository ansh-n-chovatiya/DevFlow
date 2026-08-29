/**
 * A small JPEG of a flow's first screenshot, stored on its index entry.
 *
 * The library row is a list of recordings, and a name plus a step count is not
 * enough to tell two recordings of the same site apart. The full screenshot
 * cannot be used: a 10-flow library would decode ten full-page JPEGs to draw a
 * list, and the index entry would be as large as the flow it indexes. So the
 * image is redrawn once, at save time, at the size the row actually shows.
 */

import {
  THUMBNAIL_HEIGHT,
  THUMBNAIL_QUALITY,
  THUMBNAIL_WIDTH,
} from '../../shared/constants.js';
import type { Step } from '../../shared/types.js';

/**
 * The size and quality one thumbnail is drawn at — `thumbnails.width`,
 * `thumbnails.height` and `thumbnails.quality`.
 *
 * Passed in rather than read here: this module runs wherever a flow is saved,
 * it is driven directly by its tests, and a value read at import would be the
 * compiled-in default however the settings were changed. Defaulted to the
 * shipped answer so every existing call site keeps working unchanged.
 */
export interface ThumbnailSize {
  width: number;
  height: number;
  quality: number;
}

export const DEFAULT_THUMBNAIL: ThumbnailSize = {
  width: THUMBNAIL_WIDTH,
  height: THUMBNAIL_HEIGHT,
  quality: THUMBNAIL_QUALITY,
};

/**
 * The picture a flow's thumbnail is made of: the first step that has one.
 *
 * Exported because the store has to answer "is this flow's thumbnail still of
 * the right picture?" before deciding whether to redraw it, and it cannot
 * answer that from the step count — annotating step 1, or importing an image
 * over it, changes this without changing the count. Keeping the rule here means
 * the question and the drawing cannot drift apart.
 */
export function thumbnailSource(steps: Step[]): string | null {
  return steps.find((step) => Boolean(step.screenshot))?.screenshot ?? null;
}

/**
 * Redraw the first available screenshot at thumbnail size.
 *
 * Resolves to `null` rather than rejecting for every failure — a flow that
 * cannot be thumbnailed is still a flow worth saving, and the library falls back
 * to a placeholder tile.
 */
export function makeThumbnail(
  steps: Step[],
  size: ThumbnailSize = DEFAULT_THUMBNAIL,
): Promise<string | null> {
  const { width: WIDTH, height: HEIGHT, quality: QUALITY } = size;
  const source = thumbnailSource(steps);
  if (!source) return Promise.resolve(null);

  return new Promise((resolve) => {
    const image = new Image();

    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;

      const ctx = canvas.getContext('2d');
      if (!ctx || !image.naturalWidth) {
        resolve(null);
        return;
      }

      // Cover, anchored to the top: a page screenshot's meaning is in its first
      // few hundred pixels, and centring the crop would show the middle of an
      // article instead of the header that identifies the site.
      const scale = Math.max(WIDTH / image.naturalWidth, HEIGHT / image.naturalHeight);
      const drawWidth = image.naturalWidth * scale;
      ctx.drawImage(image, (WIDTH - drawWidth) / 2, 0, drawWidth, image.naturalHeight * scale);

      resolve(canvas.toDataURL('image/jpeg', QUALITY));
    };

    image.onerror = () => resolve(null);
    image.src = source;
  });
}
