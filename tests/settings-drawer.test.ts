// @vitest-environment jsdom

/**
 * One store, two views — driven through the second one.
 *
 * The claim is not that the drawer works. It is that the drawer is the *same*
 * settings, drawn by the same primitive, written to the same area: a smaller
 * window onto one store rather than a second settings screen that agrees with
 * the first by coincidence. Two stores would drift, and the drift would be
 * invisible until somebody changed their editor in the panel and found the
 * options page still offering the old one.
 *
 * So what is asserted is mostly *sameness*. The rows carry the same `data-key`
 * the page's do, the same `.setting-row` structure, and the same
 * `chrome.storage.sync` keys come out the other end — which is checkable
 * precisely because neither view builds its own markup.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DRAWER_KEYS } from '../src/ui/settings/view.js';
import { LEGACY_KEY } from '../src/features/settings/migrate.js';
import type * as DrawerModuleShape from '../src/ui/locator/settings-drawer.js';
import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';

let chromeFake: SyncFake;

/** Let the drawer's migration, load and repaint settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/**
 * The drawer's shell, as `src/panel.html` carries it.
 *
 * Four ids and an empty container. The panel's original drawer wrote a label and
 * an input per setting; none of that is here, because every row inside
 * `#settings-rows` is built by `components.ts` and a row the panel drew itself
 * would be a row that can disagree with the page's.
 */
function panelMarkup(): void {
  document.body.replaceChildren();
  const aside = document.createElement('aside');
  aside.id = 'settings-drawer';
  aside.hidden = true;
  const rows = document.createElement('div');
  rows.id = 'settings-rows';
  const close = document.createElement('button');
  close.id = 'settings-close';
  const open = document.createElement('button');
  open.id = 'settings-btn';
  aside.append(rows, close);
  document.body.append(aside, open);
}

function openedOptions(): ReturnType<typeof vi.fn> {
  const chromeGlobal = globalThis as {
    chrome: { runtime: Record<string, unknown>; storage: Record<string, unknown> };
  };
  const spy = vi.fn();
  chromeGlobal.chrome.runtime.openOptionsPage = spy;
  chromeGlobal.chrome.storage.managed = { get: () => Promise.resolve({}) };
  return spy;
}

function managed(policy: Record<string, unknown>): void {
  const chromeGlobal = globalThis as { chrome: { storage: Record<string, unknown> } };
  chromeGlobal.chrome.storage.managed = { get: () => Promise.resolve({ ...policy }) };
}

async function mount(sync: Record<string, unknown> = {}): Promise<NonNullable<Controller>> {
  chromeFake = installChromeSync(sync);
  openedOptions();
  panelMarkup();
  vi.resetModules();
  const controller = await mountDrawer();
  await settle();
  return controller!;
}

type DrawerModule = typeof DrawerModuleShape;
type Controller = ReturnType<DrawerModule['mountSettingsDrawer']>;

async function mountDrawer(): Promise<Controller> {
  const module = await import('../src/ui/locator/settings-drawer.js');
  return module.mountSettingsDrawer();
}

function row(key: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`#settings-rows [data-key="${key}"]`);
  expect(found, `no drawer row for ${key}`).not.toBeNull();
  return found!;
}

function control<T extends HTMLElement>(key: string): T {
  return row(key).querySelector<T>('[data-focus]')!;
}

afterEach(() => {
  chromeFake.restore();
});

