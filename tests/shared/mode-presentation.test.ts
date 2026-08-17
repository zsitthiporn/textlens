/**
 * The four internal modes seen as the two a user chooses between (#60).
 *
 * Two things are pinned here and they pull against each other, which is the whole reason this
 * module exists:
 *
 *   1. **No surface a user reads may say `Snapshot`.** The tray said it, the settings window said
 *      `Translate once`, and a user who read one and went looking on the other did not find the
 *      same word.
 *   2. **The config key `hotkeys.snapshot` may not move.** `configSchema` is a `strictObject`, so
 *      an unknown key rejects the user's *entire* file rather than one field - renaming it would
 *      lose every setting they have ever changed, loudly but completely.
 *
 * So the internal name and the shown name differ on purpose, in one direction, in one place. The
 * second half of that bargain is enforced by `tests/main/config.test.ts`'s companion case, which
 * pushes a real `{"hotkeys":{"snapshot":...}}` through the real schema.
 */

import { describe, expect, it } from 'vitest';

import { APP_MODES, type AppMode } from '../../src/main/services/app-orchestrator.js';
import {
  MODE_NAMES,
  NOT_STARTED_LABEL,
  PAUSED_LABEL,
  describeMode,
  type PresentableMode,
} from '../../src/shared/mode-presentation.js';

describe('describeMode: four modes, two choices', () => {
  it('puts auto and paused on the same choice, and snapshot on the other', () => {
    expect(describeMode('auto').choice).toBe('auto');
    // The whole of #60's third problem: pausing is Auto switched off, not a peer of the two modes.
    expect(describeMode('paused').choice).toBe('auto');
    expect(describeMode('snapshot').choice).toBe('once');
  });

  it('offers idle as no choice at all', () => {
    // `idle` is where the app sits before `configure` lands and where a first run with no region
    // rests (#51). Presenting it would be offering a mode whose only meaning is "not set up yet".
    const idle = describeMode('idle');
    expect(idle.choice).toBeNull();
    expect(idle.label).toBe(NOT_STARTED_LABEL);
    expect(idle.choices.every((choice) => !choice.active)).toBe(true);
  });

  it('reports the capture loop separately from the choice', () => {
    // `running` is what the sidecar is doing; `choice` is what the user picked. Paused is the one
    // state where they disagree, and collapsing them is how "paused" became a third mode.
    expect(describeMode('auto').running).toBe(true);
    expect(describeMode('paused').running).toBe(false);
    expect(describeMode('paused').choice).toBe('auto');
  });

  it('names Auto switched off, so paused cannot be drawn identically to idle', () => {
    // Both have a stopped loop and neither is `snapshot`. Only the label separates them, and only
    // one of the two is a state the user asked for.
    expect(describeMode('paused').label).toBe(PAUSED_LABEL);
    expect(describeMode('paused').label).not.toBe(describeMode('idle').label);
    expect(describeMode('paused').choices[0].label).toBe('Auto (paused)');
  });

  it('marks exactly one choice active, or neither', () => {
    for (const mode of APP_MODES) {
      const active = describeMode(mode).choices.filter((choice) => choice.active);
      expect(active.length).toBeLessThanOrEqual(1);
      expect(active.length).toBe(mode === 'idle' ? 0 : 1);
    }
  });

  it('always offers both choices in the same order, whatever the mode', () => {
    // A selector whose entries move is a selector the user has to re-read. Both are always present
    // and always in this order, in the tray menu and in the settings header alike.
    for (const mode of APP_MODES) {
      expect(describeMode(mode).choices.map((choice) => choice.mode)).toEqual(['auto', 'once']);
    }
  });

  it('never shows the word Snapshot, and never stops sending it', () => {
    for (const mode of APP_MODES) {
      const presentation = describeMode(mode);
      const shown = [presentation.label, ...presentation.choices.map((choice) => choice.label)].join(' ');
      expect(shown).not.toMatch(/snapshot/i);
    }
    // The other direction. The label moved; the command did not, and it is what reaches
    // `hotkeys.snapshot`, `AppOrchestrator.snapshot()` and the sidecar's `snapshot` command.
    expect(describeMode('auto').choices[1].command).toBe('snapshot');
    expect(MODE_NAMES.once).toBe('Translate once');
  });

  it('is tied to AppMode at compile time as well as here', () => {
    // `APP_MODES` is declared `satisfies readonly PresentableMode[]`, so a fifth internal mode
    // fails to compile until it has a presentation. This is the runtime half: every mode that
    // exists is one this function actually answers for.
    const modes: readonly PresentableMode[] = APP_MODES;
    for (const mode of modes) expect(describeMode(mode).label.length).toBeGreaterThan(0);
    const asAppModes: readonly AppMode[] = APP_MODES;
    expect(asAppModes).toHaveLength(4);
  });
});
