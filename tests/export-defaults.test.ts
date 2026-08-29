// @vitest-environment jsdom

/**
 * The dialog's memory and the configured default are two different things.
 *
 * Phase 4's one rule about the export and send dialogs is that they must not be
 * collapsed: `export.*` in Settings is a standing answer, `exportOptions` in
 * local storage is what happened last time, and people rely on both. The whole
 * of the arithmetic is `features/export/defaults.ts`; the whole of the risk is
 * that either half quietly stops mattering, and both failures look completely
 * normal from the outside — a dialog that opens on *something*.
 *
 * So this drives the real dialogs against the real `viewer.html`, with storage
 * and settings both stubbed, and asserts which of the two answers won.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openingOptions, openingValue } from '../src/features/export/defaults.js';
import { driftFromDefaults } from '../src/ui/viewer/export-view.js';
import type * as SendModule from '../src/features/mcp/send.js';
import type { ExportOptions, Step } from '../src/shared/types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'src/viewer.html'), 'utf8');
const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';

const ALL: ExportOptions = { images: true, network: true, logs: true, react: true };
const NONE: ExportOptions = { images: false, network: false, logs: false, react: false };

// ── The rule, on its own ─────────────────────────────────────────────────────

describe('which of the two answers is the more recent one', () => {
  it('takes the configured default when nothing was remembered', () => {
    expect(openingValue(true, undefined, undefined)).toBe(true);
    expect(openingValue(false, undefined, undefined)).toBe(false);
  });

  it('takes the memory when the default has not moved since it was made', () => {
    // The user unticked a box last time and has not been to Settings. Their
    // choice is the only thing anybody has said about this switch.
    expect(openingValue(true, false, true)).toBe(false);
  });

  it('takes the default when it has moved since the memory was made', () => {
    // The user went to Settings and turned this off. That is more recent than a
    // dialog they clicked through three weeks ago, and a memory that outranked
    // it would make the Settings switch read as broken.
    expect(openingValue(false, true, true)).toBe(false);
  });

  it('takes a memory written before there was anything to compare it to', () => {
    // Upgrading: `exportOptions` exists, `exportOptionsAgainst` does not. The
    // configured default this memory would be compared to is one the user has
    // never seen, so it cannot be the more recent statement of anything.
    expect(openingValue(true, false, undefined)).toBe(false);
  });

  it('decides per switch, not per object', () => {
    const opening = openingOptions(
      { images: false, network: true, logs: true, react: true },
      { images: true, network: false, logs: true, react: true },
      ALL,
    );

    // `images` moved in Settings, so the default wins there. `network` did not,
    // so the memory wins. A whole-object rule would lose one or the other.
    expect(opening).toEqual({ images: false, network: false, logs: true, react: true });
  });
});

// ── What the dialog says about it ────────────────────────────────────────────

describe('the line that says this export is not the usual one', () => {
  it('says nothing when nothing differs', () => {
    expect(driftFromDefaults(ALL, ALL)).toBeNull();
    expect(
      driftFromDefaults(ALL, ALL, { chosen: 'zip', configured: 'zip' }),
    ).toBeNull();
  });

  it('names what differs rather than counting it', () => {
    const drift = driftFromDefaults({ ...ALL, network: false }, ALL);

    // "2 settings differ" is a number somebody has to take on trust, and the
    // one that matters is always the one they had forgotten about.
    expect(drift).toContain('network calls off');
    expect(drift).not.toMatch(/\d+ (setting|difference)/);
  });

  it('covers the format as well as the switches', () => {
    const drift = driftFromDefaults(ALL, ALL, { chosen: 'markdown', configured: 'zip' });

    expect(drift).toContain('Markdown rather than ZIP');
  });
});

// ── The dialogs ──────────────────────────────────────────────────────────────

const step = (): Step => ({
  type: 'click',
  url: 'https://app.example.com/orders',
  timestamp: 1_000,
  action: 'Clicked "Save"',
  element: { tag: 'button', cssSelector: '#save', xpath: '/html/body/button', boundingBox: null },
});

/** The sync area — the overrides the settings mechanism resolves. */
let sync: Record<string, unknown> = {};
/** The local area, holding each dialog's memory and what it was made against. */
let local: Record<string, unknown> = {};
const writes: Record<string, unknown>[] = [];

