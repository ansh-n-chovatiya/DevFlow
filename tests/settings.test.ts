/**
 * The sibling extension's settings module, re-asserted against the one that
 * replaced it.
 *
 * `react-source-locator/src/panel/settings.ts` and its `tests/settings.test.ts`
 * came across in two pieces. The path and URL half — `EDITORS`,
 * `toAbsolutePath`, `buildEditorUrl` — is `core/locate/editor.ts` and is covered
 * by `tests/react-editor.test.ts`. The *settings* half is this file: the
 * defaults it shipped, the three layers it resolved through, and the set of keys
 * an administrator had fixed.
 *
 * Written against the merged mechanism rather than ported line for line,
 * because a line-for-line port would be a test of a module that no longer
 * exists. What is preserved is every claim the original made. Each one is a
 * behaviour somebody depended on, and the point of writing them out here is
 * that the merge cannot quietly drop one: the store changed shape, the file
 * moved, the type went away, and the *answers* are the same.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULTS,
  HIDDEN_CATEGORIES,
  hiddenKeyFor,
  resolve,
  type Overrides,
} from '../src/features/settings/index.js';
import { EDITORS } from '../src/core/locate/editor.js';
import type * as SettingsModuleShape from '../src/features/settings/index.js';
import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';

/**
 * The `managed` area, bolted onto the shared sync fake.
 *
 * `chrome-sync.ts` does not have one and should not grow one for this: the areas
 * behave differently in the way that matters here — `managed` is read-only to
 * the extension and simply absent on an unmanaged profile — and a fake that
 * pretended otherwise would let a write to it pass.
 */
function installManaged(policy: Record<string, unknown> | 'absent'): void {
  const storage = (globalThis as { chrome: { storage: Record<string, unknown> } }).chrome.storage;
  if (policy === 'absent') {
    delete storage.managed;
    return;
  }
  storage.managed = { get: () => Promise.resolve({ ...policy }) };
}

let chromeFake: SyncFake;

beforeEach(() => {
  chromeFake = installChromeSync({});
});

afterEach(() => {
  chromeFake.restore();
});

type SettingsModule = typeof SettingsModuleShape;

/** The module under test, imported fresh so its storage reads see this fake. */
function settings(): Promise<SettingsModule> {
  return import('../src/features/settings/index.js');
}

describe('the defaults the panel shipped', () => {
  it('hides every framework category out of the box', () => {
    // Upstream asserted `Object.values(DEFAULT_SETTINGS.hidden).every(Boolean)`.
    // Same claim, one key per category — which is the change the sparse store
    // required, and the reason a partially-overridden filter is now expressible.
    expect(HIDDEN_CATEGORIES.length).toBeGreaterThan(0);
    for (const category of HIDDEN_CATEGORIES) {
      const key = hiddenKeyFor(category);
      expect(key, category).toBeDefined();
      expect(DEFAULTS[key!], category).toBe(true);
    }
  });

  it('starts on VS Code, with no template and no project root', () => {
    expect(DEFAULTS.editor).toBe('vscode');
    expect(DEFAULTS.customEditorTemplate).toBe('');
    expect(DEFAULTS.projectRoot).toBe('');
  });

  it('reads source maps for an interactive locate by default', () => {
    expect(DEFAULTS['react.useSourceMaps']).toBe(true);
  });
});

/**
 * The `EDITORS` table is documented as *"kept in step with the sibling
 * extension's table, in the same order, so that someone who has both does not
 * have to learn two lists"*.
 *
 * After the merge nobody has both, and the sentence has stopped being a promise
 * about two products and started being a fact about where the table came from.
 * It is still worth holding: the enum's options are `Object.keys(EDITORS)`, so
 * the order here is the order of the menu somebody has already learned, and a
 * reordering would move every item under a pointer that knows where it is going.
 */
describe('the editor list', () => {
  it('is the eight the panel offered, in the order it offered them', () => {
    expect(Object.keys(EDITORS)).toEqual([
      'vscode',
      'vscode-insiders',
      'cursor',
      'windsurf',
      'webstorm',
      'sublime',
      'zed',
      'custom',
    ]);
  });

  it('ends on Custom, which is what the template field depends on', () => {
    expect(Object.keys(EDITORS).at(-1)).toBe('custom');
    expect(EDITORS.custom.template).toBe('');
  });
});

