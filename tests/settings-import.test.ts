// @vitest-environment jsdom

/**
 * The `{}` view, the export, and the five steps of an import — driven the way a
 * person drives them.
 *
 * `settings-file.test.ts` proves the arithmetic: what a file contains, what a
 * plan says, what survives a round trip. This proves the part that arithmetic
 * cannot, which is that **nothing reaches storage without passing the diff**.
 * In one sentence — "Nothing is applied until this is confirmed" —
 * and it is the whole reason import is five steps rather than a file-pick.
 *
 * Against the real controller and a real storage fake, because both halves of
 * every claim here are about storage: that the sync area became what the diff
 * said it would, and that Undo put back exactly what was there before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from '../src/features/settings/fields.js';
import {
  EXPORT_FILENAME,
  SCHEMA,
  defaultsJson,
  serialise,
} from '../src/features/settings/file.js';
import { PENDING_SETTINGS_KEY } from '../src/features/settings/pending.js';
import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';

let chromeFake: SyncFake;
let downloaded: { name: string; blob: Blob } | null = null;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

async function openSettings(
  sync: Record<string, unknown> = {},
  local: Record<string, unknown> = {},
): Promise<void> {
  chromeFake = installChromeSync(sync);
  chromeFake.seedLocal(local);

  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  downloaded = null;

  vi.resetModules();
  await import('../src/ui/settings/main.js');
  await settle();
}

// ── Reaching the parts ───────────────────────────────────────────────────────

function jsonToggle(): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('.appbar .btn')].find((button) =>
    button.textContent?.includes('JSON'),
  )!;
}

async function openJson(): Promise<void> {
  jsonToggle().click();
  await settle();
}

function panes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.json-pane')];
}

function editor(): HTMLTextAreaElement {
  return panes()[1].querySelector<HTMLTextAreaElement>('.json-pane__text')!;
}

async function typeJson(text: string): Promise<void> {
  const area = editor();
  area.value = text;
  area.dispatchEvent(new Event('input'));
  await settle();
}

function applyButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('.json-view__actions .btn--primary')!;
}

function dialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>('.dialog--wide');
}

/**
 * Close a `<dialog>` the way a submit button does.
 *
 * jsdom implements the element but not `method="dialog"` submission, so the
 * button press that would set `returnValue` and fire `close` has to be spelled
 * out. The controller only ever sees the `close` event, which is what makes
 * this a fair stand-in rather than a bypass.
 */
async function press(kind: 'confirm' | 'cancel'): Promise<void> {
  const open = dialog()!;
  open.returnValue = kind;
  open.dispatchEvent(new Event('close'));
  await settle();
}

async function menu(label: string): Promise<void> {
  document.querySelector<HTMLButtonElement>('.menu .btn--icon')!.click();
  [...document.querySelectorAll<HTMLButtonElement>('.menu__item')]
    .find((item) => item.textContent?.includes(label))!
    .click();
  await settle();
}

function toasts(): string[] {
  return [...document.querySelectorAll('.toast__message')].map((node) => node.textContent ?? '');
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.resolve() },
  });

  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };

  /*
   * The export hands a blob to the browser, and jsdom has neither object URLs
   * nor a downloads folder. The blob is caught on the way into
   * `createObjectURL` and the filename on the click that would have saved it —
   * which is also what keeps jsdom from logging a navigation it cannot perform.
   */
  let pending: Blob | null = null;
  URL.createObjectURL = (blob: Blob) => {
    pending = blob;
    return 'blob:flowsnap-test';
  };
  URL.revokeObjectURL = () => undefined;
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
    if (pending) downloaded = { name: this.download, blob: pending };
  };
});

afterEach(() => {
  chromeFake.restore();
  document.body.replaceChildren();
});

// ── The `{}` view ────────────────────────────────────────────────────────────

