/**
 * The DevTools surface, checked where the compiler cannot reach.
 *
 * Three of these read source files as text rather than importing them, because
 * what they assert is not expressible in the type system: two files agreeing on
 * a string literal, an HTML document naming only icons that exist, and a
 * vocabulary. All three fail silently in the browser — a port name that has
 * drifted registers no panel and reports nothing, an unknown `data-icon` leaves
 * a blank space where a glyph was meant to be, and the wrong noun just reads
 * slightly wrong to someone who has no way to know it is a bug.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ICON_PATHS } from '../src/ui/icons.generated.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const devtools = read('src/devtools/index.ts');
const worker = read('src/background/index.ts');
const panel = read('src/panel.html');

/** The `const DEVTOOLS_PORT = '…'` a file declares, or null. */
function portName(source: string): string | null {
  return /const DEVTOOLS_PORT = '([^']+)'/.exec(source)?.[1] ?? null;
}

describe('the DevTools page', () => {
  /*
   * The port is how the worker learns that a panel has closed, and its name is
   * the only thing both ends of it can see. `src/shared/` was frozen in Wave 0
   * without this constant, so the two files each declare their own copy — which
   * is safe exactly as long as something notices when they stop agreeing.
   * Nothing else would: a port whose name the worker does not recognise is
   * ignored rather than refused, so the panel keeps working and every close
   * leaves an armed pick on the page.
   */
  it('connects with the port name the worker listens for', () => {
    const declared = portName(devtools);
    expect(declared).not.toBeNull();
    expect(portName(worker)).toBe(declared);
  });

  it('appends the inspected tab to the port name, which is how a close is attributed', () => {
    // A port from a DevTools page carries no `sender.tab`, so the name is the
    // only place the tab id can ride.
    expect(devtools).toContain('${DEVTOOLS_PORT}:${tabId}');
    expect(worker).toContain("port.name.split(':')");
  });

  it('registers the panel against the page the build emits', () => {
    expect(devtools).toContain("'panel.html'");
  });
});

describe('the panel markup', () => {
  /*
   * The bespoke sprite is replaced, not ported — CONTRACTS §5. Two icon
   * vocabularies is the single most visible tell that a product used to be two
   * products, and the sprite is how the second one gets back in: one `<symbol>`
   * looks like a local convenience rather than a second design system.
   */
  it('carries no SVG sprite', () => {
    expect(panel).not.toContain('symbol id="i-');
    expect(panel).not.toContain('href="#i-');
  });

  it('names only icons that exist', () => {
    const names = [...panel.matchAll(/data-icon="([^"]+)"/g)].map(([, name]) => name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(Object.keys(ICON_PATHS), `unknown icon: ${name}`).toContain(name);
    }
  });

  /*
   * CONTRACTS §4.4, as written. These are the strings seven packages have to
   * agree on, and the panel is where most of them appear at once.
   */
  it.each([
    'Pick component',
    'Pick another',
    'Open in Editor',
    'Open in Sources',
    'Copy path',
    'Recent',
    'Parent tree',
    'Siblings',
  ])('says %j', (label) => {
    expect(panel).toContain(label);
  });

  it('says nothing the other product used to say', () => {
    for (const source of [panel, devtools]) {
      expect(source).not.toContain('React Source');
      expect(source).not.toContain('DevPrecision');
      expect(source).not.toContain('__RST_');
      expect(source).not.toContain('rst:');
    }
  });

  /*
   * The result card is one component rendered by the panel, the popup and the
   * flow review. Markup for a second one here would compile, render, and look
   * right — and then drift the first time the shared card changes.
   */
  it('mounts the shared result card rather than writing its own', () => {
    expect(panel).toContain('id="result-card-slot"');
    expect(panel).not.toContain('id="result-name"');
    expect(panel).not.toContain('id="result-path"');
  });
});
