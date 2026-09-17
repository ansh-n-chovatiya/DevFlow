/**
 * Enforces the frozen label strings of CONTRACTS §4.4 and the noun rules of §4.1.
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
 * ## The §4.1 half was documented for a year before it existed
 *
 * CLAUDE.md's gate table has always described this file as *"the frozen
 * glossary — a flow is not a session, a component is not an element"*, and
 * until now it checked neither sentence: an audit changed a real popup string
 * from `Discard this flow?` to `Discard this session?` and both `lint:vocab`
 * and `lint:brand` stayed green. A documented gate that does not fire is worse
 * than an absent one, because the documentation is what stops anyone looking.
 * So §4.1's nouns are checked here too, and they are checked over *prose* —
 * string literals and HTML text — rather than over source.
 *
 * ## Prose is extracted, not stripped, and that is the difference
 *
 * `check-brand.mjs` blanks comments and greps what is left, which is close
 * enough for a product name nobody writes into an identifier. It is not close
 * enough for `session`: `chrome.storage.session`, `sessionStorage` and
 * `session_id` are shipped identifiers this product cannot rename, and there
 * are 188 of that shape in `src/`. So `speech()` inverts the operation — it
 * blanks everything that is *not* a string literal or HTML text — and the noun
 * rules then read a line that contains only words a person could see.
 *
 * The frozen labels of §4.4 keep reading the raw file, comments included. A
 * comment that spells a frozen label is either quoting it correctly — `Pick
 * another`, `Copy path`, as the card's own comments do — or spelling it the way
 * the code used to, which is exactly the drift this exists to stop.
 *
 * ## What it cannot see
 *
 * A label assembled at runtime, a label in an image, and a label that is simply
 * a different word — `Choose a component` breaks §4.4 as surely as
 * `Pick Component` does and nothing here will find it.
 *
 * On §4.1 the hole is wider and worth naming precisely, because the row bans
 * four synonyms and only one of them is checkable. **`session` is banned
 * outright** — this product has no user-facing session, so any occurrence in
 * prose is the wrong noun. `capture`, `trace` and `recording` are not, and not
 * from timidity: `record` is a frozen verb (§4.2) and its participle is how the
 * popup says what it is doing, the OTel surface means a real trace when it says
 * one, and a screenshot really is captured. Banning the words would fail the
 * sentences that use them correctly, and a gate that cries wolf is one nobody
 * reads — the same argument §4.5 already makes about bare `rst:`.
 *
 * The component/element distinction has no single word to ban either, because
 * both nouns are correct about their own thing. What is checkable is the
 * *pairing*: a locate resolves a component, a source belongs to a component,
 * React has no elements and the DOM has no components. Those are the phrases
 * below. `That component is no longer on the page` reworded to say `element`
 * would still pass, and that is a real gap rather than an oversight.
 *
 * A green run means no *known* wrong noun is written literally in shipped prose.
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

/**
 * §4.1's nouns, as the wrong word and the rule it breaks.
 *
 * One entry, deliberately. See the header for why `capture`, `trace` and
 * `recording` are not here and are not coming.
 */
const NOUNS = [
  [
    /\bsessions?\b/gi,
    'CONTRACTS §4.1: a flow is one recording, start to stop — never a session.',
  ],
];

/**
 * The component/element rules, which are about pairs of words rather than words.
 *
 * `pick` is absent on purpose: §4.2 defines it as *click an element on the
 * page*, so `Pick an element` is the contract's own English even though the
 * frozen button label (§4.4) is `Pick component`. A rule banning that pairing
 * would fail the glossary it enforces.
 */
