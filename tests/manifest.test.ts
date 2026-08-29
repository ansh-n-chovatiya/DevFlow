/**
 * The manifest lines that other code has been written to depend on.
 *
 * `unlimitedStorage` is the load-bearing one. The worker used to measure usage
 * before every capture and drop the screenshot past a budget; that guard is gone
 * because the permission makes it unnecessary. If the permission ever goes with
 * it, the two changes do not cancel out — recordings would hit Chrome's 10 MB
 * default with nothing left to catch them, and steps would fail to save.
 *
 * The rest of this file is about the merge. One manifest now declares every
 * surface of what used to be two extensions, and three of the assertions below
 * exist because the merge *deleted* something: a permission prompt that has
 * nothing left to ask for, a web-accessible agent that no longer needs to be
 * read and eval'd into the page, and a content-security policy that only ever
 * restated Chrome's own default. Each was removed deliberately, and each would
 * be easy to reintroduce by porting one more line from the old manifest.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface ContentScript {
  matches: string[];
  js: string[];
  run_at?: string;
  world?: string;
}

const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8')) as {
  manifest_version: number;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions?: string[];
  content_security_policy?: Record<string, string>;
  minimum_chrome_version: string;
  devtools_page?: string;
  content_scripts: ContentScript[];
  options_ui?: { page: string; open_in_tab?: boolean };
  action?: { default_popup?: string };
  web_accessible_resources?: { resources: string[]; matches: string[] }[];
};

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');

describe('the manifest', () => {
  it('asks for unlimited storage, because nothing else guards the quota now', () => {
    expect(manifest.permissions).toContain('unlimitedStorage');
  });

  it('still asks for storage itself — unlimitedStorage does not imply it', () => {
    expect(manifest.permissions).toContain('storage');
  });

  it('targets a Chrome new enough for the 10 MB default it is lifting', () => {
    // storage.local was 5 MB before Chrome 114. The floor being above that is
    // what makes "10 MB was the default" true rather than approximately true.
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(114);
  });

  it('is MV3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('is one product, by name', () => {
    expect(manifest.name).toBe('DevFlow — Record & Locate');
  });

  it('says what both halves do, so the store listing is not half the product', () => {
    expect(manifest.description).toMatch(/record/i);
    expect(manifest.description).toMatch(/source|component/i);
  });

  it('takes its version from package.json — sync-version writes it, nobody edits it', () => {
    expect(manifest.version).toBe(pkg.version);
  });
});

describe('the merged surface', () => {
  it('declares every page: popup, DevTools, options', () => {
    expect(manifest.action?.default_popup).toBe('popup.html');
    expect(manifest.devtools_page).toBe('devtools.html');
    expect(manifest.options_ui?.page).toBe('settings.html');
    // In a tab, not the cramped embedded dialog — 73 setting rows do not fit it.
    expect(manifest.options_ui?.open_in_tab).toBe(true);
  });

  /*
   * A page the manifest names but the build never emits fails silently: Chrome
   * loads the extension, the panel simply never appears in DevTools, and there
   * is no error anywhere to say why. The manifest and the Rollup input list are
   * two halves of one statement, so they are checked against each other.
   */
  it('names only pages the build actually produces', () => {
    const pages = [
      manifest.action?.default_popup,
      manifest.devtools_page,
      manifest.options_ui?.page,
      ...(manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources),
    ].filter((page): page is string => Boolean(page?.endsWith('.html')));

    for (const page of pages) {
      expect(existsSync(resolve(root, 'src', page)), `src/${page} is missing`).toBe(true);
      expect(viteConfig, `${page} is not a Rollup input`).toContain(`src/${page}`);
    }
  });

  it('builds the panel too, which only devtools.html names', () => {
    // panel.html is referenced by `devtools.panels.create`, not by the manifest,
    // so the check above cannot see it — and an unlisted HTML entry is not built.
    expect(existsSync(resolve(root, 'src/panel.html'))).toBe(true);
    expect(viteConfig).toContain('src/panel.html');
  });

  it('injects one MAIN-world agent, at document_start, everywhere', () => {
    const agent = manifest.content_scripts.find((script) => script.world === 'MAIN');
    expect(agent).toBeDefined();
    expect(agent?.js).toEqual(['injected/agent.js']);
    expect(agent?.matches).toEqual(['<all_urls>']);
    // Later than document_start and the page has already run code the recorder
    // was meant to observe.
    expect(agent?.run_at).toBe('document_start');
  });

  it('still ships the isolated-world content script that talks to the worker', () => {
    const content = manifest.content_scripts.find((script) => script.world === undefined);
    expect(content?.js).toEqual(['content.js']);
  });
});

describe('what the merge deleted', () => {
  /*
   * react-source-locator asked for `<all_urls>` at runtime, through
   * `optional_host_permissions` and a prompt in its panel. DevFlow holds the
   * same origins as a static grant, which is a superset — there is nothing left
   * to ask for, and an optional permission alongside a static one that already
   * covers it is a prompt that can only ever be answered "you already have it".
   */
  it('has no optional host permissions, because the static grant is a superset', () => {
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.host_permissions).toContain('<all_urls>');
  });

  /*
   * The locator exposed its agent as a web-accessible resource so the panel
   * could read the built file and eval it into the page on demand. DevFlow's
   * agent is a manifest content script that is already there. Re-exposing it
   * would hand every page on the web the ability to fetch the extension's own
   * injected code — and would also make the extension fingerprintable.
   */
  it('does not expose the agent to pages — it is already injected into them', () => {
    const exposed = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources);
    expect(exposed).not.toContain('injected/agent.js');
  });

  /*
   * The locator declared `extension_pages: "script-src 'self'; object-src
   * 'self'"`, which is character-for-character Chrome's MV3 default. A policy
   * that restates the default enforces nothing and hides the fact that MV3 is
   * what is doing the work — while looking exactly like the knob to turn when
   * someone wants to relax it. If a real tightening is ever wanted it must
   * *differ* from the default to mean anything, and this assertion is where
   * that argument gets made.
   */
  it('declares no content security policy, because MV3 already is one', () => {
    expect(manifest.content_security_policy).toBeUndefined();
  });
});
