/**
 * The panel's idle view: the words on it, and the one thing it has to teach.
 *
 * `src/panel.html` is not typechecked and no view-model test can see it, so the
 * two failures this file exists for are the two that survive every other gate:
 *
 *   - **Vocabulary drift.** The idle button read `Pick Element` where CONTRACTS
 *     §4.4 freezes `Pick component`, and §4.1 draws the line the mistake crosses:
 *     a component is React's and an element is the DOM's. The panel locates
 *     components. `lint:brand` cannot see this — it greps for two dead product
 *     names — so the assertion goes here, beside the document it is about.
 *   - **A first run that teaches nothing.** `projectRoot` defaults to empty and
 *     `Open in Editor` cannot work without it. The card says so, but only after
 *     a pick; the idle view is where somebody is standing *before* one, and it
 *     advertised the picker and the tree and never the setting that gates the
 *     payoff.
 *
 * It reads the document rather than rendering it, the way `panel-markup.test.ts`
 * does: `main.ts` needs a DevTools window, and the assertions here are about
 * what the file says.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'src/panel.html'), 'utf8');

/** The slice of the document between two markers, so a claim is about one block. */
function between(from: string, until: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(until, start + from.length);
  expect(start, from).toBeGreaterThan(-1);
  expect(end, until).toBeGreaterThan(start);
  return html.slice(start, end);
}

const idle = between('id="view-idle"', 'id="view-picking"');
const strip = between('id="setup-hint"', 'class="feature-grid"');

describe('the idle view speaks the frozen vocabulary', () => {
  it('offers `Pick component`, the string CONTRACTS §4.4 freezes for it', () => {
    expect(idle).toContain('<span>Pick component</span>');
  });

  it('never calls a component an element in a label', () => {
    // §4.1: an element is a DOM node, and picking one is how a component is
    // reached — but the thing the panel then names, locates and opens is the
    // component, and the button says what it produces.
    expect(html).not.toMatch(/Pick Element/);
    expect(html).not.toMatch(/Locate Element/);
  });

  it('keeps both verbs of the gesture in the title', () => {
    // §4.2: a pick can succeed where a locate fails, so a title naming one of
    // them promises the wrong thing on exactly the outcomes that differ.
    const title = /<h1 class="hero-title">([^<]+)<\/h1>/.exec(idle)?.[1] ?? '';
    expect(title).toMatch(/\bPick\b/);
    expect(title).toMatch(/\blocate\b/);
    expect(title).toContain('component');
  });
});

describe('the idle view names the setting that gates the payoff', () => {
  it('carries a setup strip, hidden until the panel decides to show it', () => {
    expect(idle).toMatch(/id="setup-hint"[^>]*hidden/);
  });

  it('says `project root`, the noun CONTRACTS §4.1 freezes', () => {
    expect(strip).toContain('project root');
    // Not "workspace", not "repo path" — §4.1 lists both as the words this one
    // replaces.
    expect(strip).not.toMatch(/workspace|repo path/i);
  });

  it('is dismissible, and offers the setting rather than only naming it', () => {
    expect(strip).toContain('id="setup-hint-open"');
    expect(strip).toContain('id="setup-hint-dismiss"');
  });

  it('sits in the idle view, where somebody is standing before their first pick', () => {
    expect(idle).toContain('id="setup-hint"');
  });
});