const PAIRS = [
  [
    /\b(?:locate|locates|locating|located)\s+(?:the\s+|this\s+|that\s+|an?\s+|your\s+)?elements?\b/gi,
    'CONTRACTS §4.2: a locate resolves a *component* to its source; an element is what you pick.',
  ],
  [
    /\bReact\s+elements?\b/g,
    "CONTRACTS §4.1: React's noun is component — element is the DOM's.",
  ],
  [
    /\bDOM\s+components?\b/g,
    "CONTRACTS §4.1: the DOM's noun is element — component is React's.",
  ],
  [
    /\belements?\\?['’]?s?\s+(?:source|props|state|hooks?)\b/gi,
    'CONTRACTS §4.1: a source is the file and line a *component* was written in.',
  ],
  [
    /\b(?:re-?rendered|re-?rendering|rendered)\s+elements?\b/gi,
    'CONTRACTS §4.1: rendering is a component doing it — the element is the result.',
  ],
  [
    /\b(?:parent|sibling|child)\s+elements?\b/gi,
    'CONTRACTS §4.4: the panel draws `Parent tree` and `Siblings` over components.',
  ],
];

/**
 * A banned noun that is really an identifier, not a word on a screen.
 *
 * `'chrome.storage.session'`, `'x-session-id'` and `'/session/current'` are all
 * string literals, so `speech()` keeps them; all three are keys this product
 * either does not own or cannot rename. A word welded to a neighbour by `.`,
 * `-`, `_`, `/` or `:` is an identifier, and `\b` alone does not see the
 * difference — it already rejects `sessionStorage` and `session_id`, and stops
 * one character short of `storage.session`.
 *
 * The delimiter has to be *between two words* to count, which is the half a
 * first draft got wrong: `No sessions yet.` ends in a full stop, and a rule
 * reading any adjacent `.` as welding silently exempted every banned noun that
 * happened to end a sentence — the commonest place a word on a screen sits.
 */
const WELDED_BEFORE = /[\w$][.\-_/:]$/;
const WELDED_AFTER = /^[.\-_/:][\w$]/;

/**
 * Prose where a banned noun is the *page's* word, not this product's.
 *
 * DevFlow reads the app under inspection, and that app has its own vocabulary.
 * The settings row for `state.maxStores` names two stores an app typically
 * wraps around everything — the theme and the session — to explain which ones
 * get cut first. That sentence is about the user's store, not about a
 * recording, and §4.1 governs what DevFlow calls its own things.
 *
 * Keyed on the sentence rather than the file, because `fields.ts` is where
 * nearly all of the settings copy lives: exempting the file would unguard every
 * other row in it. **An entry here is a claim that the word is right, not a
 * debt** — the debt list is `EXEMPT`, above, and that one only shrinks.
 */
const NOT_OURS = [{ file: 'src/features/settings/fields.ts', line: /the theme, the session/ }];

/**
 * `text` with everything that is not a string literal or HTML text blanked out,
 * newlines and offsets preserved so reported line numbers are editor line
 * numbers.
 *
 * The inverse of `lib/strip-comments.mjs`, and separate from it because it
 * wants the opposite half of the same walk: comments *and code* go, quoted text
 * stays. A `${…}` hole inside a template literal is code, so it goes too —
 * otherwise a variable named `sessionId` would be read as a word on a screen.
 *
 * HTML keeps text between tags, plus the attributes a person actually reads.
 * `class`, `id` and `href` are not among them: a `.session-row` class name is
 * an identifier, and §4.1 governs words, not selectors.
 */
const READABLE_ATTRS = /\b(?:title|placeholder|alt|label|content|aria-(?:label|description|roledescription|placeholder|valuetext))\s*=\s*$/i;

function speech(text, html) {
  const out = Array.from(text).map((c) => (c === '\n' ? '\n' : ' '));
  const keep = (from, to) => {
    for (let j = from; j < to && j < out.length; j++) out[j] = text[j];
  };

  let i = 0;

  if (html) {
    while (i < text.length) {
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        i = end === -1 ? text.length : end + 3;
        continue;
      }

      if (text[i] === '<') {
        const end = text.indexOf('>', i);
        const stop = end === -1 ? text.length : end + 1;

        // Inside the tag, only the values of attributes a person reads survive.
        for (let j = i; j < stop; j++) {
          const q = text[j];
          if (q !== '"' && q !== "'") continue;

          const close = text.indexOf(q, j + 1);
          const value = close === -1 || close >= stop ? stop : close;
          if (READABLE_ATTRS.test(text.slice(i, j))) keep(j + 1, value);
          j = value;
        }

        i = stop;
        continue;
      }

      const next = text.indexOf('<', i);
      const stop = next === -1 ? text.length : next;
      keep(i, stop);
      i = stop;
    }

    return out.join('');
  }

  while (i < text.length) {
    const c = text[i];

    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }

    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    // An unterminated `'` or `"` is a syntax error in every language here, so
    // both reset at a newline: a regex literal that fools the walk costs one
    // line of accuracy rather than the rest of the file.
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === c || text[j] === '\n') break;
        j++;
      }

      keep(i + 1, j);
      i = j + 1;
      continue;
    }

    if (c === '`') {
      let j = i + 1;
      let start = j;

      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '`') break;

        if (text[j] === '$' && text[j + 1] === '{') {
          keep(start, j);
          let depth = 1;
          j += 2;
          while (j < text.length && depth > 0) {
            if (text[j] === '{') depth++;
            else if (text[j] === '}') depth--;
            j++;
          }
          start = j;
          continue;
        }

        j++;
      }

      keep(start, j);
      i = j + 1;
      continue;
    }

    i++;
  }

  return out.join('');
}

const files = [
  ...globSync('src/**/*.{ts,tsx,html}', { cwd: root }),
  ...globSync('public/**/*.html', { cwd: root }),
]
  .map((file) => file.split('\\').join('/'))
  .sort();

let failed = 0;

for (const file of files) {
  const raw = readFileSync(resolve(root, file), 'utf8');
  const lines = raw.split('\n');
  const prose = speech(raw, file.endsWith('.html')).split('\n');

  prose.forEach((line, index) => {
    if (NOT_OURS.some((entry) => entry.file === file && entry.line.test(line))) return;

    for (const [pattern, why] of [...NOUNS, ...PAIRS]) {
      pattern.lastIndex = 0;

      for (let hit = pattern.exec(line); hit; hit = pattern.exec(line)) {
        const before = line.slice(0, hit.index);
        const after = line.slice(hit.index + hit[0].length);
        if (WELDED_BEFORE.test(before) || WELDED_AFTER.test(after)) continue;

        console.error(`${file}:${index + 1}  ${hit[0].trim()} — ${why}`);
        console.error(`    ${lines[index].trim()}`);
        failed++;
      }
    }
  });

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
