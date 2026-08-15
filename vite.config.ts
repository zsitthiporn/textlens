import path from 'node:path';

import { defineConfig } from 'vite';

const renderer = path.resolve(import.meta.dirname, 'src/renderer');

// Renderer only. src/main and src/preload are compiled by tsc (tsconfig.json).
export default defineConfig({
  root: 'src/renderer',
  // The app is loaded with BrowserWindow#loadFile, so asset URLs must be relative to
  // the html file rather than to a server root.
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // The runtime is exactly one known Chromium, so there is nothing to down-level for.
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      // The overlay is a separate document, not a `?kind=` variant of the settings page:
      // it must have a transparent background and no shared chrome, and the surest way
      // to guarantee that is for it not to share a stylesheet or an entry point (M1-05).
      input: {
        main: path.join(renderer, 'index.html'),
        overlay: path.join(renderer, 'overlay/index.html'),
      },
    },
  },
});
