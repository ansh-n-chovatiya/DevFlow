/**
 * Pixels over a password field, not just its value in the step JSON.
 *
 * `report.md` §3.2 P2: "Only `<input type="password">` values are masked...
 * the pixels themselves preserve anything visibly on-screen." This drives
 * real pixel data through `annotateScreenshot` — a tiny fake `OffscreenCanvas`
 * that keeps an actual RGBA buffer, not a call-count spy — so "redacted" means
 * what it says: the bytes at that region are gone, not just a flag was set.
 *
 * The fakes stand in for `fetch`/`createImageBitmap`/`OffscreenCanvas`, which
 * jsdom/Node do not implement; `blobToDataUrl` itself is real code, unmocked,
 * so the base64 round trip is the module's own.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { annotateScreenshot } from '../src/background/annotator.js';
import { ANNOTATION_STROKE } from '../src/shared/constants.js';
import type { BoundingBox } from '../src/shared/types.js';

const WIDTH = 200;
const HEIGHT = 150;

/** A region distinct from every box used below, so "untouched" has somewhere to mean. */
const UNTOUCHED = { x: 10, y: 10, w: 20, h: 20 };
const PASSWORD_BOX: BoundingBox = { x: 60, y: 60, width: 40, height: 20 };
const HIGHLIGHT_BOX: BoundingBox = { x: 120, y: 10, width: 30, height: 15 };

/**
 * The redaction block's colour: `annotation.stroke`, fully opaque — the
 * annotator names no colour of its own (`tests/annotator-box.test.ts`'s
 * "every colour in the annotator arrives as an argument"), so this is
 * `ANNOTATION_STROKE`'s own channels, not a separately invented black.
 */
const REDACT_COLOUR: [number, number, number] = [
  Number.parseInt(ANNOTATION_STROKE.slice(1, 3), 16),
  Number.parseInt(ANNOTATION_STROKE.slice(3, 5), 16),
  Number.parseInt(ANNOTATION_STROKE.slice(5, 7), 16),
];

/** width|height header (4 bytes each, little-endian) followed by raw RGBA. */
function encodeImage(width: number, height: number, data: Uint8ClampedArray): string {
  const bytes = Buffer.alloc(8 + data.length);
  bytes.writeUInt32LE(width, 0);
  bytes.writeUInt32LE(height, 4);
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(bytes, 8);
  return `data:image/x-devflow-test;base64,${bytes.toString('base64')}`;
}

function decodeBytes(bytes: Buffer): { width: number; height: number; data: Uint8ClampedArray } {
  const width = bytes.readUInt32LE(0);
  const height = bytes.readUInt32LE(4);
  const data = new Uint8ClampedArray(width * height * 4);
  data.set(bytes.subarray(8, 8 + data.length));
  return { width, height, data };
}

/** A source image with a different, identifiable colour in every quadrant-ish region. */
function sourceImage(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      // A gradient, so every pixel in the source is distinguishable from solid
      // black and from every other pixel — a uniform fill couldn't tell a real
      // redaction apart from an accidental one that happened to match the fill.
      data[i] = (x * 3) % 256;
      data[i + 1] = (y * 5) % 256;
      data[i + 2] = (x + y) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

function parseColor(style: string): [number, number, number, number] {
  if (style.startsWith('#')) {
    return [
      Number.parseInt(style.slice(1, 3), 16),
      Number.parseInt(style.slice(3, 5), 16),
      Number.parseInt(style.slice(5, 7), 16),
      255,
    ];
  }
  const m = /rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)/.exec(style);
  if (!m) return [0, 0, 0, 255];
  const [, r, g, b, a] = m;
  return [Number(r), Number(g), Number(b), Math.round((a ? Number(a) : 1) * 255)];
}

class FakeCtx {
  fillStyle = '#000000';
  strokeStyle = '#000000';
  lineWidth = 1;
  readonly data: Uint8ClampedArray;
  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  drawImage(img: { data: Uint8ClampedArray }): void {
    this.data.set(img.data);
  }

