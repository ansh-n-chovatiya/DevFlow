/**
 * Enforces settings UI encapsulation by validating DOM construction and class usages.
 */

import { globSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './lib/strip-comments.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Component file responsible for settings DOM construction. */
const COMPONENTS = 'src/ui/settings/components.ts';

/** Stylesheet owning settings UI classes. */
const OWNED = 'src/ui/settings/components.css';

/** Shared stylesheets imported by the settings page. */
const SHARED = ['src/ui/styles/base.css', 'src/ui/styles/components.css'];

/** Exempted files from markup constraints. */
const EXEMPT = [];

/* --- CSS Parsing --- */

/** Extracts CSS class names declared in a stylesheet. */
function declared(file) {
  const css = readFileSync(resolve(root, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@(?:import|charset)[^;]*;/g, '');
  const names = new Set();

  for (const [, selector] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const [, name] of selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.([a-zA-Z_][\w-]*)/g)) {
      names.add(name);
    }
  }

  return names;
}

/* --- Component Analysis --- */

/** Pattern matching CSS class name tokens. */
const CLASS_TOKEN = /^[a-z][a-z0-9]*(?:[-_]+[a-z0-9]+)*$/;

/** Determines whether tokens represent CSS class names. */
function isClassList(tokens, known) {
  if (tokens.length === 0) return false;
  if (!tokens.every((token) => CLASS_TOKEN.test(token))) return false;
  return tokens.some((token) => token.includes('__') || token.includes('--') || known.has(token));
}

/** Extracts class names referenced in component source code. */
function used(source, known) {
  const names = new Set();

  for (const [, literal] of source.matchAll(/'([^'\\\n]*)'/g)) {
    const tokens = literal.trim().split(/\s+/).filter(Boolean);
    if (isClassList(tokens, known)) for (const token of tokens) names.add(token);
  }

  for (const [, literal] of source.matchAll(/class="([^"]*)"/g)) {
    for (const token of literal.trim().split(/\s+/).filter(Boolean)) names.add(token);
  }

  return names;
}

/* --- Lint Rules --- */

/** Disallowed DOM creation and mutation patterns outside components.ts. */
const FORBIDDEN = [
  [/\bdocument\.createElement\b/, 'creates an element — use a primitive from components.ts'],
  [/\bcreateElementNS\b/, 'creates an element — use a primitive from components.ts'],
  [/\bcreateDocumentFragment\b/, 'creates nodes — use a primitive from components.ts'],
  [/\.className\b/, 'sets a class — the class belongs in components.ts'],
  [/\bclassList\./, 'sets a class — the class belongs in components.ts'],
  /*
   * The third way to set a class, and it was the only one not listed.
   * `components.ts` itself uses it (`svg.setAttribute('class', 'brand__mark')`,
   * because SVG has no `className` to assign), so it is plainly the shape
   * somebody reaching for a class in the drawer would land on — and it was the
   * one shape that passed.
   */
  [/\bsetAttribute\(\s*["']class["']/, 'sets a class — the class belongs in components.ts'],
  [/\b(?:inner|outer)HTML\b/, 'writes markup — the markup belongs in components.ts'],
  [/\binsertAdjacent(?:HTML|Element)\b/, 'writes markup — the markup belongs in components.ts'],
  [/\bclass=["']/, 'carries a class — every node on this page is built in components.ts'],
];

/* --- Execution --- */

const knownOwned = declared(OWNED);
const known = new Set(knownOwned);
for (const file of SHARED) for (const name of declared(file)) known.add(name);

/* Strip comments before scanning to avoid parsing false string literals. */
const source = readFileSync(resolve(root, COMPONENTS), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const usedNames = used(source, known);

let failed = 0;

for (const name of [...usedNames].sort()) {
  if (known.has(name)) continue;
  console.error(`${COMPONENTS}  .${name} — used but declared in no stylesheet the page loads`);
  failed++;
}

for (const name of [...knownOwned].sort()) {
  if (usedNames.has(name)) continue;
  console.error(`${OWNED}  .${name} — declared but used by nothing in ${COMPONENTS}`);
  failed++;
}

/*
 * The drawer is on this list and not in `src/ui/settings/` because D9 puts one
 * store behind two views: the options page and a drawer inside the DevTools
 * panel. The guarantee D9 leans on is that the drawer goes through the same
 * primitives or CI fails — and a glob that stopped at `src/ui/settings/` would
 * have left the second view entirely unguarded, which is the one place a second
 * way of drawing a setting could grow back.
 */
const DRAWER = 'src/ui/locator/settings-drawer.ts';
const drawer = globSync(DRAWER, { cwd: root });

/*
 * Named by literal path, so a rename or a move drops it from the scan and the
 * gate goes on printing a pass — the one thing the paragraph above says must
 * not happen. A glob that matched nothing is therefore an error rather than an
 * empty list.
 */
if (drawer.length === 0) {
  console.error(
    `${DRAWER} is not there, and this gate names it by path. Either the second settings view ` +
      'moved — point this at it — or it is gone, in which case delete this line. A missing file ' +
      'silently narrows the scan to the options page, which is how the drawer grows a second way ' +
      'of drawing a setting.',
  );
  process.exit(1);
}

const others = [
  ...globSync('src/ui/settings/**/*.ts', { cwd: root }),
  ...drawer,
  'src/settings.html',
]
  .map((file) => file.split('\\').join('/'))
  .filter((file) => file !== COMPONENTS && !EXEMPT.includes(file))
  .sort();

for (const file of others) {
  const text = readFileSync(resolve(root, file), 'utf8');
  /*
   * Comments blanked whole-file and character-wise, rather than cut at the
   * first `//` on each line.
   *
   * `line.replace(/\/\/.*$/, '')` deletes from a `//` that is inside a string
   * literal, so `const help = 'https://example.com'; row.className = 'x';` was
   * truncated at `https:` and the breach after it was never scanned — a false
   * *pass*, in the gate whose whole job is to catch that one line. `check-brand`
   * had already met and solved this; the fix is its scanner, now shared.
   * Offsets and newlines are preserved, so the numbers below stay the editor's.
   */
  const scanned = stripComments(text, file.endsWith('.html'));
  const lines = text.split('\n');

  scanned.split('\n').forEach((code, index) => {
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(code)) {
        console.error(`${file}:${index + 1}  ${why}`);
        console.error(`    ${lines[index].trim()}`);
        failed++;
      }
    }
  });
}

if (failed > 0) {
  console.error(
    `\n${failed} settings-UI ${failed === 1 ? 'breach' : 'breaches'}. ` +
      `The primitives live in ${COMPONENTS}; widen one rather than working around it.`,
  );
  process.exit(1);
}

console.log(
  `settings-ui: ${knownOwned.size} classes declared and used, ` +
    `${others.length} files free of markup` +
    (EXEMPT.length ? `, ${EXEMPT.length} exempt (${EXEMPT.join(', ')})` : ''),
);
