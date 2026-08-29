/**
 * Enforces settings UI encapsulation by validating DOM construction and class usages.
 */

import { globSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const others = [
  ...globSync('src/ui/settings/**/*.ts', { cwd: root }),
  'src/settings.html',
]
  .map((file) => file.split('\\').join('/'))
  .filter((file) => file !== COMPONENTS && !EXEMPT.includes(file))
  .sort();

for (const file of others) {
  const text = readFileSync(resolve(root, file), 'utf8');

  text.split('\n').forEach((line, index) => {
    // Strip comments to ignore non-executable mentions of forbidden patterns.
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');

    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(code)) {
        console.error(`${file}:${index + 1}  ${why}`);
        console.error(`    ${line.trim()}`);
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
