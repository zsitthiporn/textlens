/**
 * Tests for the overlay status banner's decision layer (issue M10-02 / #41).
 *
 * No DOM: `vitest.config.ts` is `environment: 'node'` and stays that way. What is checked here is
 * what the banner *says*; that it is drawn, and drawn above the subtitle area, is checked against
 * real Chromium through `window.__textlensOverlay.banner()`.
 */

import { describe, expect, it } from 'vitest';

import type { OverlayStatusMessage } from '../../../src/renderer/overlay/contract.js';
import { MAX_CAUSE_CHARS, MAX_REMEDY_CHARS, toBannerView } from '../../../src/renderer/overlay/status.js';

function message(over: Partial<NonNullable<OverlayStatusMessage['alert']>> = {}): OverlayStatusMessage {
  return {
    alert: {
      severity: 'error',
      cause: 'no translation service could be reached, so the original text is showing',
      remedy: 'check your internet connection or proxy',
      ...over,
    },
  };
}

describe('the overlay banner', () => {
  it('shows nothing before the main process has said anything', () => {
    expect(toBannerView(null).visible).toBe(false);
  });

  it('shows nothing when the main process says all clear', () => {
    // Sent explicitly rather than by omission - a banner that is only ever added outlives the
    // problem, which is #41's "error ชั่วคราว หายเองเมื่อกลับมาปกติ".
    expect(toBannerView({ alert: null }).visible).toBe(false);
  });

  it('carries the cause and the remedy separately', () => {
    const view = toBannerView(message());

    expect(view.visible).toBe(true);
    expect(view.severity).toBe('error');
    expect(view.cause).toContain('no translation service');
    expect(view.remedy).toContain('internet connection');
  });

  it('caps each half on its own line budget', () => {
    const view = toBannerView(message({ cause: 'c'.repeat(500), remedy: 'r'.repeat(500) }));

    expect(view.cause.length).toBeLessThanOrEqual(MAX_CAUSE_CHARS);
    expect(view.remedy.length).toBeLessThanOrEqual(MAX_REMEDY_CHARS);
  });

  /**
   * The regression a real run produced: the give-up remedy read "check the log in
   * C:\\Users\\...\\logs, then use the tray menu → Restart capture engine", the shared budget was
   * spent on the path, and the only actionable sentence was the half that got clipped.
   */
  it('leaves a long cause enough room for the whole remedy', () => {
    const view = toBannerView(
      message({
        cause: 'the screen capture engine keeps failing, so Textlens has stopped restarting it',
        remedy:
          'use the tray menu → "Restart capture engine", or see the log in '
          + 'C:\\Users\\someone\\AppData\\Roaming\\textlens\\logs',
      }),
    );

    expect(view.remedy).toContain('Restart capture engine');
  });

  it('stays hidden for an alert with no cause, rather than painting an empty plate', () => {
    expect(toBannerView(message({ cause: '   ' })).visible).toBe(false);
  });

  it('passes the severity through, because the stylesheet keys the colour off it', () => {
    expect(toBannerView(message({ severity: 'info' })).severity).toBe('info');
    expect(toBannerView(message({ severity: 'fatal' })).severity).toBe('fatal');
  });
});
