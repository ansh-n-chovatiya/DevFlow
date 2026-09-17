/**
 * The invariant CLAUDE.md led with and nothing enforced.
 *
 * `src/core/` is the tree that gets bundled into `mcp-server/core.js` and
 * imported by a Node process with no `chrome`, no `window` and no DOM — and a
 * production audit (report.md §3.6 P1) falsified the claim that anything was
 * checking. It appended `chrome.storage.local.get(...)`, a bare `fetch` and
 * `window.location.href` to a real `core/` module and ran the whole done-gate:
 * `npm run verify` exited 0. Reproduced here before the gate was written, and
 * the reason is worth keeping: `eslint.config.js` hands browser and
 * webextension globals to the entire tree, `tsconfig.json` puts the ambient
 * `chrome` types over all of `src/`, and `build:mcp` only fails on an import it
 * cannot *resolve*. A bare global resolves to nothing at build time and to a
 * `ReferenceError` on the server's first tool call.
 *
 * So the first block below is that exact mutation, applied to the live
 * `core/flow/index.ts` rather than to a hand-written sample — a fixture that
 * invents its own violation proves the regex works, not that the gate sees the
 * product. Each case runs the file unmutated first, because a gate that fails
 * both ways is not a gate.
 *
 * The rest are the cry-wolf cases, and they are why `check-core-purity.mjs`
 * parses instead of grepping. Three real files in `core/` today contain the
 * banned words in code that is perfectly pure: a local variable named `window`,
 * a generated `import … from '@playwright/test'` inside a template literal, and
 * the URL scheme `chrome[\w-]*:` inside a regex literal. A gate that fired on
 * those is a gate somebody switches off inside a week.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

interface Run {
  code: number;
  output: string;
}

/**
 * `check-core-purity.mjs` over a tree of exactly `files`, and its exit code.
 *
 * A temporary tree rather than the checkout, because the gate walks `src/core`
 * relative to its own parent directory: run against the working copy it can
 * only ever say that today's working copy is clean, and mutating the working
 * copy to ask anything else is how a test run leaves a repository behind it.
 * `node_modules` is symlinked in because the gate uses the TypeScript parser —
 * the whole reason it can tell a reference from a word in a string.
 */
