// @vitest-environment jsdom

/**
 * The Settings page, driven the way a person drives it.
 *
 * This replaces `settings-markup.test.ts`, which checked that every `el('id')`
 * in the controller had a matching `id=` in `settings.html`. That test existed
 * because a renamed id was a page that was blank from the first line of script,
 * and typecheck, lint and every other test passed regardless. There are no ids
 * and no markup left for it to check — the document is empty and
 * `components.ts` builds the page — so the same failure is caught by running the
 * real controller against a real storage fake and asserting what appears.
 *
 * The claim under test is the phase's own done-condition: **the eight settings
 * that already existed still work end to end.** Each one is found by its key,
 * operated through the DOM, and checked against what actually landed in
 * `chrome.storage.sync`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, FIELDS, WIRED } from '../src/features/settings/fields.js';
import { THEME_MIRROR_KEY } from '../src/shared/constants.js';
import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';

let chromeFake: SyncFake;

/** Let the controller's `load()`, `save()` and repaint settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

async function openSettings(
  sync: Record<string, unknown> = {},
  local: Record<string, unknown> = {},
): Promise<void> {
  chromeFake = installChromeSync(sync);
  chromeFake.seedLocal(local);

  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');

  // Fresh module registry per case: `main.ts` is a script, and its state and its
  // storage listeners are established at import time.
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

/**
 * Choose an enum value the way a person does.
 *
 * The control is no longer a `<select>` whose `value` can be assigned — it is a
 * trigger and a panel of buttons, so the test presses both, which is also the
 * only way to find out that the panel is reachable at all.
 */
function choose(key: string, value: string): void {
  control<HTMLButtonElement>(key).click();
  const option = row(key).querySelector<HTMLButtonElement>(
    `.select__option[data-value="${value}"]`,
  );
  expect(option, `no ${value} option in ${key}`).not.toBeNull();
  option!.click();
}

function search(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('.search__input')!;
}

async function type(value: string): Promise<void> {
  const field = search();
  field.value = value;
  field.dispatchEvent(new Event('input'));
  await settle();
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.resolve() },
  });

  // jsdom implements the element but not the modal methods — and `close` has to
  // fire the event the dialog's own handler is on, or confirming does nothing.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(
    this: HTMLDialogElement,
    value?: string,
  ): void {
    if (value !== undefined) this.returnValue = value;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  chromeFake.restore();
  document.body.replaceChildren();
});

