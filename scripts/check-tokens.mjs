/**
 * Enforces CSS design token usage across stylesheets and HTML files.
 */

import { globSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Source token definitions file. */
const TOKENS = 'src/ui/styles/tokens.css';

/** Files with scoped or standalone styling exempt from token imports. */
const SCOPED = ['public/content.css'];

/** Files pending design token migration. */
const PENDING = [];

/** Matches direct color literals (hex, rgb, hsl, oklch, lab, color-mix). */
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|color-mix|oklch|lab)\(/gi;

/** Extracts balanced function call arguments starting at the given index. */
function callArgs(text, open) {
  let depth = 0;

  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }

  return text.slice(open + 1);
}

/** Scans file content for un-tokenized color declarations. */
function findings(source) {
  const found = [];

  source.split('\n').forEach((line, index) => {
    if (line.includes('token-check-ignore')) return;

    for (const match of line.matchAll(COLOUR)) {
      const text = match[0];

      if (text.endsWith('(')) {
        const args = callArgs(line, match.index + text.length - 1);
        if (args.includes('var(--')) continue;
      }

      found.push({
        line: index + 1,
        text: text.replace(/\($/, '()'),
        source: line.trim(),
      });
    }
  });

  return found;
}

const files = [
  ...globSync('src/**/*.css', { cwd: root }),
  ...globSync('src/**/*.html', { cwd: root }),
  ...globSync('public/*.css', { cwd: root }),
]
  .map((file) => file.split('\\').join('/'))
  .filter(
    (file) =>
      file !== TOKENS && !SCOPED.includes(file) && !PENDING.includes(file),
  )
  .sort();

let failed = 0;

for (const file of files) {
  const hits = findings(readFileSync(resolve(root, file), 'utf8'));
  for (const hit of hits) {
    console.error(
      `${file}:${hit.line}  ${hit.text} — use a token from ${TOKENS}`,
    );
    console.error(`    ${hit.source}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} colour ${failed === 1 ? 'literal' : 'literals'} outside ${TOKENS}.`,
  );
  process.exit(1);
}

const exempt = [...SCOPED, ...PENDING];
console.log(
  `tokens: ${files.length} files clean` +
    (exempt.length ? `, ${exempt.length} exempt (${exempt.join(', ')})` : ''),
);