/**
 * `loadSettings()` was `{ ...DEFAULT_SETTINGS, ...user, ...managed }`, and that
 * spread is the whole of what an enterprise deployment relies on.
 *
 * It is now `resolve(overrides, managed)`, which differs in one way that matters
 * and one that does not. It does not differ in precedence. It does differ in
 * validation: a policy file is hand-written by an administrator and is exactly as
 * capable of holding an editor this build has never heard of as a hand-edited
 * profile is, and the spread would have put that straight into the UI.
 */
describe('the three layers', () => {
  const user: Overrides = { editor: 'cursor', projectRoot: '/home/dev/app' };

  it('falls back to the defaults when nothing is set', () => {
    expect(resolve({}).editor).toBe('vscode');
  });

  it('lets the user override a default', () => {
    expect(resolve(user).editor).toBe('cursor');
    expect(resolve(user).projectRoot).toBe('/home/dev/app');
  });

  it('lets a policy override the user, which is the point of a policy', () => {
    const resolved = resolve(user, { editor: 'webstorm' });
    expect(resolved.editor).toBe('webstorm');
    // Only the key the policy names. An administrator pushing an editor has not
    // said anything about the project root, and taking the whole object would
    // reset one setting as a side effect of fixing another.
    expect(resolved.projectRoot).toBe('/home/dev/app');
  });

  it('clamps a policy value rather than trusting it', () => {
    // The spread this replaced would have put `notepad-9000` on screen as the
    // selected editor and then built no URL from it, which looks like the link
    // being broken rather than like the policy being wrong.
    expect(resolve({}, { editor: 'notepad-9000' }).editor).toBe('vscode');
    expect(resolve({}, { 'react.resolveConcurrency': 9000 })['react.resolveConcurrency']).toBe(32);
  });

  it('is unchanged by a policy that names nothing this build knows', () => {
    expect(resolve(user, { 'some.future.key': 1 })).toEqual(resolve(user));
  });
});

describe('reading the managed area', () => {
  it('is empty, and does not throw, on a profile with no policy at all', async () => {
    installManaged('absent');
    const { loadManaged, managedKeys } = await settings();
    expect(await loadManaged()).toEqual({});
    expect([...(await managedKeys())]).toEqual([]);
  });

  it('names the keys an administrator has fixed, and only those', async () => {
    installManaged({ editor: 'zed', projectRoot: '/opt/src' });
    const { managedKeys } = await settings();
    expect([...(await managedKeys())].sort()).toEqual(['editor', 'projectRoot']);
  });

  it('ignores a policy key this build has no field for', async () => {
    installManaged({ editor: 'zed', 'rst:whatever': true, banana: 1 });
    const { loadManaged } = await settings();
    expect(await loadManaged()).toEqual({ editor: 'zed' });
  });

  /**
   * The policy files already deployed are the old shape, and nothing here can
   * rewrite them: `managed` is read-only to the extension. So the blob is read
   * as well as the flat keys, permanently — an organisation moves to flat keys
   * by editing its own policy, on its own schedule, and until it does the file
   * it already shipped keeps working.
   */
  it('accepts a policy still written in the old blob shape', async () => {
    installManaged({ 'rst:settings': { editor: 'sublime', projectRoot: '/srv/app' } });
    const { loadManaged, managedKeys } = await settings();
    expect(await loadManaged()).toEqual({ editor: 'sublime', projectRoot: '/srv/app' });
    expect([...(await managedKeys())].sort()).toEqual(['editor', 'projectRoot']);
  });

  it('lets a flat key win over the same key inside the blob', async () => {
    installManaged({ 'rst:settings': { editor: 'sublime' }, editor: 'zed' });
    const { loadManaged } = await settings();
    expect((await loadManaged()).editor).toBe('zed');
  });

  it('does not lock a key the blob happened to agree with the default about', async () => {
    // Sparse in the policy layer too: a blob that says `vscode` has not fixed
    // anything, and greying the control would tell the user an administrator
    // made a decision that nobody made.
    installManaged({ 'rst:settings': { editor: 'vscode', projectRoot: '/srv/app' } });
    const { managedKeys } = await settings();
    expect([...(await managedKeys())]).toEqual(['projectRoot']);
  });
});

describe('load() puts the layers together', () => {
  it('resolves storage through the policy, in that order', async () => {
    chromeFake.seed({ editor: 'cursor', projectRoot: '/home/dev/app' });
    installManaged({ editor: 'webstorm' });

    const { load } = await settings();
    const resolved = await load();

    expect(resolved.editor).toBe('webstorm');
    expect(resolved.projectRoot).toBe('/home/dev/app');
  });
});