describe('the eight settings that already existed', () => {
  it('all appear on the page, and nothing the extension does not read does', async () => {
    await openSettings();

    const keys = [...document.querySelectorAll<HTMLElement>('[data-key]')].map(
      (node) => node.dataset.key,
    );

    // These eight are the keys users' machines are already synced under. Losing
    // one from the screen strands a value that is still in force.
    for (const key of [
      'theme',
      'reactCapture',
      'reactResolve',
      'projectRoot',
      'editor',
      'customEditorTemplate',
      'mcpServerUrl',
      'mcpAutoSend',
    ]) {
      expect(keys, key).toContain(key);
    }

    // And nothing else: a control whose consumer is not wired yet would look
    // exactly like one that is, and do nothing at all. `wired` in `fields.ts`
    // is what a later phase flips when that stops being true.
    //
    // Tier 1 only, because Advanced is collapsed — see the case below, which is
    // the other half of this one.
    expect(keys.sort()).toEqual(
      WIRED.filter((field) => field.tier === 1)
        .map((field) => field.key)
        .sort(),
    );
  });

  it('draws all seventy-three once Advanced is opened, and not before', async () => {
    /*
     * Phase 6's done-condition, on the real page.
     *
     * Every setting in the table is now wired, and the twenty-eight Tier 2 ones
     * are behind a disclosure that is shut until it is opened — the states
     * table. Opening it adds rows and nothing else: no second header, no second
     * kind of control, which is what `settings-row-shape.test.ts` asserts about
     * their shape and what this asserts about their number.
     */
    await openSettings();
    const shut = document.querySelectorAll('[data-key]').length;

    document.querySelector<HTMLButtonElement>('.advanced__summary')!.click();
    await settle();

    const keys = [...document.querySelectorAll<HTMLElement>('[data-key]')].map(
      (node) => node.dataset.key,
    );

    expect(keys).toHaveLength(FIELDS.length);
    expect(keys.length).toBeGreaterThan(shut);
    expect(keys.sort()).toEqual(WIRED.map((field) => field.key).sort());
    // The one sentence the disclosure has to carry, over the rows rather than in place of them.
    expect(document.querySelector('.advanced .banner')!.textContent).toContain(
      'looks like a failed recording',
    );
  });

  it('reads a stored override into the control, and marks the row', async () => {
    await openSettings({ mcpAutoSend: true, projectRoot: '/code/app' });

    expect(control<HTMLInputElement>('mcpAutoSend').checked).toBe(true);
    expect(control<HTMLInputElement>('projectRoot').value).toBe('/code/app');
    expect(row('projectRoot').dataset.modified).toBe('true');
    expect(row('editor').dataset.modified).toBe('false');
  });

  it('writes a switch through to storage, sparsely', async () => {
    await openSettings();

    const toggle = control<HTMLInputElement>('mcpAutoSend');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await settle();

    // Sparse: one key, not sixty-one. A save that materialised the rest would
    // freeze today's defaults into this profile forever.
    expect(chromeFake.area()).toEqual({ mcpAutoSend: true });
    expect(row('mcpAutoSend').dataset.modified).toBe('true');
  });

  it('removes the key again when the value goes back to the default', async () => {
    await openSettings({ mcpAutoSend: true });

    const toggle = control<HTMLInputElement>('mcpAutoSend');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await settle();

    expect(chromeFake.area()).toEqual({});
  });

  it('takes the trailing slash off a project root before storing it', async () => {
    await openSettings();

    const input = control<HTMLInputElement>('projectRoot');
    input.value = '/code/app/';
    input.dispatchEvent(new Event('change'));
    await settle();

    expect(chromeFake.area()).toEqual({ projectRoot: '/code/app' });
    // Re-queried, not the captured node: the list is rebuilt on every change, so
    // the field the user is looking at is a new element showing what was stored.
    expect(control<HTMLInputElement>('projectRoot').value).toBe('/code/app');
  });

  it('offers the editors from EDITORS and stores the value, not the label', async () => {
    await openSettings();

    const options = [...row('editor').querySelectorAll('.select__option')];
    expect(options.length).toBeGreaterThan(2);
    // Built from the shared table so this extension and its sibling cannot
    // drift into offering different editors.
    expect(options.some((option) => option.textContent === 'VS Code')).toBe(true);

    choose('editor', 'webstorm');
    await settle();
    expect(chromeFake.area()).toEqual({ editor: 'webstorm' });
    // The trigger says what is chosen, in the words the list used.
    expect(control<HTMLElement>('editor').textContent).toContain('WebStorm');
  });

  it('closes the enum panel on Escape without leaving the value changed', async () => {
    await openSettings();

    const trigger = control<HTMLButtonElement>('theme');
    trigger.click();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(chromeFake.area()).toEqual({});
  });

  it('applies the theme to the document and mirrors it, not just to storage', async () => {
    await openSettings();

    choose('theme', 'dark');
    await settle();

    expect(chromeFake.area()).toEqual({ theme: 'dark' });
    // An extension page cannot run an inline script under the default MV3
    // policy, so the mirror is what stops the old theme flashing on next load.
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_MIRROR_KEY)).toBe('dark');
  });

  it('greys the fields that follow the React master switch, and says why', async () => {
    await openSettings({ reactCapture: false });

    for (const key of ['reactResolve', 'projectRoot', 'editor', 'customEditorTemplate']) {
      expect(row(key).dataset.disabled, key).toBe('true');
      expect(control<HTMLInputElement>(key).disabled, key).toBe(true);
      const note = row(key).querySelector<HTMLElement>('.setting-row__note')!;
      expect(note.hidden, key).toBe(false);
      expect(note.textContent, key).toContain('Applies');
    }
  });

  it('warns at the keystroke that an http editor template will be refused', async () => {
    await openSettings({ reactCapture: true, editor: 'custom' });

    const input = control<HTMLInputElement>('customEditorTemplate');
    input.value = 'https://example.com/{path}';
    input.dispatchEvent(new Event('change'));
    await settle();

    const note = row('customEditorTemplate').querySelector<HTMLElement>('.setting-row__note')!;
    expect(note.hidden).toBe(false);
    expect(note.dataset.tone).toBe('danger');
    expect(note.textContent).toContain('app link');
  });
});

