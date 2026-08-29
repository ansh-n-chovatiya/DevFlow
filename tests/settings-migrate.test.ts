/**
 * The one-time migration, and the four ways it could lose somebody's settings.
 *
 * This is the test the divergence exists for. An upgrade that drops the other
 * extension's storage shape fails *silently*: nothing throws, no console line,
 * every other test stays green, and the first thing the user notices is a source
 * link opening the wrong machine's file — or no link at all, because their
 * project root has quietly gone back to empty. There is no way to find that
 * except to write down what an existing profile looks like and assert what
 * happens to it.
 *
 * So the blobs below are realistic rather than minimal. A 2.x profile with a
 * partially-overridden filter, a pre-2.0 profile with the single boolean the
 * filter replaced, a profile in the middle of the changeover carrying both, and
 * a profile whose owner never changed anything — which is the majority case, and
 * the one where writing something would be the bug.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { legacyOverrides, LEGACY_KEY } from '../src/features/settings/migrate.js';
import { DEFAULTS } from '../src/features/settings/fields.js';
import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';

let chromeFake: SyncFake;

beforeEach(() => {
  chromeFake = installChromeSync({});
});

afterEach(() => {
  chromeFake.restore();
});

async function migrate(): Promise<readonly string[]> {
  const { migrateLegacySettings } = await import('../src/features/settings/index.js');
  return migrateLegacySettings();
}

/** A profile as the sibling extension's 2.x actually wrote it. */
const REALISTIC = {
  editor: 'cursor',
  customEditorTemplate: '',
  projectRoot: '/Users/dev/work/storefront',
  useSourceMaps: false,
  hidden: { routing: false, providers: true, react: true, styling: true, dependency: false },
};

// ── The mapping, on its own ──────────────────────────────────────────────────

describe('the mapping', () => {
  it('is total over a realistic 2.x blob, and sparse', () => {
    expect(legacyOverrides(REALISTIC)).toEqual({
      editor: 'cursor',
      projectRoot: '/Users/dev/work/storefront',
      'react.useSourceMaps': false,
      'locator.hidden.routing': false,
      'locator.hidden.dependency': false,
    });
    // `customEditorTemplate` and the three categories left on are absent, not
    // false-y — they equal the shipped default, and materialising them would
    // freeze today's answer into the profile for good.
  });

  it('upgrades the pre-2.0 boolean into every category', () => {
    // The precedent this follows: the panel's own `coerce()` did the same thing
    // one shape earlier, and dropping it here would make somebody who never
    // opened the old settings screen lose the same choice twice.
    expect(legacyOverrides({ hideFrameworkComponents: false })).toEqual({
      'locator.hidden.routing': false,
      'locator.hidden.providers': false,
      'locator.hidden.react': false,
      'locator.hidden.styling': false,
      'locator.hidden.dependency': false,
    });
  });

  it('lets the per-category object win over the pre-2.0 boolean', () => {
    // A profile written during the changeover carries both. The categories are
    // what the user last saw on screen, so they are the newer document.
    expect(
      legacyOverrides({ hideFrameworkComponents: false, hidden: { routing: true } }),
    ).toEqual({
      'locator.hidden.providers': false,
      'locator.hidden.react': false,
      'locator.hidden.styling': false,
      'locator.hidden.dependency': false,
      // `routing` came back to `true`, which is the default, so it is *absent*
      // rather than written — the sparse rule, held through a two-step mapping.
    });
  });

  it('writes nothing at all for a blob that agrees with every default', () => {
    expect(
      legacyOverrides({
        editor: 'vscode',
        customEditorTemplate: '',
        projectRoot: '',
        useSourceMaps: true,
        hidden: { routing: true, providers: true, react: true, styling: true, dependency: true },
      }),
    ).toEqual({});
  });

  it('validates rather than trusts, because a blob is storage like any other', () => {
    expect(legacyOverrides({ editor: 'notepad-9000' })).toEqual({});
    expect(legacyOverrides({ useSourceMaps: 'false' })).toEqual({});
    expect(legacyOverrides({ hidden: { routing: 'no' } })).toEqual({});
  });

  it('answers empty for anything that is not a blob', () => {
    for (const value of [null, undefined, 0, 'x', []]) {
      expect(legacyOverrides(value)).toEqual({});
    }
  });
});

// ── The migration, against storage ───────────────────────────────────────────

describe('the migration', () => {
  it('brings a realistic profile forward and takes the old key away', async () => {
    chromeFake.seed({ [LEGACY_KEY]: REALISTIC });

    const written = await migrate();

    expect([...written].sort()).toEqual([
      'editor',
      'locator.hidden.dependency',
      'locator.hidden.routing',
      'projectRoot',
      'react.useSourceMaps',
    ]);
    expect(chromeFake.area()).toEqual({
      editor: 'cursor',
      projectRoot: '/Users/dev/work/storefront',
      'react.useSourceMaps': false,
      'locator.hidden.routing': false,
      'locator.hidden.dependency': false,
    });
    // Gone, which is what lets the banned-prefix grep in Wave 3 mean something.
    expect(Object.keys(chromeFake.area())).not.toContain(LEGACY_KEY);
  });

  it('does nothing on a profile that never had the other extension', async () => {
    chromeFake.seed({ editor: 'zed' });
    expect(await migrate()).toEqual([]);
    expect(chromeFake.area()).toEqual({ editor: 'zed' });
  });

  it('writes nothing when the blob agrees with every default', async () => {
    chromeFake.seed({ [LEGACY_KEY]: { editor: 'vscode', projectRoot: '', useSourceMaps: true } });

    expect(await migrate()).toEqual([]);
    // Not "wrote five defaults and then removed the blob" — the area is empty,
    // so a later release with a better default still reaches this user.
    expect(chromeFake.area()).toEqual({});
  });

  it('is a no-op the second time, because the blob is gone', async () => {
    chromeFake.seed({ [LEGACY_KEY]: REALISTIC });
    await migrate();
    const after = chromeFake.area();

    expect(await migrate()).toEqual([]);
    expect(chromeFake.area()).toEqual(after);
  });

  /**
   * The failure this whole design is against: a second run undoing a choice made
   * after the first.
   *
   * Reached here by putting the blob back, which is what a machine that had not
   * synced the removal yet would do. The user's own key is already in the area,
   * so it is not touched — the blob is the older document, and the older
   * document does not get to win.
   */
  it('never overwrites a value changed after it first ran', async () => {
    chromeFake.seed({ [LEGACY_KEY]: REALISTIC });
    await migrate();

    chromeFake.seed({ editor: 'zed', [LEGACY_KEY]: REALISTIC });
    await migrate();

    expect(chromeFake.area().editor).toBe('zed');
  });

  it('leaves a key the user reset after migrating reset, not restored', async () => {
    chromeFake.seed({ [LEGACY_KEY]: { projectRoot: '/old/path', editor: 'cursor' } });
    await migrate();

    // A reset removes the key, per the sparse rule. The blob is already gone, so
    // there is nothing left to put it back.
    const { save } = await import('../src/features/settings/index.js');
    await save({ projectRoot: DEFAULTS.projectRoot });
    await migrate();

    expect(chromeFake.area()).toEqual({ editor: 'cursor' });
  });

  it('survives an unreadable area without claiming it migrated anything', async () => {
    chromeFake.seed({ [LEGACY_KEY]: REALISTIC });
    chromeFake.failReads();
    expect(await migrate()).toEqual([]);
  });
});
