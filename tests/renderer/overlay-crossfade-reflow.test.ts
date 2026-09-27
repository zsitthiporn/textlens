// @vitest-environment jsdom
/**
 * F2 of issue #81: restarting a crossfade must not force a reflow from the write-only phase.
 *
 * Before the fix, `createBox()`'s `setText` read `outgoing.offsetWidth` synchronously, inside
 * `renderEntries`' phase 1 (writes only, by that phase's own contract) - once per crossfading box,
 * defeating the "one reflow for the whole frame" guarantee `layout.ts`'s module comment describes.
 * `overlay-layout-check.mjs` never caught it because it runs with `fadeMs: 0`, which never enters
 * the crossfade branch at all.
 *
 * `HTMLElement.prototype.offsetWidth` is the property that forces jsdom - and every real
 * layout engine - to flush layout before returning a value; spying on its getter and asserting it
 * is never read during a crossfading render is a direct measurement of the bug, not a proxy for
 * it. `crossfaded === 1` in the stats confirms the crossfade branch actually ran, so a passing
 * "zero reads" assertion cannot be explained by the fade path never having been exercised.
 */
import { describe, expect, it, vi } from 'vitest';

interface OverlayHarness {
  render: (message: unknown) => void;
  texts: () => string[];
  stats: () => { crossfaded: number } | null;
}

function message(id: number, seq: number, text: string, fadeMs: number) {
  return {
    id,
    epoch: 1,
    origin: { x: 0, y: 0 },
    config: {
      anchorGrid: 8,
      anchorTolerance: 6,
      stickyMaxEntries: 128,
      minDisplayMs: 0,
      fadeMs,
      fontSize: 17,
      opacity: 0.8,
      maxAreaRatio: 1,
    },
    payload: {
      seq,
      complete: true,
      degraded: false,
      // Same sourceText and bbox on every call, so #35's sticky anchor resolves to the same key
      // and the box is held (state 'holding'), not re-entered - the crossfade only ever fires
      // for a held box whose text changed.
      entries: [
        { text, sourceText: 'src', origin: 'engine', bbox: { x: 10, y: 10, width: 100, height: 20 } },
      ],
    },
  };
}

describe('crossfade restart does not force a reflow from the write-only phase (#81 F2)', () => {
  it('reads no offsetWidth while restarting a held box’s fade, and the fade still restarts', async () => {
    (document as unknown as { fonts: { load: () => Promise<void> } }).fonts = {
      load: () => Promise.reject(new Error('no fonts API in jsdom')),
    };
    document.body.innerHTML =
      '<div id="boxes"></div>'
      + '<div id="status" hidden><span id="status-cause"></span><span id="status-remedy"></span></div>';
    await import('../../src/renderer/overlay/overlay.js');
    const api = (window as unknown as { __textlensOverlay: OverlayHarness }).__textlensOverlay;

    let offsetWidthReads = 0;
    const offsetWidthSpy = vi
      .spyOn(window.HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(function offsetWidthGetter(this: HTMLElement) {
        offsetWidthReads += 1;
        return 0;
      });

    // First render: the box is brand new (state 'entering'), so nothing crossfades yet.
    api.render(message(1, 1, 'first', 50));
    expect(api.stats()?.crossfaded).toBe(0);
    expect(offsetWidthReads).toBe(0);

    // Before the second render: the outgoing layer must not already show 'fading' - otherwise a
    // fix that forgot to remove the class in phase 1 would pass the "still restarts" assertion
    // below by accident, because the class was never gone to begin with.
    expect(document.querySelector('.box-out.fading')).toBeNull();

    // Second render: same anchor, same sourceText, different text -> held and crossfaded.
    offsetWidthReads = 0;
    api.render(message(2, 2, 'second', 50));

    expect(api.stats()?.crossfaded).toBe(1); // the path under test actually ran
    expect(offsetWidthReads).toBe(0); // ...without forcing a reflow to restart it
    expect(document.querySelector('.box-out.fading')).not.toBeNull(); // ...and it still restarts
    expect(api.texts()).toEqual(['second']); // the incoming layer still shows the new text

    offsetWidthSpy.mockRestore();
  });
});