vi.mock('../src/chrome/storage.js', () => ({
  getLocal: (keys: string | string[]) => {
    const wanted = typeof keys === 'string' ? [keys] : keys;
    const out: Record<string, unknown> = {};
    for (const key of wanted) if (key in local) out[key] = local[key];
    return Promise.resolve({ ok: true as const, value: out });
  },
  setLocal: (patch: Record<string, unknown>) => {
    writes.push(patch);
    Object.assign(local, patch);
    return Promise.resolve({ ok: true as const, value: undefined });
  },
  getSync: () => Promise.resolve({ ok: true as const, value: sync }),
  setSync: () => Promise.resolve({ ok: true as const, value: undefined }),
}));

vi.mock('../src/features/export/download.js', () => ({
  exportFlow: () => new Promise(() => {}),
  suggestFilename: () => 'flowsnap-test',
}));

/*
 * Only `sendFlow` is replaced — a POST that never settles, so the dialog stays
 * in its busy state without a server.
 *
 * Partial, not wholesale. The module is also where the send's own pipeline
 * lives, and `send-view.ts` runs that pipeline to price the context estimate:
 * a mock that returned one function left the dialog unable to paint at all.
 * Keeping the rest real is what this file wants anyway — it is about which
 * switches the dialog opens on, which is a question about the real derivation.
 */
vi.mock('../src/features/mcp/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SendModule>()),
  sendFlow: () => new Promise(() => {}),
}));

vi.mock('../src/ui/toast.js', () => ({ showToast: () => {} }));

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const flush = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

/** Every include row's label and checked state, in the order they are drawn. */
function switches(hostId: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const row of el(hostId).querySelectorAll('label')) {
    const label = row.querySelector('.include__label')?.textContent ?? '';
    out[label] = (row.querySelector('.include__input') as HTMLInputElement).checked;
  }
  return out;
}

let openExport: (o: { steps: Step[]; title: string }) => void;
let openSend: (o: { steps: Step[]; name: string }) => void;

beforeEach(async () => {
  document.body.innerHTML = body;
  sync = {};
  local = {};
  writes.length = 0;
  vi.resetModules();
  openExport = (await import('../src/ui/viewer/export-dialog.js')).openExport;
  openSend = (await import('../src/ui/viewer/send-dialog.js')).openSend;
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.open = true;
  };
});

describe('the export dialog opens on the configured default', () => {
  it('with nothing remembered at all', async () => {
    sync = { 'export.network': false, 'export.format': 'markdown' };
    openExport({ steps: [step()], title: 'Flow' });
    await flush();

    expect(switches('export-includes')['Network calls']).toBe(false);
    expect(el('export-ext').textContent).toBe('.md');
  });

  it('and keeps a per-export choice that the default has not overtaken', async () => {
    // Screenshots were unticked last time, against today's defaults.
    local = { exportOptions: { ...ALL, images: false }, exportOptionsAgainst: ALL };
    openExport({ steps: [step()], title: 'Flow' });
    await flush();

    expect(switches('export-includes').Screenshots).toBe(false);
  });

  it('and lets a changed setting overtake the memory', async () => {
    // The same memory, but the user has since turned console logs off in
    // Settings. The setting is the more recent statement about *that* switch;
    // the screenshots memory is still the more recent one about its own.
    sync = { 'export.logs': false };
    local = { exportOptions: { ...ALL, images: false }, exportOptionsAgainst: ALL };
    openExport({ steps: [step()], title: 'Flow' });
    await flush();

    expect(switches('export-includes')['Console logs']).toBe(false);
    expect(switches('export-includes').Screenshots).toBe(false);
  });
});

