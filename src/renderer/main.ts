import { parseWindowKind } from '../shared/types.js';

const kind = parseWindowKind(window.location.search);
const { electron, chrome, node } = window.textlens.versions;

// The window title is the app's cheapest liveness signal: it only ever reads
// "Textlens - <kind> - electron <v>" if the renderer bundle ran, the shared
// parser resolved the kind, and the contextBridge handed over the versions.
document.title = `Textlens - ${kind ?? 'unknown'} - electron ${electron}`;

const root = document.querySelector<HTMLElement>('#root');

if (root) {
  root.replaceChildren();

  const heading = document.createElement('h1');
  heading.textContent = 'Textlens';

  const subtitle = document.createElement('p');
  subtitle.textContent =
    kind === null ? 'window kind missing from URL' : `window kind: ${kind}`;

  const versions = document.createElement('dl');
  for (const [label, value] of [
    ['electron', electron],
    ['chromium', chrome],
    ['node', node],
  ]) {
    const term = document.createElement('dt');
    term.textContent = label ?? '';
    const definition = document.createElement('dd');
    definition.textContent = value ?? '';
    versions.append(term, definition);
  }

  root.append(heading, subtitle, versions);
}
