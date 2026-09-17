/**
 * Password-box redaction, wired end to end through the worker — not just
 * `annotateScreenshot` in isolation.
 *
 * `tests/audit-screenshot-redaction.test.ts` (unit 17) proves the annotator
 * itself redacts a `passwordBoxes` region when handed one. That unit's own
 * self-reported blocker was that nothing in `src/background/index.ts` called
 * it with one: `writeCapturedStep` built `screenshot` without ever collecting
 * a password field's box, and unconditionally set `screenshotOriginal` to the
 * pre-annotation frame — which, for a redacted step, *is* the unredacted
 * frame, stored under a second key forever.
 *
 * This drives the real `CAPTURE_AND_SAVE_STEP` listener — same worker-harness
 * pattern as `tests/audit-capture-fidelity.test.ts` — over the same fake
 * canvas machinery `tests/audit-screenshot-redaction.test.ts` uses, so
 * "redacted" here means the same thing it means there: actual bytes gone at
 * that region, not a flag.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftStep, Step } from '../src/shared/types.js';
import { ANNOTATION_STROKE } from '../src/shared/constants.js';
import { shotKey } from '../src/features/flows/shots.js';

const WIDTH = 200;
const HEIGHT = 150;

const PASSWORD_BOX = { x: 60, y: 60, width: 40, height: 20 };

const REDACT_COLOUR: [number, number, number] = [
  Number.parseInt(ANNOTATION_STROKE.slice(1, 3), 16),
  Number.parseInt(ANNOTATION_STROKE.slice(3, 5), 16),
  Number.parseInt(ANNOTATION_STROKE.slice(5, 7), 16),
];

/** width|height header (4 bytes each, little-endian) followed by raw RGBA — same wire format `audit-screenshot-redaction.test.ts` uses. */
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

