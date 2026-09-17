/**
 * Pins the case-insensitivity fix for `lint:vocab` and `lint:brand`.
 *
 * report.md §3.8 P2: both gates were case-sensitive substring checks, so a
 * differently-cased or lowercase violation slipped straight through — a fact
 * `check-brand.mjs` documented as an accepted limitation for `FORMER`
 * (`FlowSnap`) alone and disclosed nowhere for the `BANNED` list or for
 * `check-vocab.mjs`'s frozen labels. Reproduced by hand first, against the
 * *original* scripts, before this fix landed:
 *
 *   - `check-vocab.mjs`: `'copy path'` (all lowercase) passed, because the
 *     gate only enumerated `Copy Path` — one specific wrong casing — and did
 *     a case-sensitive `String.includes`.
 *   - `check-brand.mjs`: `devprecision` (all lowercase) passed, because
 *     `BANNED` matching was a case-sensitive `String.includes` too.
 *
 * Both are fixed by matching case-insensitively. The two cases below repeat
 * exactly that reproduction, plus the regression a blanket case-insensitive
 * fix would have introduced and had to be carved back out by hand:
 * `check-vocab.mjs`'s *correctly*-cased frozen labels case-fold identically
 * to some of their own "wrong casing" entries (`Pick component` vs. `Pick
 * Component`) and must keep passing; `check-brand.mjs`'s `React Source` ban
 * case-folds identically to this codebase's own core vocabulary (`source` —
 * CONTRACTS §4.1) written in two real section-header comments, which must
 * keep passing too.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * Runs `scripts/<script>` over a temporary tree of exactly `files`.
 *
 * A temporary tree rather than the checkout, for the same reason
 * `audit-vocab-lint.test.ts`'s `gate()` uses one: both gates glob `src/` and
 * `public/` from their own parent directory, so running against the working
 * copy only ever proves today's checkout is clean.
 */
