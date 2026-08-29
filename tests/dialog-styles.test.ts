/**
 * Two rules about `<dialog>` that CSS lets you break silently.
 *
 * Both were broken in the first cut of the viewer and neither was visible until
 * the extension was loaded in Chrome:
 *
 *   1. `base.css` resets `margin` to 0 on every element. A modal dialog is
 *      centred by the browser's own `inset: 0` plus `margin: auto`, so the reset
 *      pinned every dialog in the product to the top-left corner.
 *   2. A rule that sets `display` on a dialog element overrides the UA's
 *      `display: none` for the closed state, leaving the dialog permanently on
 *      the page — in flow, pushing real content down, with none of its contents
 *      filled in because it was never opened.
 */

import { globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const files = [...globSync('src/**/*.css', { cwd: root }), ...globSync('public/*.css', { cwd: root })]
  .map((file) => file.split('\\').join('/'))
  .sort();

interface Rule {
  file: string;
  selector: string;
  body: string;
}

/** Leaf rule blocks. Adequate here: no dialog rule in this project is nested. */
function rules(file: string): Rule[] {
  const css = readFileSync(resolve(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    file,
    selector: match[1].trim(),
    body: match[2],
  }));
}

const all = files.flatMap(rules);
const dialogRules = all.filter((rule) => /(^|[\s,>])\.?dialog\b/.test(rule.selector));

describe('dialog rules', () => {
  it('finds the dialog styles at all, so a silent pass is not possible', () => {
    expect(dialogRules.length).toBeGreaterThan(0);
  });

  it('never sets display except on the open state', () => {
    const offenders = dialogRules
      .filter((rule) => /(^|[;{\s])display\s*:/.test(rule.body))
      .filter((rule) => !rule.selector.includes('[open]'))
      .map((rule) => `${rule.file}: ${rule.selector}`);

    expect(offenders).toEqual([]);
  });

  it('restores the margin the reset takes away, so a modal is centred', () => {
    const base = all.find((rule) => rule.selector === '.dialog');

    expect(base, '.dialog rule in components.css').toBeDefined();
    expect(base?.body).toMatch(/margin\s*:\s*auto/);
  });

  it('never overrides the position a modal is given by the browser', () => {
    const offenders = dialogRules
      .filter((rule) => /(^|[;{\s])position\s*:/.test(rule.body))
      .map((rule) => `${rule.file}: ${rule.selector}`);

    expect(offenders).toEqual([]);
  });
});
