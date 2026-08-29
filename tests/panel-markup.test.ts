/**
 * The panel's modules and its markup have to agree.
 *
 * `src/panel.html` is not typechecked, which is where `DRAWER_IDS`' promise —
 * "a rename is a compile error in both places rather than a drawer that silently
 * never opens" — runs out. It holds between `settings-drawer.ts` and
 * `ui/locator/main.ts`, both of which import the constant; it cannot reach the
 * document, which spells its ids in a string literal nothing verifies.
 *
 * It had already been broken once. The markup landed in Wave 1 calling the
 * drawer's container `#settings-fields` while the drawer looked for
 * `#settings-rows`, so `mountSettingsDrawer()` returned `null` and the panel's
 * Settings button did nothing at all — no throw, no warning in the build, because
 * `null` is the drawer's documented way of saying "this page has no drawer",
 * which is a legitimate answer for every page that isn't this one. Two packages,
 * one seam, and no gate between them.
 *
 * This is that gate. It is `viewer-markup.test.ts`'s argument applied to the
 * other document: the failure that survives typecheck, lint and every view-model
 * test in the suite is the one where a lookup and a literal drift apart.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DRAWER_IDS } from '../src/ui/locator/settings-drawer.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'src/panel.html'), 'utf8');

/** Every `id="…"` the document defines. */
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

describe('the settings drawer can find every element it addresses', () => {
  it.each(Object.entries(DRAWER_IDS))('DRAWER_IDS.%s is in panel.html', (_name, id) => {
    expect(ids).toContain(id);
  });
});
