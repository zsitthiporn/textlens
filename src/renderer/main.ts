/**
 * The settings document's entry point.
 *
 * This bundle is loaded by `renderer/index.html`, which `WindowManager.openSettings` opens with
 * `?kind=settings`. The overlay and the region picker are separate documents with separate entry
 * points (see `vite.config.ts`), so despite the generic name this file serves exactly one surface.
 *
 * The window kind is still parsed and asserted rather than assumed: it is the app's cheapest
 * liveness signal - the title only reads correctly if the bundle ran, the shared parser resolved
 * the kind, and the contextBridge handed over the versions - and a document that finds itself
 * opened as some other kind should say so rather than silently render the wrong surface.
 */

import { parseWindowKind } from '../shared/types.js';

import { mountSettings } from './settings/settings.js';

const kind = parseWindowKind(window.location.search);
const { electron } = window.textlens.versions;

document.title = `Textlens - ${kind ?? 'unknown'} - electron ${electron}`;

const root = document.querySelector<HTMLElement>('#root');

if (root !== null) {
  if (kind === 'settings' || kind === null) {
    // `null` renders settings too. A missing query string means somebody opened this document
    // directly - during development, or from a `loadFile` that lost its options - and the useful
    // thing to show them is the window this document is, not an error page about a URL parameter.
    mountSettings(root);
  } else {
    root.replaceChildren();
    const heading = document.createElement('h1');
    heading.textContent = 'Textlens';
    const detail = document.createElement('p');
    detail.textContent = `this document does not serve the "${kind}" surface`;
    root.append(heading, detail);
  }
}