function gate(script: string, files: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-case-gate-'));

  try {
    mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
    writeFileSync(join(dir, 'scripts', script), read(`scripts/${script}`));
    writeFileSync(join(dir, 'scripts/lib/strip-comments.mjs'), read('scripts/lib/strip-comments.mjs'));

    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }

    try {
      const out = execFileSync('node', [`scripts/${script}`], { cwd: dir, stdio: 'pipe' });
      return { code: 0, output: out.toString() };
    } catch (error) {
      const failure = error as { status: number | null; stdout: Buffer; stderr: Buffer };
      return { code: failure.status ?? 1, output: failure.stdout.toString() + failure.stderr.toString() };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const vocab = (files: Record<string, string>) => gate('check-vocab.mjs', files);
const brand = (files: Record<string, string>) => gate('check-brand.mjs', files);

describe('lint:vocab is now case-insensitive on the frozen labels', () => {
  it('passed an all-lowercase frozen-label violation before this fix (the reproduction)', () => {
    // Confirms the fixture below is a genuine violation of the *right* words,
    // just the wrong case — not a typo that would have failed for some other
    // reason regardless of case-sensitivity.
    const source = "export const label = 'Copy Path';\n";
    expect(vocab({ 'src/ui/components/result-card.ts': source }).code).toBe(1);
  });

  it.each([
    ["export const label = 'copy path';\n", 'copy path'],
    ["export const label = 'COPY PATH';\n", 'COPY PATH'],
    ["export const label = 'pick another';\n", 'pick another'],
  ])('now fails a lowercase/uppercase frozen-label violation: %s', (source) => {
    const run = vocab({ 'src/ui/components/result-card.ts': source });

    expect(run.code).toBe(1);
    expect(run.output).toContain('CONTRACTS §4.4');
  });

  it('still passes the exact frozen casing, even though a wrong-casing entry for the same words case-folds identically to it', () => {
    // `Pick Component` is listed as a wrong spelling of the frozen `Pick
    // component` specifically to catch a mis-cased `C` — but case-insensitive
    // matching means the *correct* `Pick component` case-folds to that same
    // wrong entry. This is the false positive a naive fix would introduce.
    const source = "export const label = 'Pick component';\n";
    expect(vocab({ 'src/ui/locator/dom.ts': source }).code).toBe(0);
  });

  it('still fails the same words in the wrong case', () => {
    const source = "export const label = 'Pick Component';\n";
    const run = vocab({ 'src/ui/locator/dom.ts': source });

    expect(run.code).toBe(1);
    expect(run.output).toContain('Pick Component');
  });

  it('now fails the §4.1 noun pairing in a case it used to miss', () => {
    // `React elements`/`DOM components` were regex-matched without the `i`
    // flag while every other PAIRS rule already carried one — the same class
    // of gap, one level down.
    const run = vocab({
      'src/ui/locator/dom.ts': "export const t = 'A dom component was picked.';\n",
    });

    expect(run.code).toBe(1);
    expect(run.output).toContain("the DOM's noun is element");
  });

  it('stays green on the live checkout', () => {
    expect(read('scripts/check-vocab.mjs')).toBeTruthy();
    const out = execFileSync('node', ['scripts/check-vocab.mjs'], { cwd: root }).toString();
    expect(out).toContain('files clean');
  });
});

describe('lint:brand is now case-insensitive on BANNED and FORMER', () => {
  it('passed an all-lowercase BANNED violation before this fix (the reproduction)', () => {
    const source = '// DevPrecision was the other design system.\n';
    expect(brand({ 'src/background/index.ts': source }).code).toBe(1);
  });

  it.each([
    ['// devprecision was the other design system.\n', 'devprecision'],
    ['// DEVPRECISION was the other design system.\n', 'DEVPRECISION'],
    ['// __rst is the other page global.\n', '__rst'],
  ])('now fails a lowercase/uppercase BANNED violation: %s', (source) => {
    const run = brand({ 'src/background/index.ts': source });

    expect(run.code).toBe(1);
    expect(run.output).toContain("the other product");
  });

  it.each([
    ["export const a = 'flowsnap was the working name.';\n", 'flowsnap'],
    ["export const a = 'FLOWSNAP was the working name.';\n", 'FLOWSNAP'],
  ])('now fails a lowercase/uppercase FORMER violation: %s', (source) => {
    const run = brand({ 'src/ui/popup/view.ts': source });

    expect(run.code).toBe(1);
    expect(run.output).toContain('in text a person reads');
  });

  it('still leaves a former-product provenance comment alone, case-insensitively', () => {
    // §4.5's provenance allowance ("Ported from FlowSnap's table.ts") is
    // comments-only; it must survive the case-insensitivity fix exactly as
    // it did before, for any casing of the name.
    const source = "/** ported from FLOWSNAP's `table.ts`. */\nexport const a = 1;\n";
    expect(brand({ 'src/ui/popup/view.ts': source }).code).toBe(0);
  });

  it('still passes this codebase\'s own "React source" vocabulary, which case-folds identically to the banned brand name', () => {
    // `React Source` is Title Case in the ban and `React source` (lowercase
    // `s`) is this codebase's own compound noun for the thing DevFlow
    // resolves (CONTRACTS §4.1). Case-sensitive matching told the two apart
    // for free; going case-insensitive needed the two real section-header
    // comments this collides with named explicitly (`NOT_BANNED`).
    const run = brand({
      'src/background/index.ts': '// ── React source resolution ────\n',
    });

    expect(run.code).toBe(0);
  });

  it('still fails the actual banned name in the same casing the exemption protects', () => {
    // The exemption is keyed to the exact two known-safe lines, not to the
    // word "source" in general — a real occurrence of the Title Case name on
    // an unlisted line must still fail.
    const run = brand({
      'src/background/index.ts': "export const a = 'React Source was the other extension.';\n",
    });

    expect(run.code).toBe(1);
  });

  it('stays green on the live checkout', () => {
    const out = execFileSync('node', ['scripts/check-brand.mjs'], { cwd: root }).toString();
    expect(out).toContain('files clean');
  });
});
