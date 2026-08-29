/**
 * The manifest lines that other code has been written to depend on.
 *
 * `unlimitedStorage` is the load-bearing one. The worker used to measure usage
 * before every capture and drop the screenshot past a budget; that guard is gone
 * because the permission makes it unnecessary. If the permission ever goes with
 * it, the two changes do not cancel out — recordings would hit Chrome's 10 MB
 * default with nothing left to catch them, and steps would fail to save.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8')) as {
  manifest_version: number;
  permissions: string[];
  minimum_chrome_version: string;
};

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
});