  private paint(x: number, y: number, w: number, h: number, style: string): void {
    const [r, g, b, a] = parseColor(style);
    const alpha = a / 255;
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * this.width + xx) * 4;
        this.data[i] = this.data[i] * (1 - alpha) + r * alpha;
        this.data[i + 1] = this.data[i + 1] * (1 - alpha) + g * alpha;
        this.data[i + 2] = this.data[i + 2] * (1 - alpha) + b * alpha;
        this.data[i + 3] = 255;
      }
    }
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.paint(x, y, w, h, this.fillStyle);
  }

  /** Approximated as a filled border, centred on the path like the real stroke. */
  strokeRect(x: number, y: number, w: number, h: number): void {
    const lw = this.lineWidth;
    this.paint(x - lw / 2, y - lw / 2, w + lw, lw, this.strokeStyle);
    this.paint(x - lw / 2, y + h - lw / 2, w + lw, lw, this.strokeStyle);
    this.paint(x - lw / 2, y - lw / 2, lw, h + lw, this.strokeStyle);
    this.paint(x + w - lw / 2, y - lw / 2, lw, h + lw, this.strokeStyle);
  }
}

class FakeOffscreenCanvas {
  private readonly ctx: FakeCtx;
  constructor(
    public readonly width: number,
    public readonly height: number,
  ) {
    this.ctx = new FakeCtx(width, height);
  }
  getContext(kind: string): FakeCtx | null {
    return kind === '2d' ? this.ctx : null;
  }
  convertToBlob(): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> {
    const bytes = Buffer.alloc(8 + this.ctx.data.length);
    bytes.writeUInt32LE(this.width, 0);
    bytes.writeUInt32LE(this.height, 4);
    Buffer.from(this.ctx.data.buffer, this.ctx.data.byteOffset, this.ctx.data.length).copy(
      bytes,
      8,
    );
    return Promise.resolve({
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
    });
  }
}

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

