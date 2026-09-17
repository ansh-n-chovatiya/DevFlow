/**
 * The gate that was documented as checking §4.1 and checked §4.4 only.
 *
 * CLAUDE.md's gate table has described `lint:vocab` as *"the frozen glossary —
 * a flow is not a session, a component is not an element"* since the table was
 * written. A production audit falsified it the cheapest possible way: it changed
 * one real popup string from `Discard this flow?` to `Discard this session?`,
 * ran `lint:vocab` and `lint:brand`, and got two green ticks. The rule existed
 * in the contract and in the documentation and nowhere in the code.
 *
 * So the first two cases below are that mutation and its component/element
 * twin, applied to the *live* source files rather than to a hand-written
 * sample: a fixture that invents its own violation proves the regex works, not
 * that the gate sees the product. Each pair runs the file unmutated first — a
 * gate that fails both ways is not a gate — and asserts the real string is
 * still there, so renaming it fails this test loudly instead of quietly
 * removing the thing the test was aiming at.
 *
 * The rest are the cry-wolf cases. `session` is banned as a *word on a screen*,
 * and this repo ships 188 lines carrying `chrome.storage.session`,
 * `sessionStorage` and `session_id`, none of which it can rename. A gate that
 * fired on those would be turned off within a week, which is the failure mode
 * §4.5 already names about bare `rst:`.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * `check-vocab.mjs` over a tree of exactly `files`, and the exit code it gave.
 *
 * A temporary tree rather than the checkout, because the gate globs `src/` from
 * its own parent directory: running it against the working copy would only ever
 * say that today's working copy is clean, and mutating the working copy to ask
 * anything else is how a test run leaves a repository behind it.
 */
function gate(files: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-gate-'));

  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(resolve(root, 'scripts/check-vocab.mjs'), join(dir, 'scripts/check-vocab.mjs'));

    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }

    try {
      const out = execFileSync('node', ['scripts/check-vocab.mjs'], { cwd: dir, stdio: 'pipe' });
      return { code: 0, output: out.toString() };
    } catch (error) {
      const failure = error as { status: number | null; stdout: Buffer; stderr: Buffer };
      return { code: failure.status ?? 1, output: failure.stdout.toString() + failure.stderr.toString() };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the audit’s own mutation: a flow renamed a session', () => {
  const file = 'src/ui/popup/view.ts';
  const real = 'Discard this flow?';

  it('is still the string the audit mutated', () => {
    expect(read(file)).toContain(`title: '${real}',`);
  });

  it('passes the popup as shipped', () => {
    expect(gate({ [file]: read(file) }).code).toBe(0);
  });

  it('fails the popup with the flow renamed', () => {
    const run = gate({ [file]: read(file).split(real).join('Discard this session?') });

    expect(run.code).toBe(1);
    expect(run.output).toContain(`${file}:`);
    expect(run.output).toContain('a flow is one recording');
  });

  /*
   * The same rename inside a doc comment is deliberately clean. §4.1 governs
   * words a person reads, and the module comment on this very file quotes the
   * old wording as history — the same allowance §4.5 makes for provenance, and
   * the reason the noun rules read extracted prose rather than raw source.
   */
  it('leaves the same word in a comment alone', () => {
    const source = ['/** Once headed: Discard this session? */', "export const a = 'Discard this flow?';", ''].join('\n');

    expect(gate({ 'src/ui/popup/view.ts': source }).code).toBe(0);
  });
});

