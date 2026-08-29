import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Main extension build: the two extension pages and the background worker.
 *
 * The content script and the MAIN-world agent are built separately (see
 * vite.content.config.ts and vite.agent.config.ts) because manifest-declared
 * content scripts are classic scripts — they cannot be ES modules, so each
 * needs its own self-contained IIFE bundle.
 */
export default defineConfig({
  root: 'src',
  publicDir: resolve(import.meta.dirname, 'public'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome116',
    // Readable stack traces matter more than bytes for a developer tool.
    minify: false,
    sourcemap: true,
    /*
     * No `<link rel="modulepreload">` tags.
     *
     * Vite emits them with `crossorigin`, which on a `chrome-extension://` page
     * puts the preload in a different request mode than the import that follows
     * — so Chrome discards every one of them and prints two warnings per chunk:
     * "cross-world extension resource mismatch", then "preloaded ... but not
     * used". The hints were buying nothing anyway: these files are already on
     * disk beside the page, so there is no round trip to race.
     */
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'src/popup.html'),
        viewer: resolve(import.meta.dirname, 'src/viewer.html'),
        settings: resolve(import.meta.dirname, 'src/settings.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
      },
      output: {
        // The manifest references background.js by name; everything else may hash.
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