describe('what the drawer shows', () => {
  it('is the settings a locate uses, and nothing else', async () => {
    await mount();

    const keys = [...document.querySelectorAll('#settings-rows [data-key]')].map(
      (element) => (element as HTMLElement).dataset.key,
    );
    expect(keys).toEqual([...DRAWER_KEYS]);
  });

  it('names the four the contract froze, plus one toggle per category', () => {
    // Written out rather than derived, because deriving it would be deriving it
    // the same way the code does — and the list is a decision, not a query.
    expect([...DRAWER_KEYS]).toEqual([
      'editor',
      'customEditorTemplate',
      'projectRoot',
      'react.useSourceMaps',
      'locator.hidden.routing',
      'locator.hidden.providers',
      'locator.hidden.react',
      'locator.hidden.styling',
      'locator.hidden.dependency',
    ]);
  });

  it('holds none of the recording settings, which have no bearing on a pick', async () => {
    await mount();
    for (const key of ['recording.maxSteps', 'screenshots.quality', 'mcp.port', 'theme']) {
      expect(document.querySelector(`#settings-rows [data-key="${key}"]`), key).toBeNull();
    }
  });

  it(`draws the page's row, not a second kind of row`, async () => {
    await mount();
    const projectRoot = row('projectRoot');

    // Every slot the options page's row has, in a drawer that has never heard of
    // `settingRow` — because it does not build one, it asks for one.
    expect(projectRoot.classList.contains('setting-row')).toBe(true);
    for (const part of ['__title', '__control', '__description', '__note', '__reset']) {
      expect(projectRoot.querySelector(`.setting-row${part}`), part).not.toBeNull();
    }
  });

  it('offers the way out to everything it does not show', async () => {
    await mount();
    const spy = (globalThis as { chrome: { runtime: { openOptionsPage: () => void } } }).chrome
      .runtime.openOptionsPage;
    document.querySelector<HTMLButtonElement>('.drawer-settings__more')!.click();
    expect(spy).toHaveBeenCalled();
  });
});

describe('writing from the drawer', () => {
  it('puts a value into the same sparse area the page writes', async () => {
    await mount();

    const input = control<HTMLInputElement>('projectRoot');
    input.value = '/Users/dev/app/';
    input.dispatchEvent(new Event('change'));
    await settle();

    // Normalised the same way, because it is the same `normalise`: the trailing
    // slash is off, and nothing but the one key is in the area.
    expect(chromeFake.area()).toEqual({ projectRoot: '/Users/dev/app' });
  });

  it('removes the key again when a toggle goes back to its default', async () => {
    await mount({ 'locator.hidden.routing': false });

    const toggle = control<HTMLInputElement>('locator.hidden.routing');
    toggle.click();
    await settle();

    expect(chromeFake.area()).toEqual({});
  });

  it('reads an existing override into the control and marks the row', async () => {
    await mount({ 'react.useSourceMaps': false });

    expect(control<HTMLInputElement>('react.useSourceMaps').checked).toBe(false);
    expect(row('react.useSourceMaps').dataset.modified).toBe('true');
  });
});

describe('a policy, seen from the panel', () => {
  it('locks the rows an administrator has fixed, and says why', async () => {
    chromeFake = installChromeSync({});
    openedOptions();
    managed({ projectRoot: '/opt/src' });
    panelMarkup();
    vi.resetModules();
    await mountDrawer();
    await settle();

    const locked = row('projectRoot');
    expect(locked.dataset.disabled).toBe('true');
    expect(control<HTMLInputElement>('projectRoot').disabled).toBe(true);
    expect(locked.querySelector<HTMLElement>('.setting-row__note')!.textContent).toContain(
      'organisation',
    );

    // The reset is dead too. A live one would write a value that the policy then
    // overrules, which is a button whose entire effect is to look like it worked.
    expect(locked.querySelector<HTMLButtonElement>('.setting-row__reset')!.disabled).toBe(true);

    // And the drawer says so once, above the list, rather than only in the notes.
    expect(document.querySelector<HTMLElement>('.drawer-settings__policy')!.hidden).toBe(false);
  });

  it('says nothing about a policy on a profile that has none', async () => {
    await mount();
    expect(document.querySelector<HTMLElement>('.drawer-settings__policy')!.hidden).toBe(true);
  });
});

describe('opening and closing', () => {
  it('starts shut and opens on the panel button', async () => {
    const controller = await mount();
    const aside = document.getElementById('settings-drawer')!;

    expect(controller.isOpen()).toBe(false);
    document.getElementById('settings-btn')!.click();
    await settle();
    expect(aside.hidden).toBe(false);

    document.getElementById('settings-close')!.click();
    expect(aside.hidden).toBe(true);
  });
});

describe('the migration, from the surface an upgrading user actually opens', () => {
  /*
   * Somebody coming from the other extension had a panel, not an options page.
   * If the drawer did not migrate, their editor would be back on the default in
   * the one place they were certain to look.
   */
  it('brings a legacy profile forward before the first paint settles', async () => {
    await mount({ [LEGACY_KEY]: { editor: 'zed', projectRoot: '/srv/app' } });

    expect(chromeFake.area()).toEqual({ editor: 'zed', projectRoot: '/srv/app' });
    expect(control<HTMLElement>('projectRoot')).toHaveProperty('value', '/srv/app');
  });
});
