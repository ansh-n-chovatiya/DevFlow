/**
 * Packages dist/ into a release ZIP archive.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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

/**
 * The one timestamp every entry in the zip gets.
 *
 * `zip` stamps each entry with the mtime of the file it read from disk —
 * real wall-clock, different on every invocation even when `dist/` is
 * byte-for-byte the same output of the same build. Two otherwise identical
 * rebuilds therefore produced zips with different SHA-256s (report.md §3.5's
 * P2), which is exactly what "byte-reproducible" is supposed to rule out.
 *
 * HEAD's commit date, not `Date.now()`: two packagings of the same tree —
 * which is what "run `npm run package` twice back to back" verifies — share
 * a HEAD, so they share this value and the zips come out identical. Falls
 * back to a fixed epoch only when there is no commit to ask (no `.git`, e.g.
 * an extracted source tarball), so the script does not start depending on
 * git being present to run at all.
 */
function releaseEpochSeconds() {
  try {
    const stdout = execFileSync('git', ['log', '-1', '--format=%ct'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const epoch = Number(stdout);
    if (Number.isFinite(epoch) && epoch > 0) return epoch;
  } catch {
    // No .git, or git isn't on PATH — fall through to the fixed epoch below.
  }
  return 315532800; // 1980-01-01T00:00:00Z — the earliest date the ZIP/DOS format can encode.
}

/** Every file and directory under `dir`, mtime and atime pinned to `epochSeconds`. */
function pinTimestamps(dir, epochSeconds) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) pinTimestamps(full, epochSeconds);
    utimesSync(full, epochSeconds, epochSeconds);
  }
}

pinTimestamps(dist, releaseEpochSeconds());

// Create reproducible ZIP archive without extended attributes.
execFileSync('zip', ['-qrX', out, '.', '-x', ...EXCLUDE], { cwd: dist, stdio: 'inherit' });

console.log(`releases/${name}`);
