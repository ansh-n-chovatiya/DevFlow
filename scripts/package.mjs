/**
 * Packages dist/ into a release ZIP archive.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const releases = resolve(root, 'releases');

if (!existsSync(resolve(dist, 'manifest.json'))) {
  console.error('No dist/manifest.json — run `npm run build` first.');
  process.exit(1);
}

const shaIndex = process.argv.indexOf('--sha');
const sha = shaIndex === -1 ? null : process.argv[shaIndex + 1]?.slice(0, 7);

const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const name = sha ? `devflow-${version}-${sha}.zip` : `devflow-${version}.zip`;
const out = resolve(releases, name);

mkdirSync(releases, { recursive: true });
rmSync(out, { force: true });

/**
 * What never goes in the zip.
 *
 * `vite.config.ts` builds the pages and the worker with `sourcemap: true`, and
 * those maps carry `sourcesContent` — the original TypeScript, inlined. So the
 * archive people download and load unpacked, and the one that would go to the
 * Web Store, was shipping 1.8MB of this repository's own source alongside the
 * extension. Nothing reads them there: DevFlow resolves the *page's* source
 * maps, never its own, and the maps exist for debugging a local build.
 *
 * `.DS_Store` rides in from `public/`, which Vite copies wholesale. It is junk
 * in a directory listing and junk in an archive, and `-X` — which drops
 * extended attributes so the zip is reproducible — does not touch it, because
 * it is an ordinary file rather than metadata.
 *
 * Patterns are passed as separate arguments and read by `zip` itself; there is
 * no shell here to expand them first.
 */
const EXCLUDE = ['*.map', '.DS_Store', '*/.DS_Store'];

// Create reproducible ZIP archive without extended attributes.
execFileSync('zip', ['-qrX', out, '.', '-x', ...EXCLUDE], { cwd: dist, stdio: 'inherit' });

console.log(`releases/${name}`);
