/**
 * Two things in the panel's markup that no view-model test can see, because
 * `src/panel.html` is typechecked by nothing and rendered only inside DevTools.
 *
 *   - **The trees were not buttons.** `#ancestry-list` and `#sibling-list`
 *     carried `role="list"` and every row `treeRow` built carried
 *     `role="listitem"`. An explicit role *replaces* the implicit one, so the
 *     rows stopped being buttons to a screen reader: announced as list items
 *     with no hint that they do anything, and absent from the button list most
 *     readers navigate a panel by. The whole component tree — the panel's second
 *     reason to exist — was unreachable that way, with nothing visibly wrong.
 *   - **The drawers did not say they were open.** Both status-bar buttons toggle
 *     a drawer over `main` rather than navigating, and `aria-expanded` is the
 *     only thing that says the second press closes what the first opened.
 *
 * Asserted against the document rather than a render, the way
 * `panel-markup.test.ts` and `locator-idle.test.ts` are, for the same reason:
 * `main.ts` needs a DevTools window and the claim here is about what the file
 * says.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'src/panel.html'), 'utf8');

/** The attributes of one element, by its id, as written. */
function element(id: string): string {
  const at = html.indexOf(`id="${id}"`);
  expect(at, id).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<', at);
  const close = html.indexOf('>', at);
  return html.slice(open, close + 1);
}

describe('the component trees stay reachable as buttons', () => {
  it.each(['ancestry-list', 'sibling-list'])('%s is a labelled group, not a list', (id) => {
    const tag = element(id);

    expect(tag).not.toContain('role="list"');
    expect(tag).toContain('role="group"');
    // A group with no accessible name is a group nothing announces.
    expect(tag).toMatch(/aria-labelledby="[a-z-]+-heading"/);
  });

  it('gives each heading the id its group points at', () => {
    expect(html).toContain('id="ancestry-heading"');
    expect(html).toContain('id="sibling-heading"');
  });
});

describe('the status bar says what its drawers are doing', () => {
  it.each([
    ['history-btn', 'history-drawer'],
    ['settings-btn', 'settings-drawer'],
  ])('%s is a disclosure for #%s', (button, drawer) => {
    const tag = element(button);

    expect(tag).toContain(`aria-controls="${drawer}"`);
    // Seeded closed; `setHistoryOpen` and the drawer controller keep it honest.
    expect(tag).toContain('aria-expanded="false"');
  });
});
