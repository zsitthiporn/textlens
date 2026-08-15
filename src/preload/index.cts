// CommonJS on purpose: a sandboxed Electron preload cannot be an ES module.
// The .cts extension is what makes tsc emit dist/preload/index.cjs.
import { contextBridge } from 'electron';

import type { TextlensBridge } from '../shared/types.js';

const bridge: TextlensBridge = {
  versions: {
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
  },
};

contextBridge.exposeInMainWorld('textlens', bridge);
