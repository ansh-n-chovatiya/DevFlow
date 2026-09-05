/**
 * Three gates that read as passing while the thing they guard was untrue.
 *
 * A gate is only worth its line in `verify` if a violation actually reaches it.
 * Each of these had a hole that let one through — a section-matching regex that
 * read an empty heading as content, a comment stripper that deleted the breach
 * it was scanning for, and an exemption that covered a colour written out in
 * full. All three produce a green tick, which is the one output a gate must
 * never get wrong.
 *
 * These test the *rules*, not the files: the rules are what regressed, and
 * asserting against the working tree would only say that today's tree is clean.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

interface Stripper {
  stripComments: (text: string, html: boolean) => string;
}
const STRIPPER = new URL('../scripts/lib/strip-comments.mjs', import.meta.url).href;

/**
 * The `## Unreleased` pattern, taken out of the script that uses it.
 *
 * Lifted by regex rather than imported because both scripts are top-level
 * programs: importing either one runs the gate.
 */
function unreleasedPattern(file: string): RegExp {
  const source = read(file);
  const match = source.match(/const UNRELEASED = (\/.*\/m);/);
  if (!match) throw new Error(`${file} no longer declares UNRELEASED`);
  return eval(match[1]) as RegExp;
}

const hasContent = (pattern: RegExp, text: string) => {
  const match = text.match(pattern);
  return Boolean(match && match[1].trim().length > 0);
};

describe('the changelog section rule', () => {
  const files = ['scripts/check-changelog.mjs', 'scripts/cut-release.mjs'];

  /*
   * `\s*` after the heading ate the blank line, and a bare `$` under `/m` is the
   * end of a *line* — so an empty `## Unreleased` above a version heading
   * captured that heading and read as filled in. The gate then passed a change
   * with no entry, and the release cutter would have cut notes from nothing.
   */
  it.each(files)('%s reads an empty section as empty', (file) => {
    const pattern = unreleasedPattern(file);
    expect(
      hasContent(pattern, '# Changelog\n\n## Unreleased\n\n## 4.0.1 — 2026-09-04\n\n- shipped\n'),
    ).toBe(false);
    expect(hasContent(pattern, '# Changelog\n\n## Unreleased\n')).toBe(false);
    expect(hasContent(pattern, '# Changelog\n\n## Unreleased\n\n')).toBe(false);
  });

  it.each(files)('%s reads a filled section as filled, and captures all of it', (file) => {
    const pattern = unreleasedPattern(file);
    const changelog = '# Changelog\n\n## Unreleased\n\n- one\n- two\n\n## 4.0.0 — 2026-01-01\n\n- old\n';

    expect(hasContent(pattern, changelog)).toBe(true);
    // The whole section, not its first line — the lazy group used to stop at
    // the first break, which made the capture unusable for anything but this
    // emptiness test.
    expect(changelog.match(pattern)?.[1]).toContain('- two');
    expect(changelog.match(pattern)?.[1]).not.toContain('4.0.0');
  });
});

describe('the changelog gate’s release-commit escape', () => {
  /*
   * The escape exists so the commit that cuts a release — which renames the
   * heading and bumps `public/manifest.json` — is not failed by the gate whose
   * changelog it just wrote. Testing only that the top heading names the
   * current version made it true of *every* commit after a release until
   * somebody opened a new `## Unreleased`, which is precisely the window the
   * gate is for: it was a no-op for the whole of it.
   */
  it('is narrowed to the files a release cut actually writes', () => {
    const source = read('scripts/check-changelog.mjs');

    expect(source).toContain("const RELEASE_WRITES = ['public/manifest.json'];");
    expect(source).toMatch(
      /headings\[0\]\?\.startsWith\(version\)\s*&&\s*shipped\.every\(\(file\) => RELEASE_WRITES\.includes\(file\)\)/,
    );
  });

  it('fails a src/ change with no entry, even at a version that was just cut', () => {
    // Run for real against this checkout. It is the state described above —
    // `CHANGELOG.md`'s top heading is the current version — so a pass here would
    // mean the escape is still unbounded. The exit code is the gate.
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    const headings = [...read('CHANGELOG.md').matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    if (!headings[0]?.startsWith(version)) return; // an Unreleased section is open; nothing to prove

    let code = 0;
    try {
      execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'src', 'public'], { cwd: root });
    } catch {
      code = 1;
    }
    if (code === 0) return; // nothing shipped is uncommitted; the gate has nothing to fire on

    expect(() =>
      execFileSync('node', ['scripts/check-changelog.mjs'], { cwd: root, stdio: 'pipe' }),
    ).toThrow();
  });
});