/** Wires the fakes so `annotateScreenshot`'s canvas machinery runs for real, against real bytes. */
function installFakeCanvas(): void {
  globals.fetch = (url: string) =>
    Promise.resolve({
      blob: () => Promise.resolve({ __bytes: Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') }),
    });

  globals.createImageBitmap = (blob: { __bytes: Buffer }) => {
    const { width, height, data } = decodeBytes(blob.__bytes);
    return Promise.resolve({ width, height, data, close: () => undefined });
  };

  globals.OffscreenCanvas = FakeOffscreenCanvas;
}

afterEach(() => {
  globals.fetch = original.fetch;
  globals.createImageBitmap = original.createImageBitmap;
  globals.OffscreenCanvas = original.OffscreenCanvas;
});

function decodeResult(dataUrl: string): { width: number; height: number; data: Uint8ClampedArray } {
  return decodeBytes(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
}

function pixelAt(image: { width: number; data: Uint8ClampedArray }, x: number, y: number): [number, number, number, number] {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

/** True when every pixel inside the region is opaque and exactly `colour`. */
function regionIsSolid(
  image: { width: number; data: Uint8ClampedArray },
  region: { x: number; y: number; w: number; h: number },
  colour: [number, number, number],
): boolean {
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const [r, g, b, a] = pixelAt(image, x, y);
      if (r !== colour[0] || g !== colour[1] || b !== colour[2] || a !== 255) return false;
    }
  }
  return true;
}

describe('redacting a password field in the captured pixels', () => {
  it('paints the password box solid and opaque, leaving the rest of the frame alone', async () => {
    installFakeCanvas();
    const before = sourceImage();
    const dataUrl = encodeImage(WIDTH, HEIGHT, before);

    const out = await annotateScreenshot(dataUrl, null, 1, 100, ANNOTATION_STROKE, null, [
      PASSWORD_BOX,
    ]);

    expect(out).not.toBe(dataUrl);
    const after = decodeResult(out);

    // Criterion 1: the password box's bounding box is now a solid, opaque
    // block — the pixels a viewer would have read as "whatever was visibly
    // there" are gone, replaced uniformly rather than merely tinted.
    expect(
      regionIsSolid(
        after,
        { x: PASSWORD_BOX.x, y: PASSWORD_BOX.y, w: PASSWORD_BOX.width, h: PASSWORD_BOX.height },
        REDACT_COLOUR,
      ),
    ).toBe(true);

    // A region nowhere near the password box is untouched — redaction did not
    // blank the whole frame, only the field.
    const untouchedBefore = pixelAt({ width: WIDTH, data: before }, UNTOUCHED.x, UNTOUCHED.y);
    const untouchedAfter = pixelAt(after, UNTOUCHED.x, UNTOUCHED.y);
    expect(untouchedAfter).toEqual(untouchedBefore);
  });

  it('still highlights an ordinary click box the same as before, with no password box passed', async () => {
    installFakeCanvas();
    const before = sourceImage();
    const dataUrl = encodeImage(WIDTH, HEIGHT, before);

    // Criterion 2: the existing call shape — no `passwordBoxes` argument at
    // all — draws exactly the highlight it always did.
    const out = await annotateScreenshot(dataUrl, HIGHLIGHT_BOX, 1, 100, ANNOTATION_STROKE);

    expect(out).not.toBe(dataUrl);
    const after = decodeResult(out);

    // The would-be password region, never named in this call, is untouched.
    expect(
      regionIsSolid(
        after,
        { x: PASSWORD_BOX.x, y: PASSWORD_BOX.y, w: PASSWORD_BOX.width, h: PASSWORD_BOX.height },
        REDACT_COLOUR,
      ),
    ).toBe(false);

    // The centre of the highlight box picked up the stroke colour's wash — the
    // same painting `annotator-box.test.ts`/`audit-chrome-annotator-stroke.test.ts`
    // already pin the geometry of; this only proves it still ran unannotated by
    // the new parameter.
    const centreX = HIGHLIGHT_BOX.x + Math.floor(HIGHLIGHT_BOX.width / 2);
    const centreY = HIGHLIGHT_BOX.y + Math.floor(HIGHLIGHT_BOX.height / 2);
    const beforePixel = pixelAt({ width: WIDTH, data: before }, centreX, centreY);
    const afterPixel = pixelAt(after, centreX, centreY);
    expect(afterPixel).not.toEqual(beforePixel);
  });

  it('leaves an untouched capture untouched when neither box has anything to draw', async () => {
    installFakeCanvas();
    const before = sourceImage();
    const dataUrl = encodeImage(WIDTH, HEIGHT, before);

    const out = await annotateScreenshot(dataUrl, null, 1, 100, ANNOTATION_STROKE, null, [
      { x: 0, y: 0, width: 0, height: 0 },
      null,
    ]);

    // A zero-area password box is the same "nothing worth drawing" case
    // `highlightRect` already treats a zero-area highlight box as.
    expect(out).toBe(dataUrl);
  });

  it('redacts more than one password-type field in the same frame', async () => {
    installFakeCanvas();
    const before = sourceImage();
    const dataUrl = encodeImage(WIDTH, HEIGHT, before);
    const second: BoundingBox = { x: 10, y: 100, width: 25, height: 15 };

    const out = await annotateScreenshot(dataUrl, null, 1, 100, ANNOTATION_STROKE, null, [
      PASSWORD_BOX,
      second,
    ]);

    const after = decodeResult(out);
    for (const region of [PASSWORD_BOX, second]) {
      expect(
        regionIsSolid(
          after,
          { x: region.x, y: region.y, w: region.width, h: region.height },
          REDACT_COLOUR,
        ),
      ).toBe(true);
    }
  });
});