describe('the row', () => {
  it('resets to the default from its own button', async () => {
    await openSettings({ mcpAutoSend: true });

    const reset = row('mcpAutoSend').querySelector<HTMLButtonElement>('.setting-row__reset')!;
    expect(reset.disabled).toBe(false);
    reset.click();
    await settle();

    expect(chromeFake.area()).toEqual({});
    expect(control<HTMLInputElement>('mcpAutoSend').checked).toBe(false);
  });

  it('copies the key when the key is clicked', async () => {
    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });

    await openSettings();
    row('mcpServerUrl').querySelector<HTMLButtonElement>('.setting-row__key')!.click();
    await settle();

    expect(copied).toEqual(['mcpServerUrl']);
  });

  it('shows the consequence only once the value is in the range it describes', async () => {
    await openSettings();
    const consequence = () =>
      row('mcpAutoSend').querySelector<HTMLElement>('.setting-row__consequence')!;

    expect(consequence().hidden).toBe(true);

    const toggle = control<HTMLInputElement>('mcpAutoSend');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await settle();

    expect(consequence().hidden).toBe(false);
    expect(consequence().textContent).toContain('leaves the browser');
  });

  it('shows its action button before anything has happened to the row', async () => {
    /*
     * The button is filled in from a per-row map that the controller used to
     * populate lazily — the first time a row was committed, clamped or acted
     * on. So "Test connection" was absent for the person opening Settings to
     * check the address, which is the only person who wants it, and present
     * afterwards for everyone who no longer needs it.
     *
     * It failed silently in the most literal way available: the slot is always
     * in the DOM and state only hides it, so nothing threw and every test that
     * clicked the button first passed.
     */
    await openSettings();
    const button = row('mcpServerUrl').querySelector<HTMLButtonElement>('.setting-row__action')!;

    expect(button.hidden).toBe(false);
    expect(button.textContent).toContain('Test connection');
  });

  it('gives a number box room for the widest value it will accept', async () => {
    /*
     * `2147483648` in a 104px box lost its last digit, and there is nothing on
     * screen to say a value was cut — it just reads as a different number. The
     * width comes from the field's own maximum now, set on every number input
     * so the row stays one shape.
     */
    await openSettings();
    const bytes = control<HTMLInputElement>('mcp.maxFlowBytes');
    const flows = control<HTMLInputElement>('mcp.maxFlows');

    expect(bytes.style.getPropertyValue('--field-chars')).toBe('13');
    expect(flows.style.getPropertyValue('--field-chars')).toBe('6');
  });
});

