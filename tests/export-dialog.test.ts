// @vitest-environment jsdom

/**
 * One export at a time.
 *
 * The dialog holds a single module-level session, so the guards that keep it
 * from being replaced mid-export are load-bearing: Escape is blocked while busy
 * and Cancel is disabled, but the X closed the dialog through `dialog.close()`,
 * which fires no `cancel` event and so was never seen by that guard. This drives
 * the real controller against the real viewer.html markup, because the bug lived
 * in the wiring rather than in anything a view model could be asked about.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '../src/shared/result.js';
import type { Step } from '../src/shared/types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'src/viewer.html'), 'utf8');
const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';

/** Resolved by each test, so an export can be held open across a second one. */
let settle: (result: Result<string>) => void;
const exportFlow = vi.fn(
  () =>
    new Promise<Result<string>>((res) => {
      settle = res;
    }),
);

const toasts: string[] = [];

vi.mock('../src/features/export/download.js', () => ({
  // The request is not inspected — these tests are about the dialog's own state
  // machine, not what it hands the exporter — so the stub simply drops it.
  exportFlow: () => exportFlow(),
  suggestFilename: () => 'flowsnap-test',
}));

vi.mock('../src/chrome/storage.js', () => ({
  getLocal: () => Promise.resolve({ ok: false as const, error: null }),
  setLocal: () => Promise.resolve({ ok: true as const, value: undefined }),
  // The dialog reads `export.*` on open — an empty sync area resolves to the
  // shipped defaults, which is what these tests have always assumed.
  getSync: () => Promise.resolve({ ok: true as const, value: {} }),
  setSync: () => Promise.resolve({ ok: true as const, value: undefined }),
}));

vi.mock('../src/ui/toast.js', () => ({
  showToast: ({ message }: { message: string }) => void toasts.push(message),
}));

const step = (over: Partial<Step> = {}): Step =>
  ({
    type: 'click',
    url: 'https://app.example.com/orders',
    timestamp: 1_000,
    action: 'Clicked "Save"',
    element: {
      tag: 'button',
      cssSelector: '#save',
      xpath: '/html[1]/body[1]/button[1]',
      boundingBox: null,
    },
    ...over,
  }) as Step;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Let every queued microtask — and `openExport`'s storage read — finish. */
const flush = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

let closes: number;
let openExport: (options: { steps: Step[]; title: string }) => void;

beforeEach(async () => {
  document.body.innerHTML = body;
  toasts.length = 0;
  closes = 0;
  exportFlow.mockClear();

  // jsdom implements the element but not the modal methods.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    closes += 1;
    this.open = false;
  };

  vi.resetModules();
  ({ openExport } = await import('../src/ui/viewer/export-dialog.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function open(title: string): Promise<void> {
  openExport({ steps: [step()], title });
  await flush();
}

describe('the close button obeys the busy guard', () => {
  it('disables the X for as long as Cancel is disabled', async () => {
    await open('Flow A');
    expect(el<HTMLButtonElement>('export-close').disabled).toBe(false);

    el<HTMLButtonElement>('export-run').click();
    await flush();

    // Both doors, or the guard is decoration: `dialog.close()` from script fires
    // no `cancel` event, so the Escape guard never saw the X.
    expect(el<HTMLButtonElement>('export-cancel').disabled).toBe(true);
    expect(el<HTMLButtonElement>('export-close').disabled).toBe(true);

    settle({ ok: true, value: 'flowsnap-test.zip' });
    await flush();

    expect(el<HTMLButtonElement>('export-close').disabled).toBe(false);
  });
});

describe('a finished export never speaks for the flow that replaced it', () => {
  it('leaves the second flow’s dialog alone when the first one lands', async () => {
    await open('Flow A');
    el<HTMLButtonElement>('export-run').click();
    await flush();

    const finishA = settle;

    // B opens over the top — `openExport` replaces the module-level session.
    await open('Flow B');
    const closesBeforeA = closes;

    finishA({ ok: true, value: 'flow-a.zip' });
    await flush();

    // A's completion used to close B's dialog mid-package and toast A's file.
    expect(closes).toBe(closesBeforeA);
    expect(toasts).not.toContain('Saved flow-a.zip.');
    expect(el<HTMLDialogElement>('export-dialog').open).toBe(true);
  });

  it('still reports the export that is actually on screen', async () => {
    await open('Flow A');
    el<HTMLButtonElement>('export-run').click();
    await flush();

    settle({ ok: true, value: 'flow-a.zip' });
    await flush();

    expect(toasts).toContain('Saved flow-a.zip.');
  });
});
