import { defineConfig } from 'vite';

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
  },
});
