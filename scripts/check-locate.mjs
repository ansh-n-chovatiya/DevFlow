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

/**
 * Comments removed before anything is matched.
 *
 * The specifier patterns below are deliberately broad — a formatter may put the
 * `from` on its own line, and an anchored one-line pattern is what made this
 * gate blind. Broad patterns need prose kept away from them, and the headers in
 * this repository name modules by path constantly, so the stripping is the
 * anti-prose measure that line-anchoring used to be.
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * Every module specifier a file names, however it is written.
 *
 * Three forms, because there are three ways to depend on a module and all three
 * make the neutrality claim false. The one that mattered was the first: the
 * previous pattern required the whole statement to fit on one line, so
 * `needle.ts` — whose single import is spread over five lines by the
 * formatter — was scanned and reported as having no imports at all. It saw 13
 * of the 15 specifiers actually in this directory, and a multi-line
 * `import {\n  walkFiber,\n} from '../react/fiber.js';` was invisible to it:
 * a gate that reads as passing while the thing it guards is untrue, which is
 * exactly the failure this file's header describes.
 */
const SPECIFIERS = [
  /\bfrom\s*['"]([^'"]+)['"]/g, // import … from 'x' · export … from 'x'
  /\bimport\s*['"]([^'"]+)['"]/g, // import 'x' — for side effects
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // await import('x')
];

const errors = [];

// `recursive`, so a module filed under a future `core/locate/<subdir>/` is
// scanned rather than silently exempt.
const modules = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.ts'));

for (const file of modules) {
  const text = stripComments(readFileSync(resolve(dir, String(file)), 'utf8'));
  for (const pattern of SPECIFIERS) {
    for (const [, spec] of text.matchAll(pattern)) {
      if (/(^|\/)react\//.test(spec)) {
        errors.push(`src/core/locate/${file} imports ${spec}`);
      }
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

console.log(`locate: framework-neutral (${modules.length} modules)`);
