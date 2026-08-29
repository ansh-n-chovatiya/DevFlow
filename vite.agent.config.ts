import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Builds the MAIN-world agent as one standalone IIFE.
 *
 * This is the script that patches `console`, `fetch` and `XMLHttpRequest` in the
 * page's own JS context. Like the content script it is a classic script, and it
 * runs at `document_start`, so it must have no imports to resolve at load time.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist/injected'),
    emptyOutDir: false,
    target: 'chrome116',
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/injected/agent.ts'),
      formats: ['iife'],
      name: 'FlowSnapAgent',
      fileName: () => 'agent.js',
    },
  },
});