describe('the two answers stay two answers', () => {
  it('records what a per-export choice was made against, in the same write', async () => {
    sync = { 'export.network': false };
    openExport({ steps: [step()], title: 'Flow' });
    await flush();

    const box = [...el('export-includes').querySelectorAll('label')].find(
      (row) => row.querySelector('.include__label')?.textContent === 'Network calls',
    );
    const input = box?.querySelector('.include__input') as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    await flush();

    // Both keys, in one write. Two writes would leave a window in which the
    // memory claims to have been made against something it was not, and the
    // pair only means anything together.
    const write = writes.at(-1) ?? {};
    expect((write.exportOptions as ExportOptions).network).toBe(true);
    expect((write.exportOptionsAgainst as ExportOptions).network).toBe(false);
  });

  it('says on screen that this export is not the configured one', async () => {
    local = { exportOptions: { ...ALL, images: false }, exportOptionsAgainst: ALL };
    openExport({ steps: [step()], title: 'Flow' });
    await flush();

    expect(el('export-defaults').textContent).toContain('Not your defaults');
    expect(el('export-defaults').textContent).toContain('screenshots off');
  });

  it('offers the way back, and taking it writes the memory rather than clearing it', async () => {
    local = { exportOptions: { ...ALL, images: false }, exportOptionsAgainst: ALL };
    openExport({ steps: [step()], title: 'Flow' });
    await flush();

    (el('export-defaults').querySelector('button') as HTMLButtonElement).click();
    await flush();

    expect(switches('export-includes').Screenshots).toBe(true);
    expect(el('export-defaults').textContent).toBe('');
    // Written, not cleared. An absent memory would silently take a *new*
    // default the next time one is set, rather than being compared to the old
    // one — which is the whole mechanism, unwound one release later.
    expect(writes.at(-1)?.exportOptions).toEqual(ALL);
    expect(writes.at(-1)?.exportOptionsAgainst).toEqual(ALL);
  });

  it('draws nothing when the dialog is doing what it was told to', async () => {
    openExport({ steps: [step()], title: 'Flow' });
    await flush();

    expect(el('export-defaults').textContent).toBe('');
  });
});

describe('the send dialog keeps its own answer', () => {
  it('opens on `export.send*`, which is not `export.*`', async () => {
    // A ZIP on disk costs nothing to over-pack and a flow in a model's context
    // costs tokens, so the two dialogs ship with different answers. One dialog
    // reading the other's keys would be invisible until somebody noticed their
    // sends had got expensive.
    sync = { 'export.network': true, 'export.sendNetwork': false };
    openSend({ steps: [step()], name: 'Flow' });
    await flush();

    expect(switches('send-includes')['Network calls']).toBe(false);
  });

  it('reads its own memory, against its own defaults', async () => {
    sync = { 'export.sendLogs': false };
    local = { sendOptions: { ...NONE, logs: true }, sendOptionsAgainst: NONE };
    openSend({ steps: [step()], name: 'Flow' });
    await flush();

    // `export.sendLogs` moved from its shipped `false` to… `false`. It has not
    // moved *since the memory was made*, which is the comparison that matters,
    // so the memory holds.
    expect(switches('send-includes')['Console logs']).toBe(true);
  });

  it('says when a send is not the configured one, in the same words', async () => {
    // The memory turned network and console back on, against the shipped send
    // defaults, and nothing has moved in Settings since — so the memory holds
    // and the dialog opens on something its own defaults would not have chosen.
    local = {
      sendOptions: ALL,
      sendOptionsAgainst: { images: true, network: false, logs: false, react: true },
    };
    sync = {};
    openSend({ steps: [step()], name: 'Flow' });
    await flush();

    expect(el('send-defaults').textContent).toContain('Not your defaults');
  });
});
