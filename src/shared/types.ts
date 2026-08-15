/**
 * Types and helpers that the main process and the renderer both need.
 *
 * Keep this file small and deliberate. Two things explicitly do NOT belong here:
 *   - the Node <-> sidecar JSON-lines protocol (its own module, M1-03)
 *   - coordinate conversion (single owner, M3-01)
 */

/**
 * The renderer surfaces this app hosts, per section 2 of the architecture design.
 * A BrowserWindow is created for a kind; the renderer reads its own kind back out
 * of the URL so one bundle can serve every surface.
 */
export type WindowKind = 'overlay' | 'region-picker' | 'settings';

export const WINDOW_KINDS: readonly WindowKind[] = ['overlay', 'region-picker', 'settings'];

/** Query-string key carrying the window kind from main to renderer. */
export const WINDOW_KIND_PARAM = 'kind';

export function isWindowKind(value: unknown): value is WindowKind {
  return typeof value === 'string' && (WINDOW_KINDS as readonly string[]).includes(value);
}

/**
 * Main process side: the query object handed to `BrowserWindow#loadFile`.
 * Using a helper keeps the param name in one place instead of a literal at each call site.
 */
export function windowKindQuery(kind: WindowKind): Record<string, string> {
  return { [WINDOW_KIND_PARAM]: kind };
}

/**
 * Renderer side: recover the kind from `location.search`.
 * Returns null when the parameter is missing or is not a kind we serve - the caller
 * decides what to do, because silently defaulting would hide a wiring mistake.
 */
export function parseWindowKind(search: string): WindowKind | null {
  const raw = new URLSearchParams(search).get(WINDOW_KIND_PARAM);
  return isWindowKind(raw) ? raw : null;
}

/** The object the preload script exposes on `window.textlens`. */
export interface TextlensBridge {
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}

declare global {
  interface Window {
    readonly textlens: TextlensBridge;
  }
}