function gate(files: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), 'core-purity-'));

  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'src/core'), { recursive: true });
    copyFileSync(
      resolve(root, 'scripts/check-core-purity.mjs'),
      join(dir, 'scripts/check-core-purity.mjs'),
    );
    symlinkSync(resolve(root, 'node_modules'), join(dir, 'node_modules'));

    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }

    try {
      const out = execFileSync('node', ['scripts/check-core-purity.mjs'], { cwd: dir, stdio: 'pipe' });
      return { code: 0, output: out.toString() };
    } catch (error) {
      const failure = error as { status: number | null; stdout: Buffer; stderr: Buffer };
      return {
        code: failure.status ?? 1,
        output: failure.stdout.toString() + failure.stderr.toString(),
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One core module holding `body`, at a path the gate's path maths can read. */
const core = (body: string, file = 'src/core/flow/index.ts') => gate({ [file]: body });

describe('the audit’s own mutation: chrome, fetch and window inside core', () => {
  const file = 'src/core/flow/index.ts';

  it('passes the module as shipped', () => {
    expect(gate({ [file]: read(file) }).code).toBe(0);
  });

  it('fails the module with the audit’s impure function appended', () => {
    const impure = [
      read(file),
      'export async function auditImpurity(id: string): Promise<string> {',
      '  const stored = await chrome.storage.local.get(id);',
      '  const res = await fetch(`https://example.com/${id}`);',
      '  return `${window.location.href} ${String(stored[id])} ${res.status}`;',
      '}',
      '',
    ].join('\n');
    const run = gate({ [file]: impure });

    expect(run.code).toBe(1);
    // The file, the line and which global — an error that needs a grep to act
    // on is an error that gets ignored.
    expect(run.output).toContain(`${file}:`);
    expect(run.output).toContain('reads `chrome`');
    expect(run.output).toContain('reads `fetch`');
    expect(run.output).toContain('reads `window`');
    expect(run.output).toContain('ADR 0001');
  });
});

describe('the ways impurity actually arrives', () => {
  it.each([
    ['chrome.storage.local.get("a")', 'chrome'],
    ['chrome.runtime.sendMessage({})', 'chrome'],
    ['fetch("https://example.com")', 'fetch'],
    ['document.querySelector("#a")', 'document'],
    ['window.setTimeout(() => 1, 0)', 'window'],
    ['localStorage.getItem("a")', 'localStorage'],
    ['sessionStorage.getItem("a")', 'sessionStorage'],
    ['indexedDB.open("a")', 'indexedDB'],
    ['navigator.sendBeacon("/a")', 'navigator'],
    ['location.href', 'location'],
    ['new XMLHttpRequest()', 'XMLHttpRequest'],
    ['new MutationObserver(() => {})', 'MutationObserver'],
  ])('fails `%s`', (expression, name) => {
    const run = core(`export const value = () => ${expression};\n`);

    expect(run.code).toBe(1);
    expect(run.output).toContain(`reads \`${name}\``);
  });

  /*
   * The obvious way around a file-scoped shadow exemption, which is why
   * `globalThis` is banned outright rather than only its DOM-shaped properties.
   */
  it('fails the globalThis escape hatch', () => {
    const run = core(
      ['const chrome = globalThis.chrome;', 'export const get = () => chrome.storage;', ''].join('\n'),
    );

    expect(run.code).toBe(1);
    expect(run.output).toContain('reads `globalThis`');
  });

  it('fails an import of the impure half of src/', () => {
    const run = core("import { getTab } from '../../chrome/tabs.js';\nexport const a = getTab;\n");

    expect(run.code).toBe(1);
    expect(run.output).toContain('src/chrome/tabs.js');
    expect(run.output).toContain('impure by design');
  });

  it('fails an import of a Node builtin, which the page has no more than Node has a DOM', () => {
    const run = core("import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n");

    expect(run.code).toBe(1);
    expect(run.output).toContain('node:fs');
  });

  it('fails a dynamic import of the same', () => {
    const run = core("export const a = () => import('../../features/store.js');\n");

    expect(run.code).toBe(1);
    expect(run.output).toContain('src/features/store.js');
  });
});

describe('the false positives that would get the gate switched off', () => {
  /*
   * `locate/search.ts` slices a window of bundle text around a match and calls
   * it `window`. Pure code, and a `\bwindow\.` pattern reports it.
   */
  it('is still the local variable named window', () => {
    expect(read('src/core/locate/search.ts')).toContain('const window = content.slice(');
  });

  it('leaves a locally declared window alone', () => {
    const file = 'src/core/locate/search.ts';
    expect(gate({ [file]: read(file) }).code).toBe(0);
  });

  /*
   * `export/playwright.ts` writes a Playwright spec as text. The bare specifier
   * and the word `test` are the *output*, not this module's imports.
   */
  it('is still generating an import statement as a string', () => {
    expect(read('src/core/export/playwright.ts')).toContain("from '@playwright/test'");
  });

  it('leaves generated source inside a template literal alone', () => {
    const file = 'src/core/export/playwright.ts';
    expect(gate({ [file]: read(file) }).code).toBe(0);
  });

  /*
   * `locate/editor.ts` refuses to build an editor URL for a page served over a
   * scheme like `chrome-extension:`. The word is inside a regex literal.
   */
  it('is still matching the chrome- URL schemes', () => {
    expect(read('src/core/locate/editor.ts')).toContain('chrome[\\w-]*');
  });

  it('leaves a scheme named in a regex literal alone', () => {
    const file = 'src/core/locate/editor.ts';
    expect(gate({ [file]: read(file) }).code).toBe(0);
  });

  it.each([
    ['a comment', '// chrome.storage.local.get is what src/chrome/ wraps\nexport const a = 1;\n'],
    ['a doc comment', '/** Never call fetch() here — see ADR 0001. */\nexport const a = 1;\n'],
    ['a string', "export const hint = 'call chrome.storage.local.get from src/chrome/';\n"],
    ['a property of our own data', 'export const a = (s: { document: string }) => s.document;\n'],
    ['an object literal key', 'export const a = { window: 1, document: 2 };\n'],
    ['a directory of this repo', "export { findFeature } from './navigator/index.js';\n"],
    ['a sibling in core', "export { toOneBased } from '../locate/positions.js';\n"],
    ['the frozen shared types', "import type { Step } from '../../shared/types.js';\nexport type A = Step;\n"],
  ])('leaves %s alone', (_what, body) => {
    expect(core(body).code).toBe(0);
  });
});

describe('the one deliberate crossing into src/features/', () => {
  /*
   * `mcp-bundle.ts` re-exports the settings field table so the MCP server reads
   * the same table the options page does. It is the bundle's entry point, not a
   * core module, and the exemption is keyed to the file and the subdirectory.
   */
  const bundle = 'src/core/mcp-bundle.ts';

  it('is still how the bundle gets the settings table', () => {
    expect(read(bundle)).toContain("from '../features/settings/fields.js'");
  });

  it('passes the bundle as shipped', () => {
    expect(gate({ [bundle]: read(bundle) }).code).toBe(0);
  });

  it('does not extend the crossing to the rest of features/', () => {
    const run = gate({ [bundle]: "export { saveFlow } from '../features/store.js';\n" });

    expect(run.code).toBe(1);
    expect(run.output).toContain('src/features/store.js');
  });

  it('does not extend the crossing to another core module', () => {
    // `../../features/` from `core/flow/`, which is the same `src/features/`
    // the bundle reaches — the exemption is the file, not the specifier.
    const run = core("export { DEFAULTS } from '../../features/settings/fields.js';\n");

    expect(run.code).toBe(1);
    expect(run.output).toContain('src/features/settings/fields.js');
  });
});

describe('the other half of ADR 0001: the clock and randomness', () => {
  /*
   * The names live in the script rather than in a comment, so the rule and the
   * thing the rule is about cannot drift apart. `§3.6 P2` stays cited because
   * `defaultFilename(now = new Date())` is why this half shipped unenforced for
   * a release, and a reader who finds the table deserves the reason it exists.
   */
  it('still names the clock it enforces', () => {
    const source = read('scripts/check-core-purity.mjs');

    expect(source).toMatch(/export const CLOCK = new Map\(/);
    expect(source).toContain("'Math.random'");
    expect(source).toContain('§3.6 P2');
  });

  /*
   * Kept as the equivalence unit 19 wrote — the rule is enforced exactly when
   * the violation is absent — because it is the assertion that fails in either
   * direction: on the day someone reintroduces a defaulted clock into `core/`
   * with the gate still on, and on the day someone switches the gate off to
   * make one land. It now resolves to `true === !false`, which is the fix.
   */
  it('enforces the clock rule now that the violation it waited on is gone', () => {
    const violation = read('src/core/flow/index.ts').includes('now = new Date()');
    const enforced = core('export const a = () => Date.now();\n').code === 1;

    expect(violation).toBe(false);
    expect(enforced).toBe(!violation);
  });

  it('requires the caller to supply the date it used to default', () => {
    expect(read('src/core/flow/index.ts')).toContain('export function defaultFilename(now: Date)');
    expect(read('src/ui/viewer/export-view.ts')).toContain('defaultFilename(new Date())');
  });

  it.each([
    ['new Date()', 'export const a = () => new Date();\n'],
    // `new Date` without the parentheses is the same clock read.
    ['a parenthesis-free new Date', 'export const a = () => new Date;\n'],
    ['Date.now()', 'export const a = () => Date.now();\n'],
    ['performance.now()', 'export const a = () => performance.now();\n'],
    ['Math.random()', 'export const a = () => Math.random();\n'],
    ['crypto.randomUUID()', 'export const a = () => crypto.randomUUID();\n'],
    // Flagged on the property access, not the call, so lifting the function out
    // to a local is not a way around the gate.
    ['the clock aliased to a local', 'const n = Date.now;\nexport const a = () => n();\n'],
  ])('fails %s', (_what, body) => {
    expect(core(body).code).toBe(1);
  });

  /*
   * The reason the rule is the zero-argument *call* and not the name `Date`:
   * every line below is pure, and every line below exists in `core/` today. A
   * gate that banned the identifier would report all of them.
   */
  it.each([
    ['a timestamp passed in', 'export const a = (ms: number) => new Date(ms).toISOString();\n'],
    ['Date as a type annotation', 'export interface A {\n  now?: Date;\n}\n'],
    ['a date parsed from a string', 'export const a = (s: string) => Date.parse(s);\n'],
    [
      'a prototype method borrowed onto a value',
      'export const a = (o: object) => Date.prototype.toISOString.call(o as Date);\n',
    ],
    ['the pure half of Math', 'export const a = (x: number[]) => Math.max(...x);\n'],
    ['a locally declared Date', 'const Date = { now: () => 1 };\nexport const a = () => Date.now();\n'],
  ])('leaves %s alone', (_what, body) => {
    expect(core(body).code).toBe(0);
  });

  /*
   * The same claim against the shipped files rather than against samples of
   * them: these six are every module in `core/` that names `Date`, and a false
   * positive on any one of them is how this rule gets switched back off.
   */
  it.each([
    'src/core/deploy/index.ts',
    'src/core/forensics/index.ts',
    'src/core/state/snapshot.ts',
    'src/core/telemetry/index.ts',
    'src/core/export/markdown.ts',
    'src/core/export/json.ts',
  ])('passes %s, which uses Date purely, as shipped', (file) => {
    expect(gate({ [file]: read(file) }).code).toBe(0);
  });
});

describe('the gate is wired into the done-gate, not merely present', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

  it('has a script of its own', () => {
    expect(pkg.scripts['lint:core-purity']).toBe('node scripts/check-core-purity.mjs');
  });

  it('runs inside npm run verify', () => {
    expect(pkg.scripts.verify).toContain('npm run lint:core-purity');
  });

  /*
   * `lint:locate` shipped inside `verify` and was missing from CLAUDE.md's gate
   * table for a release. The table claims to be the whole list.
   */
  it('is in CLAUDE.md’s gate table', () => {
    expect(read('CLAUDE.md')).toContain('`npm run lint:core-purity`');
  });

  it('passes the tree as it stands', () => {
    const output = execFileSync('node', ['scripts/check-core-purity.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(output).toContain('core: pure');
    expect(Number(output.match(/\((\d+) modules/)?.[1])).toBeGreaterThan(0);
  });
});
