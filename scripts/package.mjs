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
const name = sha ? `flowsnap-${version}-${sha}.zip` : `flowsnap-${version}.zip`;
const out = resolve(releases, name);

mkdirSync(releases, { recursive: true });
rmSync(out, { force: true });

// Create reproducible ZIP archive without extended attributes.
execFileSync('zip', ['-qrX', out, '.'], { cwd: dist, stdio: 'inherit' });

console.log(`releases/${name}`);
