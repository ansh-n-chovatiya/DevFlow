// @vitest-environment jsdom

/**
 * The settings row, audited against what a person can actually do to it.
 *
 * Each case here is a bug that was in the shipped screen and looked like
 * nothing: a value that came back different from the one that was typed, a
 * budget that stayed live under a switch that was off, a policy the reset
 * quietly wrote over, and a keyboard that landed at the top of the document
 * every time somebody pressed a button. None of them threw, and every one of
 * them was green.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, FIELDS, type Field } from '../src/features/settings/fields.js';
import { refusedNote, unmetReason } from '../src/ui/settings/view.js';
import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';

let chromeFake: SyncFake;

const field = (key: string): Field =>
  (FIELDS as readonly Field[]).find((entry) => entry.key === key)!;

/** Let the controller's `load()`, `save()` and repaint settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function policy(fixed: Record<string, unknown>): void {
  const global = globalThis as { chrome: { storage: Record<string, unknown> } };
  global.chrome.storage.managed = { get: () => Promise.resolve({ ...fixed }) };
}

async function openSettings(
  sync: Record<string, unknown> = {},
  fixed: Record<string, unknown> = {},
): Promise<void> {
  chromeFake = installChromeSync(sync);
  policy(fixed);

  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');

  vi.resetModules();
  await import('../src/ui/settings/main.js');
  await settle();
}

function row(key: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-key="${key}"]`);
  expect(found, `no row for ${key}`).not.toBeNull();
  return found!;
}

function control<T extends HTMLElement>(key: string): T {
  return row(key).querySelector<T>('[data-focus]')!;
}

function note(key: string): HTMLElement {
  return row(key).querySelector<HTMLElement>('.setting-row__note')!;
}

async function type(value: string): Promise<void> {
  const search = document.querySelector<HTMLInputElement>('.search__input')!;
  search.value = value;
  search.dispatchEvent(new Event('input'));
  await settle();
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.resolve() },
  });
  // jsdom has no layout, so it has no `scrollIntoView` — and the rail calls one
  // straight after the repaint whose focus this file is about.
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  chromeFake.restore();
});

describe('a value the field cannot hold is refused, not swapped', () => {
  /*
   * `resolve()` falls back to the *default* for a string that fails its
   * pattern — there is no nearest legal string to clamp to — and `save()` then
   * removes the key, because a default is not a modification. Written, the two
   * together deleted the address the user already had and said nothing.
   */
  it('keeps the stored MCP address when the typed one has no scheme', async () => {
    await openSettings({ mcpServerUrl: 'http://127.0.0.1:9999' });

    const input = control<HTMLInputElement>('mcpServerUrl');
    input.value = '127.0.0.1:9999';
    input.dispatchEvent(new Event('change'));
    await settle();

    expect(chromeFake.area()).toEqual({ mcpServerUrl: 'http://127.0.0.1:9999' });
    expect(control<HTMLInputElement>('mcpServerUrl').value).toBe('http://127.0.0.1:9999');

    const said = note('mcpServerUrl');
    expect(said.hidden).toBe(false);
    expect(said.dataset.tone).toBe('danger');
    expect(said.textContent).toContain('not saved');
  });

  it('refuses an annotation colour that is not a hex triple', async () => {
    await openSettings();

    const input = control<HTMLInputElement>('annotation.stroke');
    input.value = 'red';
    input.dispatchEvent(new Event('change'));
    await settle();

    expect(chromeFake.area()).toEqual({});
    expect(control<HTMLInputElement>('annotation.stroke').value).toBe(DEFAULTS['annotation.stroke']);
    expect(note('annotation.stroke').textContent).toContain(DEFAULTS['annotation.stroke']);
  });

  it('says nothing about a value the field does accept', () => {
    expect(refusedNote(field('mcpServerUrl'), 'http://localhost:1234')).toBeNull();
    // No pattern, no refusal: a project root is any path, and the empty one is
    // how a user says they have not set it.
    expect(refusedNote(field('projectRoot'), '')).toBeNull();
    expect(refusedNote(field('recording.maxSteps'), 500)).toBeNull();
  });
});

describe('a budget is inert while the capture it budgets is off', () => {
  const off = (key: string, parent: string) =>
    it(`greys ${key} while ${parent} is off`, () => {
      expect(unmetReason(key, { ...DEFAULTS, [parent]: false })).toBeTruthy();
      expect(unmetReason(key, { ...DEFAULTS, [parent]: true })).toBeNull();
    });

  /*
   * `recording.a11y` is the one that shows this is not tidiness: it is the only
   * capture in the table that ships off, so its budget was a live control that
   * did nothing on every fresh install.
   */
  off('recording.a11yNodeCap', 'recording.a11y');
  off('recording.stateSettleMs', 'recording.state');
  off('recording.statePatchOps', 'recording.state');
  off('recording.renderNodeCap', 'recording.renders');
  off('screenshots.minIntervalMs', 'screenshots.capture');
  off('screenshots.paintTimeoutMs', 'screenshots.capture');
  off('screenshots.precaptureTtlMs', 'screenshots.capture');

  it('states the reason rather than only greying the row', () => {
    expect(unmetReason('recording.a11yNodeCap', { ...DEFAULTS, 'recording.a11y': false })).toContain(
      'accessibility',
    );
  });
});