function decodeDataUrl(dataUrl: string): { width: number; height: number; data: Uint8ClampedArray } {
  return decodeBytes(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
}

function sourceImage(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
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
      arrayBuffer: () =>
        Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
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

function installFakeCanvas(): void {
  globals.fetch = (url: string) =>
    Promise.resolve({
      blob: () =>
        Promise.resolve({ __bytes: Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') }),
    });

  globals.createImageBitmap = (blob: { __bytes: Buffer }) => {
    const { width, height, data } = decodeBytes(blob.__bytes);
    return Promise.resolve({ width, height, data, close: () => undefined });
  };

  globals.OffscreenCanvas = FakeOffscreenCanvas;
}

function pixelAt(
  image: { width: number; data: Uint8ClampedArray },
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

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

type Listener = (...args: unknown[]) => unknown;

interface WorkerChrome {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  activeTabId: number;
  captureDataUrl: string;
  listeners: Record<string, Listener[]>;
}

let world: WorkerChrome;

function area(store: Record<string, unknown>): Record<string, unknown> {
  return {
    get(keys: unknown, callback: (items: Record<string, unknown>) => void): void {
      const names =
        keys == null
          ? Object.keys(store)
          : Array.isArray(keys)
            ? (keys as string[])
            : typeof keys === 'string'
              ? [keys]
              : Object.keys(keys);
      const out: Record<string, unknown> = {};
      for (const key of names) if (key in store) out[key] = store[key];
      callback(out);
    },
    set(items: Record<string, unknown>, callback?: () => void): void {
      Object.assign(store, items);
      callback?.();
    },
    remove(keys: unknown, callback?: () => void): void {
      for (const key of Array.isArray(keys) ? (keys as string[]) : [String(keys)]) delete store[key];
      callback?.();
    },
  };
}

function installChrome(): WorkerChrome {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const listeners: Record<string, Listener[]> = {};
  const on = (name: string) => ({
    addListener: (fn: Listener): void => {
      (listeners[name] ??= []).push(fn);
    },
    removeListener: (): void => {},
  });

  const handle: WorkerChrome = {
    local,
    session,
    activeTabId: 1,
    captureDataUrl: encodeImage(WIDTH, HEIGHT, sourceImage()),
    listeners,
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      onMessage: on('message'),
      onConnect: on('connect'),
      onStartup: on('startup'),
      onInstalled: on('installed'),
      getURL: (path: string) => `chrome-extension://devflow/${path}`,
    },
    commands: { onCommand: on('command') },
    storage: {
      local: area(local),
      session: area(session),
      sync: area({}),
      onChanged: on('changed'),
    },
    tabs: {
      onRemoved: on('removed'),
      query(query: { active?: boolean }, callback?: (tabs: unknown[]) => void) {
        const tabs = query.active === true ? [{ id: handle.activeTabId, windowId: 10 }] : [];
        if (callback) {
          callback(tabs);
          return undefined;
        }
        return Promise.resolve(tabs);
      },
      get: (_id: number, callback: () => void) => callback(),
      captureVisibleTab: () => Promise.resolve(handle.captureDataUrl),
    },
    action: {
      setBadgeText: (_a: unknown, cb?: () => void) => cb?.(),
      setBadgeBackgroundColor: (_a: unknown, cb?: () => void) => cb?.(),
      setTitle: (_a: unknown, cb?: () => void) => cb?.(),
    },
  };

  return handle;
}

async function settle(turns = 200): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

async function startWorker(): Promise<void> {
  vi.resetModules();
  await import('../src/background/index.js');
  await settle();
}

function sendMessage(message: Record<string, unknown>, tabId = 1): void {
  const listener = world.listeners.message?.at(-1);
  if (!listener) throw new Error('the worker registered no message listener');
  listener(message, { tab: { id: tabId, windowId: 10, active: true } }, () => {});
}

function seedRecording(): void {
  world.local.recordingActive = true;
  world.local.recordingTabId = 1;
  world.local.recordedSteps = [];
  world.local.recordingSettings = {
    'screenshots.settleDelayMs': 0,
    'screenshots.minIntervalMs': 0,
  };
}

function passwordStep(): DraftStep {
  return {
    type: 'click',
    url: 'https://app.example.com/login',
    timestamp: 2_000,
    action: 'Clicked "Password"',
    element: {
      tag: 'input',
      type: 'password',
      cssSelector: 'input[type=password]',
      xpath: '//input',
      boundingBox: PASSWORD_BOX,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeCanvas();
  world = installChrome();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globals.fetch = original.fetch;
  globals.createImageBitmap = original.createImageBitmap;
  globals.OffscreenCanvas = original.OffscreenCanvas;
});

describe('recording a step on a password field', () => {
  it('stores a redacted screenshot and never stores the unredacted original', async () => {
    seedRecording();
    await startWorker();

    sendMessage({
      type: 'CAPTURE_AND_SAVE_STEP',
      step: passwordStep(),
      elementBox: PASSWORD_BOX,
      dpr: 1,
    });
    await vi.advanceTimersByTimeAsync(10);
    await settle();

    const steps = (world.local.recordedSteps ?? []) as Step[];
    expect(steps).toHaveLength(1);

    const shot = world.local[shotKey(steps[0])] as { s: string | null; o: string | null } | undefined;
    expect(shot).toBeTruthy();
    expect(shot!.s).toBeTruthy();

    // Criterion 1 + end-to-end: the pixels over the password field's own box
    // are the opaque redaction block, not whatever `captureVisibleTab` shot.
    const after = decodeDataUrl(shot!.s!);
    expect(
      regionIsSolid(
        after,
        { x: PASSWORD_BOX.x, y: PASSWORD_BOX.y, w: PASSWORD_BOX.width, h: PASSWORD_BOX.height },
        REDACT_COLOUR,
      ),
    ).toBe(true);

    // Criterion 2: the pre-redaction frame does not survive anywhere in
    // storage under this step's key.
    expect(shot!.o).toBeNull();
  });

  it('leaves a non-password step annotated as before, with no redaction and a real original', async () => {
    seedRecording();
    await startWorker();

    sendMessage({
      type: 'CAPTURE_AND_SAVE_STEP',
      step: {
        type: 'click',
        url: 'https://app.example.com/login',
        timestamp: 2_000,
        action: 'Clicked "Sign in"',
        element: {
          tag: 'button',
          type: 'submit',
          cssSelector: 'button',
          xpath: '//button',
          boundingBox: { x: 10, y: 10, width: 30, height: 15 },
        },
      },
      elementBox: { x: 10, y: 10, width: 30, height: 15 },
      dpr: 1,
    });
    await vi.advanceTimersByTimeAsync(10);
    await settle();

    const steps = (world.local.recordedSteps ?? []) as Step[];
    const shot = world.local[shotKey(steps[0])] as { s: string | null; o: string | null };

    const after = decodeDataUrl(shot.s!);
    expect(
      regionIsSolid(
        after,
        { x: PASSWORD_BOX.x, y: PASSWORD_BOX.y, w: PASSWORD_BOX.width, h: PASSWORD_BOX.height },
        REDACT_COLOUR,
      ),
    ).toBe(false);
    // The highlight changed the image, so the original is kept for the editor.
    expect(shot.o).toBeTruthy();
  });
});

describe('ANNOTATE_SCREENSHOT re-annotating a password step', () => {
  it('keeps the redaction when recolouring the highlight', async () => {
    seedRecording();
    await startWorker();

    sendMessage({
      type: 'CAPTURE_AND_SAVE_STEP',
      step: passwordStep(),
      elementBox: PASSWORD_BOX,
      dpr: 1,
    });
    await vi.advanceTimersByTimeAsync(10);
    await settle();

    const steps = (world.local.recordedSteps ?? []) as Step[];
    const shot = world.local[shotKey(steps[0])] as { s: string | null; o: string | null };
    const redactedScreenshot = shot.s!;

    // Recolouring: the viewer re-sends this step's own (already redacted)
    // image with a highlight box to draw, and reads the response back.
    const reannotated = await (async () => {
      const listener = world.listeners.message?.at(-1);
      if (!listener) throw new Error('no listener');
      return new Promise<{ screenshot: string | null }>((resolve) => {
        listener(
          { type: 'ANNOTATE_SCREENSHOT', screenshot: redactedScreenshot, box: PASSWORD_BOX, dpr: 1 },
          { tab: { id: 1, windowId: 10, active: true } },
          resolve,
        );
      });
    })();
    await settle();

    expect(reannotated.screenshot).toBeTruthy();
    const after = decodeDataUrl(reannotated.screenshot!);
    expect(
      regionIsSolid(
        after,
        { x: PASSWORD_BOX.x, y: PASSWORD_BOX.y, w: PASSWORD_BOX.width, h: PASSWORD_BOX.height },
        REDACT_COLOUR,
      ),
    ).toBe(true);
  });
});
