/**
 * The extension and the MCP server ship from one tag but land in two places —
 * a zip on GitHub, a package on npm. CI enforces that the tag matches all three
 * version files; this catches the drift before the tag exists, which is the only
 * point where it is still cheap to fix.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageFile {
  version: string;
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  /** A lockfile states its own package's version here as well as at the top. */
  packages?: Record<string, { version?: string }>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) =>
  JSON.parse(readFileSync(resolve(root, file), 'utf8')) as PackageFile;

const pkg = read('package.json');
const manifest = read('public/manifest.json');
const server = read('mcp-server/package.json');
const serverLock = read('mcp-server/package-lock.json');

describe('versions', () => {
  it('agree across package.json, the manifest and the MCP server', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
  });

  /**
   * The fourth and fifth places, and the two nothing was watching.
   *
   * `mcp-server/` is a second package with its own lockfile, so `npm version`
   * never touches it — it sat at 2.4.0 through two releases while the package
   * beside it published correctly, which is drift that costs nothing until the
   * day somebody reads the lockfile to find out what shipped. `sync-version`
   * writes both fields now; this is what notices if it stops.
   */
  it('agree in the MCP server lockfile, which npm version does not reach', () => {
    expect(serverLock.version).toBe(pkg.version);
    expect(serverLock.packages?.['']?.version).toBe(pkg.version);
  });
});

describe('the published MCP server', () => {
  it('exposes a bin, which is what makes `npx flowsnap-mcp` work at all', () => {
    expect(server.bin).toEqual({ 'flowsnap-mcp': 'server.js' });
  });

  it('starts with a shebang, or the bin is not executable', () => {
    const source = readFileSync(resolve(root, 'mcp-server/server.js'), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('publishes the server and nothing else', () => {
    /*
     * Without `files`, npm packs the whole directory — including flows/, which
     * is 125 real recordings of someone's browsing. `core.js` is `src/core/`
     * bundled in by `npm run build:mcp`; the server imports it, so a publish
     * that leaves it out ships something that throws on its first tool call.
     *
     * `install.js` is the same kind of hazard from the other direction: it is
     * imported only on the `npx flowsnap-mcp install` path, so a publish without
     * it passes every test that runs the server and fails the one command a
     * person types before they have a server at all.
     */
    expect(server.files).toEqual(['server.js', 'install.js', 'core.js', 'README.md']);
  });

  it('is not private, unlike the extension package', () => {
    expect(server.private).toBeUndefined();
    expect(pkg.private).toBe(true);
  });
});
