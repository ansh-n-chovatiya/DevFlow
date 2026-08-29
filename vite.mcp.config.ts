import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Bundles `src/core/` into the MCP server package as `mcp-server/core.js`.
 *
 * The server ships to npm on its own and cannot import TypeScript from `src/`,
 * so before this it kept a hand-written second copy of the markdown renderer —
 * see `src/core/mcp-bundle.ts` for what that cost. `core/` is pure by rule, so
 * it bundles to plain Node ESM with no dependencies and nothing to shim.
 *
 * Not minified: this is published source that someone may well read while
 * debugging why their flow rendered the way it did, and it is 20 KB either way.
 *
 * `emptyOutDir` is off because the output directory is the server package, which
 * holds `server.js` and its `package.json`.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'mcp-server'),
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/core/mcp-bundle.ts'),
      formats: ['es'],
      fileName: () => 'core.js',
    },
  },
});
