/**
 * Guards the one claim `src/core/locate/` makes about itself: that it is
 * framework-neutral.
 *
 * The engine in there — needle building, bundle search, source-map decode,
 * editor URLs, `Pos0`/`Pos1` — was measured to work unchanged on React, Vue and
 * Svelte before it was moved out of `core/react/` (ADR 0026, and the three
 * spikes in `.ctx/`). The move exists so that `src/core/vue/` can import the
 * engine without importing React, because an import that reads *"Vue depends on
 * React"* is the condition under which somebody makes a second copy instead —
 * and this repository has grown a second markdown renderer and a second a11y
 * renderer already.
 *
 * A single `../react/` import in here would make the neutrality claim false
 * while everything still compiled and every test still passed, because React is
 * present in the extension anyway. That is the failure this catches: not a
 * broken build, a quietly untrue directory.
 *
 * The reverse direction is fine and expected — `core/react/` imports the engine.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'src/core/locate');

/** Matches a real import/export specifier, so prose in a comment is not a hit. */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s+['"]([^'"]+)['"]/g;

const errors = [];

for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
  const text = readFileSync(resolve(dir, file), 'utf8');
  for (const [, spec] of text.matchAll(SPECIFIER)) {
    if (/(^|\/)react\//.test(spec)) {
      errors.push(`src/core/locate/${file} imports ${spec}`);
    }
  }
}

if (errors.length) {
  console.error('core/locate is not framework-neutral:\n');
  for (const error of errors) console.error(`  ✘ ${error}`);
  console.error(
    '\nThe engine in core/locate/ is imported by every framework adapter.\n' +
      'A React import here makes core/vue/ and core/svelte/ depend on React\n' +
      'transitively, which is how the second copy gets written. See ADR 0026.',
  );
  process.exit(1);
}

console.log(`locate: framework-neutral (${readdirSync(dir).filter((f) => f.endsWith('.ts')).length} modules)`);