describe('the audit’s other noun: a component renamed an element', () => {
  const file = 'src/ui/components/result-card.ts';
  const real = 'this component’s source';

  it('is still the string this mutates', () => {
    expect(read(file)).toContain(real);
  });

  it('passes the card as shipped', () => {
    expect(gate({ [file]: read(file) }).code).toBe(0);
  });

  it('fails the card with the component renamed', () => {
    const run = gate({ [file]: read(file).split(real).join('this element’s source') });

    expect(run.code).toBe(1);
    expect(run.output).toContain('a source is the file and line a *component* was written in');
  });

  it.each([
    ['locate the element'],
    ['React element'],
    ['DOM component'],
    ['re-rendered elements'],
    ['parent element'],
  ])('fails prose saying “%s”', (wrong) => {
    expect(gate({ 'src/ui/locator/dom.ts': `export const t = 'Could not ${wrong} here.';\n` }).code).toBe(1);
  });

  /*
   * `pick` is the pairing that must stay legal: §4.2 defines it as *click an
   * element on the page*, so `Pick an element` is the glossary's own English —
   * while §4.4 freezes the button *label* as `Pick component`. A rule that read
   * the verb instead of the label would fail the contract it enforces.
   */
  it('leaves picking an element alone', () => {
    expect(gate({ 'src/ui/locator/dom.ts': `export const t = 'Pick an element on the page.';\n` }).code).toBe(0);
  });
});

describe('the identifiers the ban may not touch', () => {
  it.each([
    ["chrome.storage.session.get('devflow.live')"],
    ["window.sessionStorage.getItem('devflow.theme')"],
    ["const key = 'session_id';"],
    ["const header = 'x-session-id';"],
    ["const path = '/session/current';"],
    ['const label = `${sessionId} steps`;'],
  ])('passes %s', (line) => {
    expect(gate({ 'src/features/live.ts': `${line}\n` }).code).toBe(0);
  });

  it('still fails a key-shaped word that is really a sentence', () => {
    // The welding rule is about a delimiter *between two words*: a full stop
    // ending a sentence is not one, and reading it as one exempted the
    // commonest place a banned noun sits.
    expect(gate({ 'src/features/live.ts': "export const a = 'No sessions.';\n" }).code).toBe(1);
  });

  it('still fails a sentence a person reads, in the same file', () => {
    const source = [
      "chrome.storage.session.get('devflow.live');",
      "export const empty = 'No sessions yet.';",
      '',
    ].join('\n');
    const run = gate({ 'src/features/live.ts': source });

    expect(run.code).toBe(1);
    expect(run.output).toContain('src/features/live.ts:2');
  });

  it('reads a template literal’s text and not its holes', () => {
    expect(gate({ 'src/ui/popup/view.ts': 'export const a = `${sessionCount} steps`;\n' }).code).toBe(0);
    expect(gate({ 'src/ui/popup/view.ts': 'export const a = `${count} sessions saved`;\n' }).code).toBe(1);
  });

  it('reads an HTML title and not a class name', () => {
    expect(gate({ 'src/panel.html': '<div class="session-row">Saved flows</div>\n' }).code).toBe(0);
    expect(gate({ 'src/panel.html': '<button title="Delete this session">x</button>\n' }).code).toBe(1);
  });
});

describe('the one exempt sentence', () => {
  const file = 'src/features/settings/fields.ts';

  /*
   * The settings row for `state.maxStores` says the stores cut first are the
   * ones wrapped around the whole app — "the theme, the session". That names a
   * store in the *inspected* app, and §4.1 governs what DevFlow calls its own
   * things. The exemption is keyed on the sentence for a reason, and this is
   * the test of that reason: `fields.ts` holds nearly all of the settings copy.
   */
  it('exempts the page’s own session store', () => {
    expect(read(file)).toContain('the theme, the session');
    expect(gate({ [file]: read(file) }).code).toBe(0);
  });

  it('does not exempt the rest of the file', () => {
    const source = read(file).replace(
      'title: "Stores read",',
      'title: "Stores read", description2: "Kept for the session.",',
    );

    expect(source).toContain('Kept for the session.');
    expect(gate({ [file]: source }).code).toBe(1);
  });
});

describe('the §4.4 labels the gate already had', () => {
  it.each([['Pick Element'], ['Pick Component'], ['Locate component'], ['Copy Path']])(
    'still fails “%s”',
    (wrong) => {
      expect(gate({ 'src/ui/locator/dom.ts': `const label = '${wrong}';\n` }).code).toBe(1);
    },
  );

  it('still reads a comment for those, unlike the noun rules', () => {
    expect(gate({ 'src/ui/locator/dom.ts': '// was: Pick Element\n' }).code).toBe(1);
  });
});
