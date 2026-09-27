// @vitest-environment jsdom
/**
 * F3 of issue #81: a malformed payload must not blank the screen or throw mid-`adopt()`.
 *
 * Before the fix, `draw()` calls `adopt(message)` - which swaps the epoch, rebuilds the session
 * and calls `pool.hideAll()` - *before* `toLayoutEntries` gets a chance to throw on a payload
 * missing `entries` or carrying a non-finite bbox. So a malformed payload that also bumps the
 * epoch (a realistic combination: a new region *and* a producer one version out of step with this
 * renderer, per the module comment on `adopt`) both wipes the screen and crashes - two failures
 * where the invalid input on its own would deserve zero.
 *
 * This is a real `document`, not a fake: the failure is about the order of side effects across
 * `adopt`/`toLayoutEntries`/`reportDrawn`, and a fake `PooledBox` would not exercise the module
 * that owns `document.getElementById` at all.
 *
 * Everything runs as one `it()`, sequentially, rather than one `it()` per scenario: `overlay.ts`
 * defines `window.__textlensOverlay` with `Object.defineProperty` and no `configurable: true`, so
 * a second dynamic import against the same jsdom `window` (which persists across `it()`s in one
 * file) throws "Cannot redefine property" - the same reason the reviewer's own scratch templates
 * for this issue are written as one long `it()`.
 */
import { describe, expect, it, vi } from 'vitest';

interface OverlayHarness {
  render: (message: unknown) => void;
  texts: () => string[];
  drawn: () => number | null;
  epoch: () => number | null;
}

function goodMessage(id: number, epoch: number, seq: number) {
  return {
    id,
    epoch,
    origin: { x: 0, y: 0 },
    config: {
      anchorGrid: 8,
      anchorTolerance: 6,
      stickyMaxEntries: 128,
      minDisplayMs: 0,
      fadeMs: 0,
      fontSize: 17,
      opacity: 0.8,
      maxAreaRatio: 1,
    },
    payload: {
      seq,
      complete: true,
      degraded: false,
      entries: [
        { text: 'hello', sourceText: 'src', origin: 'engine', bbox: { x: 10, y: 10, width: 100, height: 20 } },
      ],
    },
  };
}

describe('draw() against a malformed payload (#81 F3)', () => {
  it('rejects entries-missing / NaN-bbox / origin-missing without throwing, mutating state, or acking', async () => {
    (document as unknown as { fonts: { load: () => Promise<void> } }).fonts = {
      load: () => Promise.reject(new Error('no fonts API in jsdom')),
    };
    document.body.innerHTML =
      '<div id="boxes"></div>'
      + '<div id="status" hidden><span id="status-cause"></span><span id="status-remedy"></span></div>';
    await import('../../src/renderer/overlay/overlay.js');
    const api = (window as unknown as { __textlensOverlay: OverlayHarness }).__textlensOverlay;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Step 1: a good payload draws normally.
    api.render(goodMessage(1, 1, 1));
    expect(api.texts()).toEqual(['hello']);
    expect(api.epoch()).toBe(1);
    expect(api.drawn()).toBe(1);

    // Step 2: entries missing entirely, AND a new epoch - the compounding case from the issue.
    const missingEntries = goodMessage(2, 2, 2) as Record<string, unknown>;
    delete (missingEntries.payload as Record<string, unknown>).entries;
    expect(() => api.render(missingEntries)).not.toThrow();
    // The core F3 claim: adopt() never ran for this message, so the epoch is still 1 - not 2 -
    // and the picture that was on screen before the bad payload arrived is still there.
    expect(api.epoch()).toBe(1);
    expect(api.texts()).toEqual(['hello']);
    // Never acknowledged to main: a payload that was not drawn must not be reported as drawn -
    // drawn-payloads.ts would otherwise remember text that never reached the screen.
    expect(api.drawn()).toBe(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockClear();

    // Step 3: a non-finite bbox field, same epoch. Would silently become NaN geometry, not a
    // throw - this is the case the naive "just check `entries` is an array" fix would miss.
    const nanBbox = goodMessage(3, 1, 3) as Record<string, unknown>;
    const nanEntries = (nanBbox.payload as { entries: Array<Record<string, unknown>> }).entries;
    (nanEntries[0]!.bbox as Record<string, unknown>).width = Number.NaN;
    expect(() => api.render(nanBbox)).not.toThrow();
    expect(api.texts()).toEqual(['hello']);
    expect(api.drawn()).toBe(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockClear();

    // Step 4: origin missing entirely - `toLayoutEntries` destructures `message.origin` and would
    // throw a plain `TypeError` before any entry is even looked at.
    const missingOrigin = goodMessage(4, 1, 4) as Record<string, unknown>;
    delete missingOrigin.origin;
    expect(() => api.render(missingOrigin)).not.toThrow();
    expect(api.texts()).toEqual(['hello']);
    expect(api.drawn()).toBe(1);

    // Step 5: not permanently wedged - the next well-formed payload draws normally.
    api.render(goodMessage(5, 1, 5));
    expect(api.texts()).toEqual(['hello']);
    expect(api.drawn()).toBe(5);
    expect(api.epoch()).toBe(1);

    consoleError.mockRestore();
  });
});
