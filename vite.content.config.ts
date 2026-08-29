import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Builds the isolated-world content script as one standalone IIFE.
 *
 * Content scripts declared in the manifest are classic scripts: no `import`,
 * no module wrapper. Bundling to IIFE is what lets the source itself use real
 * modules — which is how `lib/selector.js`'s "do NOT wrap this in a module"
 * constraint goes away.
 *
 * Runs after the main build with `emptyOutDir: false` so it lands in the same dist.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false,
    target: 'chrome116',
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'FlowSnapContent',
      fileName: () => 'content.js',
    },
  },
});
