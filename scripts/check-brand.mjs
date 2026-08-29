/**
 * Enforces CONTRACTS §4.5 — one product, not two features.
 *
 * The merge's governing rule is that a user must never be able to tell DevFlow
 * was two extensions. Three waves shipped and forty-one former-product strings
 * survived all three, because nothing ever went red: every one of them was
 * caught by a person reading a diff, and people miss most of them. This is the
 * thing that goes red.
 *
 * ## What it reads
 *
 * `src/` and `public/` — the scope §4.5 names, which is the code that ships.
 * Nothing else: widening a frozen contract locally is how two packages end up
 * each correct against a different version of it.
 *
 * ## Comments are stripped first, and that is the whole design
 *
 * §4.5 bans former product names *in strings a person reads* — titles, labels,
 * error sentences, settings copy, console prefixes — and explicitly keeps
 * provenance: "Ported from DevFlow's `table.ts`" is the record of where this
 * code came from and is worth having. A grep cannot tell those apart. A scanner
 * that removes comments and then greps can: what is left is string literals,
 * HTML text and markup, which is very nearly the definition of "a string a
 * person reads".
 *
 * The four other patterns are banned outright, comments included, because they
 * name the *other* product rather than record a history — so they are matched
 * against the raw file.
 *
 * ## What this gate structurally cannot see
 *
 * It reads text, so it only finds names that appear as text:
 *
 *   - **Anything assembled at runtime.** `'Flow' + 'Snap'`, a template hole
 *     `${PRODUCT}`, a name read out of `manifest.json` or `package.json`, a
 *     string built by `.join('')`. None of them contain the banned text and
 *     none of them can be found this way.
 *   - **Anything outside `src/` and `public/`** — `mcp-server/`, the vite
 *     configs, the workflows, this repo's docs. Deliberate (see above), and the
 *     reason `mcp-server/` keeps `devflow-mcp-server`: that is a published npm
 *     package name, not a word on a screen.
 *   - **Lowercase `devflow`.** `~/.devflow`, `devflow-mcp-server` and
 *     `devflow/settings-1` are identifiers a shipped, installed thing already
 *     answers to; renaming them would break every existing install for a word
 *     no user reads as a brand. The `DevFlow` rule is case-sensitive on
 *     purpose, and that is a real hole: `Devflow` in a sentence would pass.
 *   - **An image, an icon or a screenshot** that has the old name drawn in it.
 *
 * So a green run means "no banned string is written literally in shipped text".
 * It does not mean "no user can tell". Only reading the screens gives that.
 */

import { globSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Banned outright — comments included. These name the other product, and a
 * comment explaining what did not survive can say so without naming it (§4.5).
 *
 * `rst:` is deliberately not on this list, bare. It matches `first:` and
 * `worst:` in ordinary prose, and a gate that cries wolf is one nobody reads.
 */
const BANNED = [
  ['React Source', "the other product's name"],
  ['DevPrecision', "the other product's design-system identity"],
  ['rst:settings', "the other product's storage key"],
  ['__RST', "the other product's page globals — one agent, one namespace"],
  ['symbol id="i-', 'the bespoke SVG sprite — icons come from icons.ts (§5)'],
];

/**
 * The one permanent exemption, and it is permanent for a reason worth keeping
 * in front of whoever next edits this file.
 *
 * `chrome.storage.managed` is read-only to the extension. An organisation's
 * policy file still pushes `rst:settings`, is deployed by its IT department,
 * and no amount of migrating on our side can rewrite a file we cannot write. An
 * enterprise that deployed the other extension would have its `editor` and
 * `projectRoot` policy silently stop applying the day it upgraded. So the
 * migration reads the legacy key forever, and the gate says so by name.
 */
const EXEMPT = new Map([
  ['rst:settings', ['src/features/settings/migrate.ts']],
]);

/** The former product name, banned in text a person reads. Case-sensitive. */
const FORMER = 'FlowSnap';

/**
 * Files still shipping `DevFlow` in a string, owned by the serial pass that
 * closes Wave 3.
 *
 * Every entry is a `console.warn('DevFlow: …')`-shaped developer string or a
 * settings sentence, in a file two other Wave 3 packages are rewriting right
 * now — sweeping them from here would have collided with work in flight and
 * cost a sibling session its branch.
 *
 * **This list only ever shrinks, and it exempts only the `DevFlow` rule.** The
 * five patterns above have no exemption but the one above. A file on this list
 * is not unguarded: it is guarded against everything except the one string it
 * is already known to carry, and the run prints the count so an empty list is
 * the visible goal rather than a forgotten one.
 */
const PENDING = [];

/**
 * The file with comments blanked out, newlines and offsets preserved.
 *
 * Character-wise rather than regex, because the regex version has a false
 * *negative*: `'https://x/DevFlow'` is a string containing `//`, and stripping
 * from the first `//` to end of line would delete the violation instead of
 * reporting it. Comment characters become spaces so the line numbers this
 * prints are the line numbers in the editor.
 *
 * An unterminated `'` or `"` is a syntax error in every language here, so both
 * reset at a newline: a regex literal like `/["']/` that fools the scanner then
 * costs one line of accuracy instead of the rest of the file.
 */
function stripComments(text, html) {
  const out = Array.from(text);
  let i = 0;
  let quote = null;

  const blank = (from, to) => {
    for (let j = from; j < to && j < out.length; j++) {
      if (out[j] !== '\n') out[j] = ' ';
    }
  };

  while (i < out.length) {
    const c = text[i];

    if (quote) {
      if (c === '\\') {
        i += 2;
      } else {
        if (c === quote || (c === '\n' && quote !== '`')) quote = null;
        i++;
      }
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      i++;
      continue;
    }

    if (html && text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      const stop = end === -1 ? out.length : end + 3;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (!html && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? out.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (!html && text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? out.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    i++;
  }

  return out.join('');
}

/** Every occurrence of `needle` in `text`, as `{ line, source }`. */
function hits(text, needle) {
  const found = [];

  text.split('\n').forEach((line, index) => {
    if (line.includes(needle))
      found.push({ line: index + 1, source: line.trim() });
  });

  return found;
}

const files = [
  ...globSync('src/**/*.{ts,tsx,js,mjs,html,css,json}', { cwd: root }),
  ...globSync('public/**/*.{js,mjs,html,css,json}', { cwd: root }),
]
  .map((file) => file.split('\\').join('/'))
  .sort();

let failed = 0;
let pendingSeen = 0;

for (const file of files) {
  const raw = readFileSync(resolve(root, file), 'utf8');

  for (const [needle, why] of BANNED) {
    if (EXEMPT.get(needle)?.includes(file)) continue;

    for (const hit of hits(raw, needle)) {
      console.error(`${file}:${hit.line}  ${needle} — ${why}`);
      console.error(`    ${hit.source}`);
      failed++;
    }
  }

  const speech = hits(stripComments(raw, file.endsWith('.html')), FORMER);
  if (speech.length === 0) continue;

  if (PENDING.includes(file)) {
    pendingSeen += speech.length;
    continue;
  }

  for (const hit of speech) {
    console.error(
      `${file}:${hit.line}  ${FORMER} in text a person reads — ` +
        "use the product's own vocabulary (CONTRACTS §4). A comment recording " +
        'where this code came from is provenance and is allowed; this is not one.',
    );
    console.error(`    ${hit.source}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} former-product ${failed === 1 ? 'string' : 'strings'} in shipped text. ` +
      'CONTRACTS §4.5: a user must never be able to tell DevFlow was two extensions.',
  );
  process.exit(1);
}

console.log(
  `brand: ${files.length} files clean` +
    (PENDING.length
      ? `, ${pendingSeen} ${FORMER} ${pendingSeen === 1 ? 'string' : 'strings'} ` +
        `still owed in ${PENDING.length} pending ${PENDING.length === 1 ? 'file' : 'files'}`
      : ''),
);
