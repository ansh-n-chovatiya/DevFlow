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

/*
 * `compiler-plugin/package.json` was here through four releases while it was
 * still `private: true`, on the grounds that the day it is published is not the
 * day to discover its version had sat at 3.1.1 the whole time. That day was
 * 4.0.0, and the reason it was already correct is this line. It has no lockfile
 * of its own — no dependencies, only a `@babel/core` peer.
 */
for (const file of [
  'public/manifest.json',
  'mcp-server/package.json',
  'mcp-server/package-lock.json',
  'compiler-plugin/package.json',
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
