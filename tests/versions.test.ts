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
  /** The published name. Asserted for the two packages that have one. */
  name?: string;
  version: string;
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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
const plugin = read('compiler-plugin/package.json');

describe('versions', () => {
  it('agree across package.json, the manifest and the MCP server', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
  });

  /*
   * The third package. It was watched for four releases while it was still
   * private, on the grounds that the day it is published is not the day to
   * discover its version had sat at 3.1.1 the whole time — and that day has now
   * come, at 4.0.0. It has no lockfile of its own: no dependencies, only a
   * `@babel/core` peer.
   *
   * It is published having only ever been run against this repository's own
   * fixtures, never a real application's build. That is a real risk and it is
   * recorded here rather than anywhere it can be missed, because this is a
   * *Babel plugin*: a defect in it breaks somebody else's compile, not their
   * DevFlow experience.
   */
  it('agree in the compiler plugin', () => {
    expect(plugin.version).toBe(pkg.version);
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
  /*
   * The bin is deliberately *not* the package name, and the package name has
   * moved twice. `devflow-mcp` was taken on npm by an unrelated package before
   * this one existed; `devflow-mcp-server`, which this shipped as until 3.0.0,
   * belongs to an account that was lost and cannot be recovered, so nothing can
   * be published to it again. The package is now `devflow-server` and the
   * command it installs stays the shorter name through all of it.
   *
   * `npx -y devflow-server` still works: npm exec falls back to the only
   * bin when the requested name matches none. That fallback is the whole reason
   * a single entry here matters — add a second bin and the fallback is gone,
   * and every install instruction in the README breaks at once.
   */
  it('exposes exactly one bin, which is what makes `npx devflow-server` work', () => {
    expect(server.bin).toEqual({ 'devflow-mcp': 'server.js' });
    expect(Object.keys(server.bin ?? {})).toHaveLength(1);
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
     * imported only on the `npx devflow-server install` path, so a publish without
     * it passes every test that runs the server and fails the one command a
     * person types before they have a server at all.
     *
     * `arkg.js` is the third: the server reaches it through a guarded dynamic
     * import, so leaving it out throws nothing and fails nothing — every tool
     * keeps working and the knowledge graph is simply, permanently, absent.
     * That is the one failure mode a test has to hold, because nothing else
     * would ever report it.
     *
     * `replay.js` is the fourth and is the same shape as `arkg.js` one step
     * worse: it is imported dynamically and only once a user has switched
     * replay on, so a publish that omits it works perfectly for everyone who
     * never enables the feature and fails for exactly the person who did.
     *
     * `git.js` is the fifth, and it takes `arkg.js`'s road to a worse place. It
     * is reached through the same guarded dynamic import, so a publish that
     * omits it throws nothing, fails nothing and stamps nothing: every
     * recording is saved with no commit and the graph's `git_sha` columns are
     * NULL again — the exact defect the stamp exists to close, arrived at by
     * shipping rather than by deciding.
     *
     * `otel.js` is the sixth and is the quietest of the lot. It is reached
     * through the same guarded dynamic import *and* is gated on `DEVFLOW_OTEL`,
     * so omitting it looks exactly like the switch being off: `get_backend_trace`
     * says span ingest is not on, which is what it says when span ingest is not
     * on. The user turns the variable on, sees the same sentence, and has no
     * thread to pull. Every other missing file here degrades into silence; this
     * one degrades into a wrong answer.
     *
     * `rsc.js` is the seventh and shares `otel.js`'s failure mode with one extra
     * turn of the screw. It is reached through a guarded dynamic import, is
     * gated on `DEVFLOW_RSC`, *and* answers only for Next.js projects — so
     * omitting it is indistinguishable from the switch being off, from the
     * feature not applying, and from the user's app simply not being Next.
     * Three innocent explanations for one missing file is more cover than any
     * other entry here gets.
     *
     * `regression.js` and `regression-cli.js` are the eighth and ninth, and
     * they fail the way `install.js` does rather than the way `arkg.js` does:
     * they are reached only from `devflow-mcp regression`, so a publish without
     * them passes every test that runs the server and throws
     * `ERR_MODULE_NOT_FOUND` on the one command a CI workflow runs — in
     * somebody else's pipeline, on a red build they did not cause.
     */
    expect(server.files).toEqual([
      'server.js',
      'install.js',
      'core.js',
      'arkg.js',
      'replay.js',
      'git.js',
      'otel.js',
      'rsc.js',
      'README.md',
      'regression.js',
      'regression-cli.js',
    ]);
  });

  it('is not private, unlike the extension package', () => {
    expect(server.private).toBeUndefined();
    expect(pkg.private).toBe(true);
  });
});

describe('the compiler plugin', () => {
  /*
   * `private: true` was a decision, and removing it was meant to be a
   * deliberate edit to this test rather than a side effect of running
   * `npm publish` in the wrong directory. That edit has now been made, at
   * 4.0.0, and this is what it turned into.
   *
   * The caveat the old assertion existed for has not gone away and is written
   * down instead: the plugin has only ever been run against this repository's
   * own fixtures, never a real application's build. An npm package is a thing
   * people install and cannot un-install, and this one is a *Babel plugin* — a
   * defect in it breaks somebody else's compile rather than their DevFlow
   * experience. `compiler-plugin/README.md` says so where an installer reads.
   *
   * What is asserted now is the other direction: that `private` cannot come
   * back by accident, which would make a release a silent no-op for this
   * package while the server beside it published normally.
   */
  it('is publishable, and says which package it is', () => {
    expect(plugin.private).toBeUndefined();
    expect(plugin.name).toBe('devflow-compiler-plugin');
  });

  /*
   * The `files` list matters before the package is published, not after.
   * Without it npm packs the whole directory; with the wrong contents it packs
   * a plugin that cannot be loaded. Both are found the first time somebody
   * installs it, which is the worst time to find either.
   */
  it('would publish the plugin, its types and its README, and nothing else', () => {
    expect(plugin.files).toEqual(['index.js', 'index.d.ts', 'README.md']);
  });

  /*
   * A Babel plugin has no runtime dependencies — it receives `types` from the
   * `api` argument Babel hands it. A real dependency here would be installed
   * into every consumer's tree for nothing.
   */
  it('depends on nothing, and names @babel/core as the peer it is handed', () => {
    expect(plugin.dependencies).toBeUndefined();
    expect(Object.keys(plugin.peerDependencies ?? {})).toEqual(['@babel/core']);
  });
});
