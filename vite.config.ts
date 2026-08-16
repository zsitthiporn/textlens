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
        // The region picker is a third document for the same reason the overlay is a second
        // one (M6-02): it is the overlay's opposite - opaque, focusable, and it wants every
        // mouse and key event - so sharing an entry point or a stylesheet with either of the
        // others is how one of them ends up with the wrong pointer-events policy.
        'region-picker': path.join(renderer, 'region-picker/index.html'),
      },
    },
  },
});