describe('the two-pane JSON view', () => {
  it('opens on the toggle, and puts the list away while it is open', async () => {
    await openSettings();
    expect(document.querySelector<HTMLElement>('.json-view')!.hidden).toBe(true);

    await openJson();

    expect(document.querySelector<HTMLElement>('.json-view')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.settings__body')!.hidden).toBe(true);
    /*
     * The search box searches rows, and there are none on screen. A control that
     * had quietly stopped working is worse than one that is not there.
     *
     * Two elements since the field moved into the app bar: the field in the bar,
     * and the strip under it that says what a query found. Asserting only the
     * strip would pass on a page that never had a query, which is every page
     * this case opens — so the field is the one that matters here.
     */
    expect(document.querySelector<HTMLElement>('.search__field')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.search')!.hidden).toBe(true);
    expect(jsonToggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the generated defaults on the left, read-only', async () => {
    await openSettings();
    await openJson();

    const [left, right] = panes();
    expect(left.dataset.readonly).toBe('true');
    expect(right.dataset.readonly).toBe('false');

    const defaults = left.querySelector<HTMLTextAreaElement>('.json-pane__text')!;
    expect(defaults.readOnly).toBe(true);
    // You cannot write a sensible override without seeing what you are
    // overriding — so all of them, at the values that ship.
    expect(defaults.value).toBe(defaultsJson());
    expect(JSON.parse(defaults.value)['screenshots.quality']).toBe(DEFAULTS['screenshots.quality']);
  });

  it('shows the sparse overrides on the right, and they are the exported file', async () => {
    await openSettings({ 'screenshots.quality': 20 });
    await openJson();

    // One document, two exits: what the pane holds is byte for byte what
    // Export writes, so "edit this" and "send me your file" cannot diverge.
    expect(editor().value).toBe(serialise({ 'screenshots.quality': 20 }));
    expect(editor().readOnly).toBe(false);
  });

  it('marks a key this version does not have, by line, and says why', async () => {
    await openSettings({ 'recording.futureThing': 7 });
    await openJson();

    const warned = [...panes()[1].querySelectorAll<HTMLElement>('.json-pane__line')].filter(
      (line) => line.dataset.warn === 'true',
    );
    expect(warned).toHaveLength(1);
    expect(warned[0].title).toBe('not a setting in this version');

    // And above the fold as well as in the gutter — the unrecognised key is
    // often the one nobody scrolls to.
    const note = document.querySelector('.json-view__notes .banner--warn')!;
    expect(note.textContent).toContain('kept and ignored, not dropped');
  });

  it('refuses to review a document that does not parse, and names the line', async () => {
    await openSettings();
    await openJson();
    await typeJson('{\n  "$schema": "flowsnap/settings-1",\n  "mcpAutoSend": true\n  "editor": "vim"\n}\n');

    expect(applyButton().disabled).toBe(true);
    const problem = document.querySelector('.json-view__notes .banner--danger')!;
    expect(problem.textContent).toContain('Line 4');
  });

  it('reverts to what is stored, and only offers to while it differs', async () => {
    await openSettings({ 'screenshots.quality': 20 });
    await openJson();

    const revert = document.querySelector<HTMLButtonElement>('.json-view__actions .btn--ghost')!;
    expect(revert.disabled).toBe(true);

    await typeJson('{"mcpAutoSend": true}');
    expect(revert.disabled).toBe(false);

    revert.click();
    await settle();
    expect(editor().value).toBe(serialise({ 'screenshots.quality': 20 }));
  });
});

// ── Export ───────────────────────────────────────────────────────────────────

describe('export', () => {
  it('writes the sparse override object under a name with no date in it', async () => {
    await openSettings({ 'screenshots.quality': 20, mcpAutoSend: true });
    await menu('Export settings');

    expect(downloaded!.name).toBe(EXPORT_FILENAME);
    expect(await downloaded!.blob.text()).toBe(
      serialise({ 'screenshots.quality': 20, mcpAutoSend: true }),
    );
  });

  it('exports twice to the same bytes', async () => {
    await openSettings({ 'screenshots.quality': 20 });
    await menu('Export settings');
    const first = await downloaded!.blob.text();
    await menu('Export settings');
    expect(await downloaded!.blob.text()).toBe(first);
  });

  it('says so when there is nothing but the marker to save', async () => {
    await openSettings();
    await menu('Export settings');

    expect(JSON.parse(await downloaded!.blob.text())).toEqual({ $schema: SCHEMA });
    expect(toasts().join(' ')).toMatch(/have not changed any setting/i);
  });
});

// ── Import ───────────────────────────────────────────────────────────────────

describe('import', () => {
  it('shows the diff and applies nothing until it is confirmed', async () => {
    await openSettings({ 'screenshots.quality': 20 });
    await openJson();
    await typeJson(serialise({ 'screenshots.quality': 45 }));

    applyButton().click();
    await settle();

    const open = dialog()!;
    expect(open.textContent).toContain('1 setting would change');
    const row = open.querySelector('.change-list__row')!;
    expect(row.querySelector('.change-list__key')!.textContent).toBe('screenshots.quality');
    expect(row.querySelector('.change-list__from')!.textContent).toBe('20');
    expect(row.querySelector('.change-list__to')!.textContent).toBe('45');

    // Nothing yet. This is the assertion the whole five-step shape exists for.
    expect(chromeFake.area()['screenshots.quality']).toBe(20);

    await press('cancel');
    expect(chromeFake.area()['screenshots.quality']).toBe(20);
  });

  it('applies on confirmation, and the Undo restores the whole object', async () => {
    await openSettings({ 'screenshots.quality': 20, editor: 'webstorm' });
    await openJson();
    await typeJson(serialise({ 'screenshots.quality': 45 }));

    applyButton().click();
    await settle();
    await press('confirm');

    // The file is the whole configuration: `editor` is not in it, so it goes.
    expect(chromeFake.area()).toEqual({ 'screenshots.quality': 45 });

    document
      .querySelectorAll<HTMLButtonElement>('.toast .btn')
      .forEach((button) => button.click());
    await settle();

    expect(chromeFake.area()).toEqual({ 'screenshots.quality': 20, editor: 'webstorm' });
  });

  it('keeps a key from a newer version that the file knows nothing about', async () => {
    // The silent-deletion failure with the file and the store the other way
    // round: a colleague on an older build sends a file with no such key, and
    // this machine must not lose the setting it synced from its other Chrome.
    await openSettings({ 'screenshots.quality': 20, 'recording.futureThing': 7 });
    await openJson();
    await typeJson(serialise({ 'screenshots.quality': 45 }));

    applyButton().click();
    await settle();
    await press('confirm');

    expect(chromeFake.area()).toEqual({
      'screenshots.quality': 45,
      'recording.futureThing': 7,
    });
  });

  it('says a file that matches changes nothing, rather than offering to apply it', async () => {
    await openSettings({ 'screenshots.quality': 20 });
    await openJson();

    applyButton().click();
    await settle();

    // Unchanged text, so `Review and apply` is not even armed — the pane's own
    // answer to the empty diff, one step earlier than the dialog's.
    expect(applyButton().disabled).toBe(true);

    // Through the picker instead, which is the way a colleague's identical file
    // actually arrives.
    await importFile(serialise({ 'screenshots.quality': 20 }));

    const open = dialog()!;
    expect(open.querySelector('.empty__title')!.textContent).toBe(
      'This file matches your settings',
    );
    expect(open.querySelector('.dialog__footer .btn--primary')).toBeNull();
    expect(open.querySelector('.dialog__footer .btn--secondary')!.textContent).toBe('Close');
  });

  it('marks a value it had to clamp, and reports it even when nothing moved', async () => {
    await openSettings({ 'screenshots.quality': 100 });
    await importFile(serialise({ 'screenshots.quality': 900 }));

    const open = dialog()!;
    expect(open.textContent).toContain('outside the range this version accepts');
    expect(open.querySelector('.empty__title')).not.toBeNull();
  });

  it('reads a file whose $schema is from a newer version rather than refusing it', async () => {
    await openSettings();
    await importFile('{"$schema": "flowsnap/settings-9", "mcpAutoSend": true}');

    const open = dialog()!;
    expect(open.querySelector('.banner--info')!.textContent).toContain('flowsnap/settings-9');
    expect(open.querySelector('.dialog__footer .btn--primary')!.textContent).toBe(
      'Apply 1 setting',
    );

    await press('confirm');
    expect(chromeFake.area()).toEqual({ mcpAutoSend: true });
  });

  it('names the line of a malformed file instead of opening an empty diff', async () => {
    await openSettings();
    await importFile('{"mcpAutoSend": true\n  "editor": "vim"}');

    expect(dialog()).toBeNull();
    expect(toasts().join(' ')).toMatch(/Line 2/);
  });
});

/**
 * Pick a file, the way the OS dialog does.
 *
 * `pickJsonFile` makes a fresh `<input type="file">` per use and discards it, so
 * the input is found by the class it wears and handed a file directly — jsdom
 * has no picker to open and no `FileList` to construct.
 */
async function importFile(text: string): Promise<void> {
  await menu('Import settings');
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {
    value: [new File([text], 'flowsnap-settings.json', { type: 'application/json' })],
  });
  input.dispatchEvent(new Event('change'));
  await settle();
}

// ── Not during a recording ──────────────────────────────────────────────────

describe('an import made while a recording is running', () => {
  it('is refused, states the reason, and offers to wait', async () => {
    await openSettings({ 'screenshots.quality': 20 }, { recordingActive: true });
    await importFile(serialise({ 'screenshots.quality': 45 }));

    const open = dialog()!;
    expect(open.querySelector('.banner--warn')!.textContent).toContain(
      'settings are frozen for its duration',
    );
    // The diff is still shown: what the file would do is exactly what somebody
    // deciding whether to defer it needs to know.
    expect(open.querySelectorAll('.change-list__row')).toHaveLength(1);
    expect(open.querySelector('.dialog__footer .btn--primary')!.textContent).toBe(
      'Apply when this recording stops',
    );
  });

  it('parks the confirmed plan rather than applying it, and says it is waiting', async () => {
    await openSettings({ 'screenshots.quality': 20 }, { recordingActive: true });
    await importFile(serialise({ 'screenshots.quality': 45 }));
    await press('confirm');

    expect(chromeFake.area()['screenshots.quality']).toBe(20);
    expect(chromeFake.local()[PENDING_SETTINGS_KEY]).toEqual({
      overrides: { 'screenshots.quality': 45 },
      changes: 1,
    });

    const waiting = [...document.querySelectorAll('.banner--info')].find((node) =>
      node.textContent?.includes('waiting'),
    )!;
    expect(waiting.textContent).toContain('1 setting will change when this recording stops');
  });

  it('can be taken back before the recording ends', async () => {
    await openSettings({ 'screenshots.quality': 20 }, { recordingActive: true });
    await importFile(serialise({ 'screenshots.quality': 45 }));
    await press('confirm');

    const waiting = [...document.querySelectorAll('.banner--info')].find((node) =>
      node.textContent?.includes('waiting'),
    )!;
    waiting.querySelector<HTMLButtonElement>('.banner__action')!.click();
    await settle();

    expect(chromeFake.local()[PENDING_SETTINGS_KEY]).toBeUndefined();
    expect(chromeFake.area()['screenshots.quality']).toBe(20);
  });
});

describe('the parked import, when the recording stops', () => {
  it('applies exactly the plan that was confirmed, and clears itself', async () => {
    chromeFake = installChromeSync({ 'screenshots.quality': 20, editor: 'webstorm' });
    chromeFake.seedLocal({
      [PENDING_SETTINGS_KEY]: { overrides: { 'screenshots.quality': 45 }, changes: 1 },
    });

    vi.resetModules();
    const { applyPending } = await import('../src/features/settings/pending.js');
    const applied = await applyPending();

    expect(applied.ok && applied.value?.changes).toBe(1);
    expect(chromeFake.area()).toEqual({ 'screenshots.quality': 45 });
    expect(chromeFake.local()[PENDING_SETTINGS_KEY]).toBeUndefined();
  });

  it('does not reapply itself on the next recording that stops', async () => {
    // A file the user confirmed once, quietly reapplying every time they finish
    // recording, is a far worse failure than one import that did not land.
    chromeFake = installChromeSync({});
    chromeFake.seedLocal({
      [PENDING_SETTINGS_KEY]: { overrides: { mcpAutoSend: true }, changes: 1 },
    });

    vi.resetModules();
    const { applyPending } = await import('../src/features/settings/pending.js');
    await applyPending();
    chromeFake.seed({ mcpAutoSend: false });

    const second = await applyPending();
    expect(second.ok && second.value).toBeNull();
    expect(chromeFake.area().mcpAutoSend).toBe(false);
  });

  it('is what the worker does on the transition, not something the page has to be open for', async () => {
    /*
     * Structural, and deliberately so. The ordinary shape of this is that
     * somebody imports, is told to wait, closes the tab, and presses Stop in the
     * popup twenty minutes later — so the promise has to be kept by the one
     * thing still running, and a page test cannot see whether it is.
     */
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(`${process.cwd()}/src/background/index.ts`, 'utf8');
    expect(source).toContain("from '../features/settings/pending.js'");
    expect(source).toMatch(/void applyPending\(\)/);
  });
});