describe('the settings-UI gate’s comment stripper', () => {
  /*
   * `line.replace(/\/\/.*$/, '')` deletes from a `//` inside a string literal,
   * so a URL earlier on the line hid the breach after it. `check-brand` had
   * already met this and solved it character-wise; the copy in the settings gate
   * was the version with the hole.
   */
  it('keeps a breach that sits after a URL on the same line', async () => {
    const { stripComments } = (await import(/* @vite-ignore */ STRIPPER)) as Stripper;
    const line = `const help = 'https://example.com'; row.className = 'field';`;

    expect(stripComments(line, false)).toContain('.className');
    expect(line.replace(/\/\/.*$/, '')).not.toContain('.className');
  });

  it('still blanks a real comment', async () => {
    const { stripComments } = (await import(/* @vite-ignore */ STRIPPER)) as Stripper;
    expect(stripComments('const a = 1; // row.className = "x"', false)).not.toContain('.className');
    expect(stripComments('/* row.className */ const a = 1;', false)).not.toContain('.className');
  });

  it('names setAttribute("class") as a way of setting one', () => {
    // The third way to set a class, and the only one the list omitted —
    // `components.ts` itself uses it, because SVG has no `className` to assign.
    expect(read('scripts/check-settings-ui.mjs')).toMatch(/setAttribute.{0,20}class/);
  });
});

describe('the token gate’s var() exemption', () => {
  /*
   * `args.includes('var(--')` exempted the whole call, so
   * `rgb(255 0 0 / var(--alpha))` — a hardcoded channel triple — passed because
   * one token appeared somewhere inside the parentheses.
   */
  function literalChannels(): RegExp {
    const match = read('scripts/check-tokens.mjs').match(/const LITERAL_CHANNELS =\s*(\/.*\/i);/s);
    if (!match) throw new Error('check-tokens.mjs no longer declares LITERAL_CHANNELS');
    return eval(match[1]) as RegExp;
  }

  it('does not cover a colour written out beside the token', () => {
    const pattern = literalChannels();
    expect(pattern.test('255 0 0 / var(--alpha)')).toBe(true);
    expect(pattern.test('0, 0%, 40%, var(--a)')).toBe(true);
    expect(pattern.test('var(--a), #ff0000')).toBe(true);
  });

  it('leaves a colour genuinely built from tokens alone', () => {
    const pattern = literalChannels();
    expect(pattern.test('in srgb, var(--accent) 40%, transparent')).toBe(false);
    expect(pattern.test('var(--rgb) / 0.5')).toBe(false);
  });
});

describe('the extension zip', () => {
  /*
   * `vite.config.ts` builds with `sourcemap: true` and those maps inline
   * `sourcesContent`, so the archive people download — and the one that would go
   * to the Web Store — carried 1.8MB of this repository's TypeScript. `.DS_Store`
   * rode in from `public/`, which Vite copies wholesale.
   */
  it('excludes sourcemaps and .DS_Store', () => {
    const source = read('scripts/package.mjs');
    for (const pattern of ['*.map', '.DS_Store', '*/.DS_Store']) {
      expect(source).toContain(pattern);
    }
    // Handed to `zip` as exclusions rather than merely written down.
    expect(source).toMatch(/'-x',\s*\.\.\.EXCLUDE/);
  });
});

describe('the core/locate neutrality gate', () => {
  /*
   * The specifier pattern required a whole import statement to fit on one line,
   * so a formatter-wrapped `import {\n  x,\n} from '../react/fiber.js';` was
   * invisible. It saw 13 of the 15 specifiers actually in that directory, and
   * `needle.ts` — whose only import is multi-line — was scanned as importing
   * nothing at all.
   */
  it('sees every specifier in core/locate, however it is formatted', () => {
    const source = read('scripts/check-locate.mjs');
    // No `[^\n]` anywhere in a specifier pattern: that is what confined the
    // old one to a single line.
    expect(source).toMatch(/\\bfrom\\s\*/);
    expect(source).not.toMatch(/import\|export\)\[\^\\n\]/);
    expect(source).toContain('recursive: true');
  });

  it('reports as many modules as the directory holds', () => {
    const output = execFileSync('node', ['scripts/check-locate.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    const counted = Number(output.match(/\((\d+) modules\)/)?.[1]);
    expect(counted).toBeGreaterThan(0);
  });
});
