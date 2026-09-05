/**
 * A responsive rule only takes effect if it is written after the rule it undoes.
 *
 * A media query carries no specificity of its own. `@media (max-width: 900px)
 * { .rail { position: static } }` and `.rail { position: sticky }` are both one
 * class, so the file's order decides which survives — and a stylesheet that
 * groups its layout at the top and its components below will put the override
 * three hundred lines *above* the thing it overrides, where it silently loses.
 *
 * This is the worst shape a CSS bug takes. Nothing warns, the rule is right
 * there in the file for anyone who goes looking, and it is invisible on the
 * wide window it is not for. Both surfaces shipped it: the settings rail stayed
 * a tall sticky column pinned under the app bar and drew over the settings
 * beside it, and the flow review's rail — a sidebar whose height is the
 * viewport — was never hidden, so a narrow window got a screenful of navigation
 * standing between the reader and the flow. Neither strip had ever rendered.
 *
 * So the rule is checked rather than remembered. Reported by file and line,
 * because the fix is always the same one: move the block below what it changes.
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The stripper, imported the way `audit-mcp-scripts` imports it: it is a plain
 * `.mjs` with no declaration file, so a static import is an implicit `any` and
 * fails the gate this file is part of.
 */
interface Stripper {
  stripComments: (text: string, html: boolean) => string;
}
const { stripComments } = (await import(
  new URL('../scripts/lib/strip-comments.mjs', import.meta.url).href
)) as Stripper;

/** Every `.css` under a directory. `fs.globSync` is Node 22+ and experimental. */
function stylesheets(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...stylesheets(path));
    else if (entry.name.endsWith('.css')) out.push(path);
  }
  return out;
}

const sheets = [...stylesheets('src'), ...stylesheets('public')];

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** The `{ … }` starting at `open`, matched by depth. */
function block(css: string, open: number): { body: string; end: number } {
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return { body: css.slice(open + 1, i - 1), end: i };
}

interface Loss {
  sheet: string;
  selector: string;
  overrideLine: number;
  baseLine: number;
}

/**
 * Every selector a media query changes whose unconditional rule comes later.
 *
 * Comments are blanked first — offsets preserved, so the reported lines are the
 * editor's — because prose about a rule routinely contains braces, and a naive
 * scan counts those and loses the block it was measuring.
 */
function lostOverrides(sheet: string): Loss[] {
  const raw = readFileSync(resolve(root, sheet), 'utf8');
  const css = stripComments(raw, false);
  const found: Loss[] = [];

  for (const at of [...css.matchAll(/@media[^{]*\{/g)]) {
    const open = at.index + at[0].length - 1;
    const { body } = block(css, open);

    // Top-level selectors inside the query. Nested at-rules are not used here.
    for (const rule of body.matchAll(/(?:^|\})\s*([^{}@]+?)\s*\{/g)) {
      for (const selector of rule[1].split(',').map((s) => s.trim())) {
        if (!selector) continue;

        // The unconditional rule for the same selector: written at column zero,
        // which is what puts it outside a query in every sheet here.
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const base = css.match(new RegExp(`^${escaped}\\s*(?:,[^{]*)?\\{`, 'm'));
        if (base?.index === undefined || base.index < at.index) continue;

        found.push({
          sheet,
          selector,
          overrideLine: lineOf(css, at.index),
          baseLine: lineOf(css, base.index),
        });
      }
    }
  }

  return found;
}

describe('responsive rules win over the ones they undo', () => {
  it('has stylesheets to check', () => {
    // A glob that matches nothing passes every assertion below it.
    expect(sheets.length).toBeGreaterThan(5);
  });

  it.each(sheets)('%s writes each media override after its base rule', (sheet) => {
    const losses = lostOverrides(sheet);
    const report = losses.map(
      (l) =>
        `${relative(root, l.sheet)}: the @media at line ${l.overrideLine} sets "${l.selector}", ` +
        `but "${l.selector}" is declared again at line ${l.baseLine} and wins. ` +
        `Move the media block below line ${l.baseLine}.`,
    );

    expect(report).toEqual([]);
  });

  it('catches an override written above its base rule', () => {
    // The check is worth nothing unless it fires, and every sheet is clean.
    const css = [
      '@media (max-width: 900px) {',
      '  .rail {',
      '    position: static;',
      '  }',
      '}',
      '',
      '.rail {',
      '  position: sticky;',
      '}',
    ].join('\n');

    // Written and read through the same path the real check uses, so the
    // fixture proves the scan and not a second copy of it.
    const scratch = resolve(root, 'src/ui/styles/__order-fixture.css');
    writeFileSync(scratch, css);
    try {
      const losses = lostOverrides(relative(root, scratch));
      expect(losses).toHaveLength(1);
      expect(losses[0]?.selector).toBe('.rail');
      expect(losses[0]?.baseLine).toBe(7);
    } finally {
      rmSync(scratch, { force: true });
    }
  });
});
