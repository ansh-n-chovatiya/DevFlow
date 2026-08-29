/**
 * Generates public/settings.default.json from default setting definitions.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/settings.default.json');

const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: null },
});

try {
  const { DEFAULTS } = await server.ssrLoadModule('/src/features/settings/fields.ts');

  // Sort keys for deterministic output.
  const sorted = Object.fromEntries(
    Object.keys(DEFAULTS)
      .sort()
      .map((key) => [key, DEFAULTS[key]]),
  );

  writeFileSync(out, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`settings: ${Object.keys(sorted).length} defaults → public/settings.default.json`);
} finally {
  await server.close();
}