describe('a setting an administrator fixed', () => {
  it('keeps the user’s own value for a key the policy has taken over', async () => {
    /*
     * The row is locked, so it is not one of the settings "Reset all shown"
     * promises to clear — `settingsModel` leaves a locked row out of
     * `shownModified` precisely so the button cannot overstate what it does.
     * The handler built a *second* model that had never been told about the
     * policy, counted the row anyway, and deleted the project root this user
     * had stored under it. The button said one setting and cleared two.
     */
    await openSettings(
      { projectRoot: '/home/me/app', mcpAutoSend: true },
      { projectRoot: '/opt/src' },
    );

    await type('@modified');

    const reset = [...document.querySelectorAll<HTMLButtonElement>('.search__actions .btn')].find(
      (button) => button.textContent?.includes('Reset all'),
    )!;
    expect(reset.textContent).toContain('1');
    reset.click();
    await settle();

    expect(chromeFake.area()).toEqual({ projectRoot: '/home/me/app' });
    // And the policy is still what the row shows, because the policy still wins.
    expect(control<HTMLInputElement>('projectRoot').value).toBe('/opt/src');
    expect(row('projectRoot').dataset.disabled).toBe('true');
  });

  it('does not offer a reset that could only ever be overruled', async () => {
    await openSettings({}, { projectRoot: '/opt/src' });

    const reset = row('projectRoot').querySelector<HTMLButtonElement>('.setting-row__reset')!;
    expect(reset.disabled).toBe(true);
  });
});

describe('the keyboard stays where the person left it', () => {
  it('puts focus back on the control a reset undid', async () => {
    await openSettings({ mcpAutoSend: true });

    const reset = row('mcpAutoSend').querySelector<HTMLButtonElement>('.setting-row__reset')!;
    reset.focus();
    reset.click();
    await settle();

    // The button itself is gone — the row is no longer modified — so the only
    // honest place to land is the switch it just reset.
    expect(document.activeElement).toBe(control<HTMLElement>('mcpAutoSend'));
  });

  it('keeps focus on the Advanced disclosure that opened the section', async () => {
    await openSettings();

    const summary = document.querySelector<HTMLButtonElement>('.advanced__summary')!;
    summary.focus();
    summary.click();
    await settle();

    const after = document.querySelector<HTMLButtonElement>('.advanced__summary')!;
    expect(after.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(after);
  });

  it('keeps focus on the rail row that was used to jump', async () => {
    await openSettings();

    const rail = document.querySelector<HTMLButtonElement>('.rail__item[data-rail="mcp"]')!;
    rail.focus();
    rail.click();
    await settle();

    expect(document.activeElement).toBe(
      document.querySelector<HTMLButtonElement>('.rail__item[data-rail="mcp"]'),
    );
  });
});

describe('a number the row could not use', () => {
  it('says the default came back rather than swapping it in silently', async () => {
    await openSettings({ 'recording.maxSteps': 900 });

    const input = control<HTMLInputElement>('recording.maxSteps');
    input.value = '';
    input.dispatchEvent(new Event('change'));
    await settle();

    expect(control<HTMLInputElement>('recording.maxSteps').value).toBe(
      String(DEFAULTS['recording.maxSteps']),
    );
    // "does not block typing and is not silently corrected" — an empty box
    // landed on the default by a different route and said nothing at all.
    const said = note('recording.maxSteps');
    expect(said.hidden).toBe(false);
    expect(said.textContent).toContain('empty');
    expect(said.textContent).toContain(String(DEFAULTS['recording.maxSteps']));
  });
});

describe('the overflow menu', () => {
  it('closes on Escape and gives the trigger back', async () => {
    await openSettings();

    const trigger = document.querySelector<HTMLButtonElement>('.menu .btn--icon')!;
    trigger.click();
    expect(document.querySelector<HTMLElement>('.menu__panel')!.hidden).toBe(false);

    const item = document.querySelector<HTMLButtonElement>('.menu__item')!;
    item.focus();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector<HTMLElement>('.menu__panel')!.hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});

describe('what the row says to a screen reader', () => {
  it('describes every control by its own description, note and consequence', async () => {
    await openSettings();

    const input = control<HTMLInputElement>('recording.maxSteps');
    const described = input.getAttribute('aria-describedby')!.split(' ');

    for (const id of described) {
      expect(row('recording.maxSteps').querySelector(`#${CSS.escape(id)}`), id).not.toBeNull();
    }
    expect(described).toHaveLength(3);
  });

  it('marks a number outside its range as invalid, not only in red', async () => {
    await openSettings();

    const input = control<HTMLInputElement>('recording.maxSteps');
    expect(input.getAttribute('aria-invalid')).toBe('false');

    input.value = '999999';
    input.dispatchEvent(new Event('input'));

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(row('recording.maxSteps').dataset.invalid).toBe('true');
    expect(note('recording.maxSteps').textContent).toContain('between');
  });
});
