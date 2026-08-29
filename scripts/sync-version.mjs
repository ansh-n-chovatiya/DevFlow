/**
 * Synchronizes package.json version across manifest.json and subpackage configurations.
 *
 * `mcp-server/` is a second npm package with its own lockfile, and a lockfile
 * states its package's version in two places. npm keeps the root one in step
 * because `npm version` is what bumps it; nothing was keeping this one, so it
 * sat at 2.4.0 through two releases — publishing the right version from
 * `package.json` while the file beside it said otherwise.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

for (const file of [
  'public/manifest.json',
  'mcp-server/package.json',
  'mcp-server/package-lock.json',
]) {
  const path = resolve(root, file);
  const json = JSON.parse(readFileSync(path, 'utf8'));

  // A lockfile repeats it under `packages[""]`, and npm rewrites both.
  const self = json.packages?.[''];

  if (json.version === version && (!self || self.version === version)) {
    console.log(`${file} already at ${version}`);
    continue;
  }

  console.log(`${file} ${json.version} → ${version}`);
  json.version = version;
  if (self) self.version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}
