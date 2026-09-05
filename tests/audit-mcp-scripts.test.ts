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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
   * changelog it just wrote. It has now been wrong in both directions, which is
   * why these run against a real repository rather than against the source.
   *
   * Too loose first: testing only that the top heading names the current
   * version made it true of *every* commit after a release until somebody
   * opened a new `## Unreleased` — precisely the window the gate is for, and a
   * no-op for the whole of it.
   *
   * Then too tight: "the shipped files are only the ones a release cut writes"
   * held for the release *commit* and failed the first real release push,
   * because a push is measured against what the branch pointed at before it. A
   * branch pushed with its work and its release spans both, so every file of
   * the work is in `shipped` while the section it was written under has just
   * been renamed. A test that pinned that sentence passed while the gate broke.
   * Two commits and two exit codes could not have.
   */
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'changelog-gate-'));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'gate@example.test');
    run('config', 'user.name', 'Gate');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    copyFileSync(resolve(root, 'scripts/check-changelog.mjs'), join(dir, 'scripts/check-changelog.mjs'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.0' }));
    return dir;
  }

  /** The gate's exit code in `dir`, measured over everything since `before`. */
  function gate(dir: string, before: string): number {
    try {
      execFileSync('node', ['scripts/check-changelog.mjs'], {
        cwd: dir,
        stdio: 'pipe',
        env: { ...process.env, BEFORE_SHA: before, GITHUB_BASE_REF: '' },
      });
      return 0;
    } catch {
      return 1;
    }
  }

  it('passes a push that carries the work and the release that documents it', () => {
    const dir = fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- the work\n');
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').toString().trim();

    // The work, then the release that renames the section it was written under.
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'work');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0 — 2026-09-05\n\n- the work\n');
    git('add', '-A');
    git('commit', '-qm', 'v1.2.0');

    expect(gate(dir, base)).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('still fails a change pushed after that release with nothing written down', () => {
    const dir = fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0 — 2026-09-05\n\n- shipped\n');
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'v1.2.0');
    const released = git('rev-parse', 'HEAD').toString().trim();

    // The window the whole escape is about: the heading still names the current
    // version, and this work has no entry anywhere.
    writeFileSync(join(dir, 'src/b.ts'), 'export const b = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'later work');

    expect(gate(dir, released)).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  /*
   * There was a third case here, run against the live checkout: "the top
   * heading is the current version and something under `src/` is uncommitted,
   * so the gate must fail." It is deleted rather than repaired, and the reason
   * is worth keeping.
   *
   * That is not a description of the no-op window. It is a description of a
   * release being cut — `cut-release.mjs` renames the heading and bumps
   * `public/manifest.json`, and runs `npm run verify` before it commits, so the
   * tree it verifies is exactly that state with the work still in the range.
   * The changes *are* written down, under the heading the rename just made. So
   * the assertion fired on the one operation it had to allow, and `npm run
   * release patch` failed on its own gate.
   *
   * It also could not have caught the bug it was aimed at: it asserted the
   * behaviour of the too-tight rule, which is the rule that broke the v4.1.0
   * push. The two cases above cover the same ground from fixtures, where the
   * repository's state is built rather than borrowed and neither answer depends
   * on when the suite happens to run.
   */
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
