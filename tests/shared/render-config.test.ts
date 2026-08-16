/**
 * The two knobs the settings window can turn that the overlay has to honour (issue #39, ST4).
 *
 * `render` is the only config that crosses to the overlay renderer, and it crosses as a *mirror* -
 * `OverlayRenderConfig` in `renderer/overlay/contract.ts` restates the shape because that bundle
 * cannot import zod. The project's stated drift guard for that is the assignment in
 * `src/main/index.ts`, which is a compile-time check in a file no test imports. This pins the same
 * guarantee somewhere a reader can see it, and adds the bounds arguments that are decisions rather
 * than defaults.
 *
 * That a changed value actually reaches the live document is not answerable here - there is no DOM
 * in this environment by design - and is proved against real Chromium over CDP instead: with the
 * capture loop stopped, so no payload could carry it, a size change made through the settings
 * control moved the overlay's computed `font-size` from 34px to 22px and the plate's alpha from
 * 0.4 to 0.96 without a single new draw.
 */

import { describe, expect, it } from 'vitest';

import type { OverlayRenderConfig } from '../../src/renderer/overlay/contract.js';
import { DEFAULT_CONFIG, renderConfigSchema, renderOverrideSchema } from '../../src/shared/config-schema.js';

describe('render config crosses to the overlay without drift', () => {
  it('the parsed schema satisfies the renderer\'s own mirror of it', () => {
    // The assignment is the test: a field renamed or narrowed on either side stops this compiling,
    // which is the same guarantee `WindowManager.setOverlayRender`'s call site provides and the
    // reason neither side may import the other.
    const crossing: OverlayRenderConfig = DEFAULT_CONFIG.render;

    expect(crossing.fontSize).toBe(17);
    expect(crossing.opacity).toBe(0.82);
  });

  it('ships the values overlay.css already had, so making them configurable changed nothing', () => {
    // If these drift from the literals in `overlay.css`, a fresh install looks different from the
    // build before it for no reason anybody chose.
    expect(DEFAULT_CONFIG.render.fontSize).toBe(17);
    expect(DEFAULT_CONFIG.render.opacity).toBe(0.82);
  });
});

describe('the bounds are arguments, not decoration', () => {
  it('refuses a font size below the point Thai stacked marks stop being separable', () => {
    // H2: Thai puts a vowel above, a tone mark above that, and a vowel below - three levels on one
    // line. This is the size at which that stops being a rendering and starts being a smudge.
    expect(renderOverrideSchema.safeParse({ fontSize: 9 }).success).toBe(false);
    expect(renderOverrideSchema.safeParse({ fontSize: 10 }).success).toBe(true);
  });

  it('refuses a font size large enough for the area budget to eat the frame', () => {
    // U4 caps the total screen area translations may occupy. Past this, two lines of subtitle
    // exhaust it and most of the frame is suppressed - which reads as the app losing text, not as
    // a font size that was set too high.
    expect(renderOverrideSchema.safeParse({ fontSize: 48 }).success).toBe(true);
    expect(renderOverrideSchema.safeParse({ fontSize: 49 }).success).toBe(false);
  });

  it('refuses a fully transparent plate', () => {
    // White text with only its shadow, over an arbitrary screen, reads as the overlay being
    // broken. A user who wants no boxes has `toggleOverlay`, which is a mode rather than a setting
    // that looks like a fault.
    expect(renderOverrideSchema.safeParse({ opacity: 0 }).success).toBe(false);
    expect(renderOverrideSchema.safeParse({ opacity: 0.19 }).success).toBe(false);
    expect(renderOverrideSchema.safeParse({ opacity: 0.2 }).success).toBe(true);
    expect(renderOverrideSchema.safeParse({ opacity: 1 }).success).toBe(true);
    expect(renderOverrideSchema.safeParse({ opacity: 1.01 }).success).toBe(false);
  });

  it('requires a whole number of pixels for the font size', () => {
    expect(renderOverrideSchema.safeParse({ fontSize: 17.5 }).success).toBe(false);
  });

  it('still rejects an unrecognised key wholesale', () => {
    // The strictness argument from `config-schema.ts`: a user who writes `fontsize` has expressed
    // an intention, and dropping the key would ignore it silently.
    expect(renderOverrideSchema.safeParse({ fontsize: 20 }).success).toBe(false);
  });

  it('names the offending field, which is what the settings window puts next to the control', () => {
    const result = renderConfigSchema.safeParse({ ...DEFAULT_CONFIG.render, opacity: 5 });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues[0]?.path).toEqual(['opacity']);
  });
});
