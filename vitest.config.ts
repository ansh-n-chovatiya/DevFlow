import { defineConfig } from 'vitest/config';

/**
 * Separate from vite.config.ts on purpose: the build config sets `root: 'src'`,
 * which would hide the tests/ directory from Vitest.
 *
 * Only `src/core/` is covered here — it is the layer with no `chrome.*` and no
 * DOM globals, which is precisely what makes it testable. Anything touching
 * Chrome APIs is exercised by loading the unpacked extension (see README).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Most of core is environment-free; the DOM-facing modules opt into jsdom
    // per file with `// @vitest-environment jsdom`.
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
});