describe('search and the filter chips', () => {
  it('narrows to the matching group and counts what is left', async () => {
    await openSettings();
    await type('mcp');

    expect(document.querySelector('.search__count')!.textContent).toMatch(/\d+ settings?/);
    // Scoped to the list: `groupHeader` is one function, so the `{}` view's two
    // pane headings wear the same class — which is the point of there being one.
    // Two headings, and the second is the point: three of the settings matching
    // "mcp" are Tier 2, and a search that finds something inside Advanced opens
    // it rather than reporting matches the user cannot see.
    expect(
      [...document.querySelectorAll('.settings__list .group__title')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['Claude and MCP', 'Advanced']);
    expect(document.querySelectorAll('mark.hl').length).toBeGreaterThan(0);
  });

  it('offers a way out when nothing matches', async () => {
    await openSettings();
    await type('retry');

    const empty = document.querySelector('.empty')!;
    expect(empty.textContent).toContain('No setting matches');
    expect(empty.textContent).toContain('Clear search');

    empty.querySelector<HTMLButtonElement>('.btn')!.click();
    await settle();

    expect(document.querySelector('.empty')).toBeNull();
    expect(search().value).toBe('');
  });

  it('turns a typed filter token into a removable chip', async () => {
    await openSettings({ mcpAutoSend: true });
    await type('@modified ');

    // The box holds free text only; the token is now a thing you can see and
    // remove rather than a string you have to re-read.
    expect(search().value).toBe('');
    const chip = document.querySelector('.filter-chip')!;
    expect(chip.textContent).toContain('@modified');
    expect(document.querySelectorAll('[data-key]')).toHaveLength(1);

    chip.querySelector<HTMLButtonElement>('.filter-chip__remove')!.click();
    await settle();
    expect(document.querySelector('.filter-chip')).toBeNull();
    expect(document.querySelectorAll('[data-key]').length).toBeGreaterThan(1);
  });

  it('resets everything shown, from the results row', async () => {
    await openSettings({ mcpAutoSend: true, projectRoot: '/code/app' });
    await type('@modified ');

    const action = document.querySelector<HTMLButtonElement>('.search__actions .btn')!;
    expect(action.textContent).toContain('Reset all 2 shown');
    action.click();
    await settle();

    expect(chromeFake.area()).toEqual({});
  });

  it('does not show a count or a chip row until something is narrowing the list', async () => {
    await openSettings();
    expect(document.querySelector<HTMLElement>('.search__results')!.hidden).toBe(true);

    await type('theme');
    expect(document.querySelector<HTMLElement>('.search__results')!.hidden).toBe(false);
  });
});

describe('the rest of the screen', () => {
  it('says a recording is in progress, and leaves every control editable', async () => {
    await openSettings({}, { recordingActive: true });

    const banner = document.querySelector<HTMLElement>('.recording')!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('apply to the next recording');

    // Why they are not disabled: configuring the next recording
    // while this one runs is a reasonable thing to be doing, and a greyed-out
    // form with no explanation is how somebody concludes the page is broken.
    expect(control<HTMLInputElement>('mcpAutoSend').disabled).toBe(false);
    expect(control<HTMLInputElement>('projectRoot').disabled).toBe(false);
  });

  it('hides that banner when nothing is recording', async () => {
    await openSettings();
    expect(document.querySelector<HTMLElement>('.recording')!.hidden).toBe(true);
  });

  it('keeps the storage figures and the delete control the old page had', async () => {
    await openSettings(
      {},
      {
        savedFlowsMeta: [
          { id: 'flow_1', stepCount: 4 },
          { id: 'flow_2', stepCount: 6 },
        ],
      },
    );

    const storage = document.querySelector('.storage')!;
    expect(storage.textContent).toContain('2 saved flows, 10 steps in total');
    expect(storage.querySelector('.storage__used')!.textContent).not.toBe('—');
    expect(storage.querySelector<HTMLButtonElement>('.btn')!.disabled).toBe(false);
  });

  it('carries the JSON toggle and the three overflow actions', async () => {
    await openSettings();

    // Live since Phase 3, and a toggle rather than a link — `aria-pressed` is
    // what says which of the two views is on.
    const json = [...document.querySelectorAll<HTMLButtonElement>('.appbar .btn')].find((button) =>
      button.textContent?.includes('JSON'),
    )!;
    expect(json.disabled).toBe(false);
    expect(json.getAttribute('aria-pressed')).toBe('false');

    document.querySelector<HTMLButtonElement>('.menu .btn--icon')!.click();
    const items = [...document.querySelectorAll('.menu__item')].map((node) => node.textContent);
    expect(items).toEqual(['Import settings…', 'Export settings', 'Reset all to defaults']);
    for (const item of document.querySelectorAll<HTMLButtonElement>('.menu__item')) {
      expect(item.disabled, item.textContent ?? '').toBe(false);
    }
  });

  it('names what "Reset all" will change before doing it', async () => {
    await openSettings({ mcpAutoSend: true, editor: 'webstorm' });

    document.querySelector<HTMLButtonElement>('.menu .btn--icon')!.click();
    [...document.querySelectorAll<HTMLButtonElement>('.menu__item')]
      .find((item) => item.textContent?.includes('Reset all'))!
      .click();
    await settle();

    const dialog = document.querySelector<HTMLDialogElement>('.dialog')!;
    expect(dialog.textContent).toContain('This clears the 2 settings you have changed');
    // The button names the count and the noun. Never "Confirm" or "OK".
    expect(dialog.textContent).toContain('Reset 2 settings');

    // The shared change list, which the import diff also uses: current value,
    // arrow, incoming value — and the key, because the key is what the settings
    // file and the error messages both name.
    const rows = [...dialog.querySelectorAll('.change-list__row')].map((row) => ({
      key: row.querySelector('.change-list__key')!.textContent,
      from: row.querySelector('.change-list__from')!.textContent,
      to: row.querySelector('.change-list__to')!.textContent,
    }));
    expect(rows).toContainEqual({ key: 'mcpAutoSend', from: 'on', to: 'off' });
    expect(rows).toContainEqual({ key: 'editor', from: 'webstorm', to: DEFAULTS.editor });
  });

  it('empties the override object rather than writing seventy-three defaults into it', async () => {
    /*
     * The mistake the sparse store exists to prevent, and the one place it
     * would be invisible: a reset that *wrote* every default would look
     * identical today and freeze today's numbers into the installation
     * forever — the day a shipped default improves, this user would be the only
     * one who never got it, with a settings file that says they chose the old
     * value.
     *
     * A key from a newer FlowSnap is left where it is. This build has no
     * opinion about it, and "reset the settings I can see" must not silently
     * discard the settings of a version that can see more.
     */
    await openSettings({
      mcpAutoSend: true,
      'screenshots.quality': 20,
      'react.maxFiberWalk': 4000,
      'from.the.future': 'kept',
    });

    document.querySelector<HTMLButtonElement>('.menu .btn--icon')!.click();
    [...document.querySelectorAll<HTMLButtonElement>('.menu__item')]
      .find((item) => item.textContent?.includes('Reset all'))!
      .click();
    await settle();

    document.querySelector<HTMLDialogElement>('.dialog')!.close('confirm');
    await settle();

    expect(chromeFake.area()).toEqual({ 'from.the.future': 'kept' });
    expect(control<HTMLInputElement>('mcpAutoSend').checked).toBe(false);
    expect(row('mcpAutoSend').dataset.modified).toBe('false');
  });
});
