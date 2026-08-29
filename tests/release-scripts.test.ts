import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('release automation and changelog gate', () => {
  it('CHANGELOG.md contains a valid ## Unreleased section or topmost release heading', () => {
    const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
    const headings = [...changelog.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

    expect(headings.length).toBeGreaterThan(0);
    const hasUnreleased = headings.some((h) => h.toLowerCase() === 'unreleased');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

    // Either we have an Unreleased section ready for the next release, or topmost heading matches current version
    expect(hasUnreleased || headings[0].startsWith(pkg.version)).toBe(true);
  });

  it('scripts are registered in package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['lint:changelog']).toBe('node scripts/check-changelog.mjs');
    expect(pkg.scripts['release']).toBe('node scripts/cut-release.mjs');
  });
});
