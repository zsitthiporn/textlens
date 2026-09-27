// @vitest-environment jsdom
/**
 * F1 of issue #81: a font-size push that rebuilds the session must redraw the last message.
 *
 * Before the fix, `onRenderConfig`'s handler rebuilt the session and called `pool.hideAll()` and
 * stopped there - on a still screen, or in `snapshot`/`paused` mode, nothing sends another payload
 * to put the picture back, so the translation the user was reading vanished until the source text
 * next changed. `window-manager.ts`'s `setOverlayRender` does not resend the payload either (see
 * its own comment: "not queued... there is nothing to replay").
 *
 * `window.textlensOverlay` is faked here rather than driven through the diagnostics seam, because
 * `onRenderConfig` is the one channel with no diagnostics entry point - it only reaches the module
 * through the real bridge subscription registered at import time.
 */
import { describe, expect, it, vi } from 'vitest';

interface OverlayHarness {
  render: (message: unknown) => void;
  texts: () => string[];
  drawn: () => number | null;
  draws: () => number;
}

function baseConfig() {
  return {
    anchorGrid: 8,
    anchorTolerance: 6,
    stickyMaxEntries: 128,
    minDisplayMs: 0,
    fadeMs: 0,
    fontSize: 17,
    opacity: 0.8,
    maxAreaRatio: 1,
  };
}

function goodMessage(id: number, seq: number) {
  return {
    id,
    epoch: 1,
    origin: { x: 0, y: 0 },
    config: baseConfig(),
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

describe('onRenderConfig redraws the last message after a rebuild (#81 F1)', () => {
  it('keeps the text on screen and adopts the new font size for a fontSize-only push', async () => {
    let onRenderConfig: ((message: { config: ReturnType<typeof baseConfig> }) => void) | null = null;
    const reportDrawn = vi.fn();
    (window as unknown as { textlensOverlay: Record<string, unknown> }).textlensOverlay = {
      onPayload: () => () => undefined,
      onStatus: () => () => undefined,
      onRenderConfig: (listener: (message: { config: ReturnType<typeof baseConfig> }) => void) => {
        onRenderConfig = listener;
        return () => undefined;
      },
      reportDrawn,
    };
    (document as unknown as { fonts: { load: () => Promise<void> } }).fonts = {
      load: () => Promise.reject(new Error('no fonts API in jsdom')),
    };
    document.body.innerHTML =
      '<div id="boxes"></div>'
      + '<div id="status" hidden><span id="status-cause"></span><span id="status-remedy"></span></div>';
    await import('../../src/renderer/overlay/overlay.js');
    const api = (window as unknown as { __textlensOverlay: OverlayHarness }).__textlensOverlay;
    const boxes = document.getElementById('boxes')!;

    expect(onRenderConfig).not.toBeNull();

    api.render(goodMessage(1, 1));
    expect(api.texts()).toEqual(['hello']);
    expect(api.drawn()).toBe(1);
    reportDrawn.mockClear();

    // An opacity-only push: no field that forces a rebuild changed, so nothing needs to redraw.
    // A fix that redraws unconditionally would still pass the fontSize assertions below, so this
    // guards against that: it must NOT cost a render.
    const drawsBeforeOpacity = api.draws();
    onRenderConfig!({ config: { ...baseConfig(), opacity: 0.5 } });
    expect(api.draws()).toBe(drawsBeforeOpacity);
    expect(boxes.style.getPropertyValue('--textlens-opacity')).toBe('0.5');
    expect(reportDrawn).not.toHaveBeenCalled();

    // The fontSize-only push: this DOES force a rebuild (`adoptConfig`'s own rule - a remembered
    // anchor was sized for the old font). Before the fix, `pool.hideAll()` ran and nothing put
    // `lastMessage` back on screen.
    onRenderConfig!({ config: { ...baseConfig(), opacity: 0.5, fontSize: 24 } });

    expect(api.texts()).toEqual(['hello']);
    // The discriminating assertion: a fix that redraws `lastMessage` but forgets to patch its
    // `config` field first would have `draw()`'s own `adopt()` immediately re-run `adoptConfig`
    // against the *stale* 17px config carried on the original message, silently reverting the
    // font size the user just chose back to what it was.
    expect(boxes.style.getPropertyValue('--textlens-font-size')).toBe('24px');
    // Re-acked under the same id it was first drawn under. `drawn-payloads.ts` (`main` process,
    // read-only from here) treats a duplicate ack for an id it already answered as a no-op - see
    // its own comment: "ignorable... a duplicate ack must not record anything twice" - so this is
    // harmless on the main side, not a new failure mode.
    expect(reportDrawn).toHaveBeenCalledWith(1);
  });
});
