/**
 * Enforces the frozen label strings of CONTRACTS §4.4.
 *
 * §4.4 freezes eight strings and §4.1 draws the line under two of them — *a
 * component is React's and an element is the DOM's*. Nothing checked either.
 * The panel's idle button shipped as `Pick Element`, wearing the wrong noun and
 * the wrong case, through three waves and every gate in `verify`: `lint:brand`
 * greps for two dead product names and cannot see a live string in the wrong
 * words, and `src/panel.html` is typechecked by nothing at all.
 *
 * This is the gate for that class. It looks for the *wrong* spellings of frozen
 * labels rather than asserting the right ones are present — presence belongs to
 * the tests beside each surface, which know which surface should carry which
 * label; a repo-wide grep does not.
 *
 * ## Comments are not stripped, and that is deliberate
 *
 * `check-brand.mjs` strips them because §4.5 permits a comment to name a former
 * product as provenance. §4.4 has no equivalent: a comment that spells a frozen
 * label is either quoting it correctly — `Pick another`, `Copy path`, as the
 * card's own comments do — or spelling it the way the code used to, which is
 * exactly the drift this exists to stop. So the raw file is scanned, and the
 * cost is a scanner nobody has to reason about.
 *
 * ## What it cannot see
 *
 * A label assembled at runtime, a label in an image, and a label that is simply
 * a different word — `Choose a component` breaks §4.4 as surely as
 * `Pick Component` does and nothing here will find it. A green run means no
 * *known* misspelling of a frozen label is written literally in shipped text.
 */

import { globSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Each frozen label, and the spellings of it that are not the frozen one. */
const FROZEN = [
  ['Pick component', ['Pick Element', 'Pick element', 'Pick Component']],
  ['Pick another', ['Pick Another']],
  ['Open in Editor', ['Open In Editor', 'Open in editor']],
  ['Open in Sources', ['Open In Sources', 'Open in sources']],
  ['Copy path', ['Copy Path']],
  // Retired outright by §4.4, along with the popup's half of three other rows:
  // a popup has no DevTools window, so the action it named could never finish.
  [null, ['Locate Component', 'Locate component']],
];

/**
 * Files exempt from one spelling, because the string is theirs and this pass
 * does not own them.
 *
 * `src/viewer.html` carries `title="Open in editor"` and `src/ui/viewer/app.ts`
 * quotes it in a comment. Both are the flow review's, both are one word away
 * from §4.4, and neither is fixable from here without editing a surface another
 * package is holding. Listed rather than dropped so the rule still guards every
 * other file, and so the debt is written down instead of remembered.
 *
 * **This map only ever shrinks.**
 */
const EXEMPT = new Map([
  ['Open in editor', ['src/viewer.html', 'src/ui/viewer/app.ts']],
]);

const files = [
  ...globSync('src/**/*.{ts,tsx,html}', { cwd: root }),
  ...globSync('public/**/*.html', { cwd: root }),
]
  .map((file) => file.split('\\').join('/'))
  .sort();

let failed = 0;

for (const file of files) {
  const lines = readFileSync(resolve(root, file), 'utf8').split('\n');

  for (const [frozen, wrong] of FROZEN) {
    for (const spelling of wrong) {
      if (EXEMPT.get(spelling)?.includes(file)) continue;

      lines.forEach((line, index) => {
        if (!line.includes(spelling)) return;
        console.error(
          `${file}:${index + 1}  ${spelling} — ` +
            (frozen
              ? `CONTRACTS §4.4 freezes “${frozen}”.`
              : 'CONTRACTS §4.4 retired this label.'),
        );
        console.error(`    ${line.trim()}`);
        failed++;
      });
    }
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} ${failed === 1 ? 'string breaks' : 'strings break'} the frozen vocabulary. ` +
      'CONTRACTS §4.4 is the list; §4.1 is why a component is not an element.',
  );
  process.exit(1);
}

console.log(`vocab: ${files.length} files clean`);
