/**
 * The viewer's controllers and its markup have to agree.
 *
 * `el()` and `find()` throw on a miss, so a renamed id or a mistyped class is a
 * blank screen at runtime and nothing at all at compile time — the one failure
 * mode that survives typecheck, lint and every view-model test in this suite.
 * This walks the source for every lookup and checks viewer.html can answer it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'src/viewer.html'), 'utf8');

const sources = readdirSync(resolve(root, 'src/ui/viewer'))
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, text: readFileSync(resolve(root, 'src/ui/viewer', file), 'utf8') }));

/** Every `<template id="…">` and every `id="…"` the document defines. */
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

describe('every element the controllers look up exists', () => {
  it.each(sources)('$file', ({ text }) => {
    const wanted = matches(text, /\bel<[^>]*>\('([^']+)'\)|\bel\('([^']+)'\)/g).filter(Boolean);

    // The typed and untyped forms are separate capture groups, so collect both.
    const all = [...text.matchAll(/\bel(?:<[^>]*>)?\('([^']+)'\)/g)].map((match) => match[1]);
    expect(wanted.length).toBeLessThanOrEqual(all.length);

    for (const id of all) expect(ids, `#${id}`).toContain(id);
  });
});

describe('every template the controllers clone exists', () => {
  const templates = new Set(
    [...html.matchAll(/<template id="([^"]+)"/g)].map((match) => match[1]),
  );

  it.each(sources)('$file', ({ text }) => {
    for (const id of matches(text, /\bclone(?:<[^>]*>)?\('([^']+)'\)/g)) {
      expect(templates, `<template id="${id}">`).toContain(id);
    }
  });
});

describe('every class and action the controllers query is in the markup', () => {
  /** Class names the stylesheet or the controllers create at runtime. */
  const BUILT_AT_RUNTIME = new Set(['menu', 'segmented__option', 'swatch', 'rail-row', 'step']);

  it.each(sources)('$file', ({ text }) => {
    const selectors = [
      ...matches(text, /\bfind(?:<[^>]*>)?\([^,]+,\s*'([^']+)'\)/g),
      ...matches(text, /querySelectorAll<[^>]*>\('([^']+)'\)/g),
    ];

    for (const selector of selectors) {
      for (const name of matches(selector, /\.([a-zA-Z][\w-]*)/g)) {
        if (BUILT_AT_RUNTIME.has(name)) continue;
        expect(html, `.${name} in ${selector}`).toMatch(new RegExp(`\\b${name}\\b`));
      }

      for (const action of matches(selector, /data-action="([^"]+)"/g)) {
        expect(html, `[data-action="${action}"]`).toContain(`data-action="${action}"`);
      }
    }
  });
});

describe('the markup itself', () => {
  it('names every icon the icon set actually has', () => {
    const generated = readFileSync(resolve(root, 'src/ui/icons.generated.ts'), 'utf8');
    const known = new Set([...generated.matchAll(/^\s*'?([\w-]+)'?:\s*$/gm)].map((m) => m[1]));

    for (const name of [...html.matchAll(/data-icon="([^"]+)"/g)].map((m) => m[1])) {
      // `hydrateIcons` skips a name it does not know, so a typo here is a
      // silently missing glyph rather than an error.
      expect(known, `data-icon="${name}"`).toContain(name);
    }
  });

  it('declares no colour of its own', () => {
    // The same rule `npm run lint:tokens` enforces, asserted here so a colour
    // pasted into the markup fails the test run too.
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(html).not.toMatch(/\b(?:rgba?|hsla?)\(/i);
  });
});
