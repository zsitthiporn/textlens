/**
 * Keystroke -> accelerator (issue M9-02 / #39).
 *
 * The point of this module is that a settings window must never accept a **typed** accelerator,
 * and these tests are mostly about the shapes that must not come out of it. `hotkey-service.ts`
 * documents what happens when a bad one reaches Electron 43's `globalShortcut`, measured rather
 * than assumed: an unknown modifier is silently dropped and the remaining tokens are bound, so
 * `Contrl+Alt+A` registers `Alt+A` and `Foo+Bar+A` registers the bare `A` key process-wide -
 * swallowing every `A` the user types anywhere in Windows - while `register` returns `true`.
 *
 * This function is the only producer of these strings, so the guarantee is structural: every token
 * it can emit comes from a table here, and there is no path by which user text becomes a token.
 */

import { describe, expect, it } from 'vitest';

import { acceleratorFromKeyStroke, classifyHotkeyCaution, type KeyStroke } from '../../src/shared/accelerator.js';

function stroke(code: string, modifiers: Partial<Omit<KeyStroke, 'code'>> = {}): KeyStroke {
  return {
    code,
    ctrlKey: modifiers.ctrlKey ?? false,
    altKey: modifiers.altKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    metaKey: modifiers.metaKey ?? false,
  };
}

describe('acceleratorFromKeyStroke: the shapes it produces', () => {
  it('builds the project default from the keys the user actually presses', () => {
    expect(acceleratorFromKeyStroke(stroke('KeyA', { ctrlKey: true, altKey: true }))).toEqual({
      kind: 'ok',
      accelerator: 'Control+Alt+A',
    });
  });

  it('orders modifiers the same way whatever order they were pressed in', () => {
    // Two spellings of one binding would compare unequal in config and in the duplicate check
    // `hotkey-service.ts` runs - which would report a key as bound twice when the user pressed it
    // once. The order is fixed here so that cannot arise.
    const all = acceleratorFromKeyStroke(
      stroke('KeyR', { shiftKey: true, metaKey: true, altKey: true, ctrlKey: true }),
    );
    expect(all).toEqual({ kind: 'ok', accelerator: 'Control+Alt+Shift+Super+R' });
  });

  it.each([
    ['Digit7', 'Control+7'],
    ['ArrowUp', 'Control+Up'],
    ['ArrowRight', 'Control+Right'],
    ['Enter', 'Control+Return'],
    ['NumpadEnter', 'Control+Return'],
    ['Space', 'Control+Space'],
    ['Numpad4', 'Control+num4'],
    ['NumpadDecimal', 'Control+numdec'],
    ['BracketLeft', 'Control+['],
    ['Backslash', 'Control+\\'],
    ['PageDown', 'Control+PageDown'],
  ])('maps the physical key %s to Electron\'s own token', (code, expected) => {
    expect(acceleratorFromKeyStroke(stroke(code, { ctrlKey: true }))).toEqual({
      kind: 'ok',
      accelerator: expected,
    });
  });

  it('allows a bare function key, which is a normal thing to bind deliberately', () => {
    expect(acceleratorFromKeyStroke(stroke('F9'))).toEqual({ kind: 'ok', accelerator: 'F9' });
    expect(acceleratorFromKeyStroke(stroke('F24'))).toEqual({ kind: 'ok', accelerator: 'F24' });
  });
});

describe('acceleratorFromKeyStroke: what it refuses', () => {
  it('refuses a bare letter, which would take that letter from every program on the machine', () => {
    // The exact failure the misspelled-modifier trap produces by accident. It should not be
    // reachable on purpose either.
    const result = acceleratorFromKeyStroke(stroke('KeyA'));
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('unreachable');
    expect(result.message).toContain('Control');
  });

  it.each(['Digit4', 'Space', 'Enter', 'ArrowLeft', 'Numpad5'])(
    'refuses bare %s as well - a function key is the only unmodified binding allowed',
    (code) => {
      expect(acceleratorFromKeyStroke(stroke(code)).kind).toBe('rejected');
    },
  );

  it('refuses a key it has no Electron token for, rather than inventing one', () => {
    // `Electron` throws on an accelerator it cannot parse. A token this module cannot name is a
    // token that would reach `register` and take the main process down with it (#38's arm 3).
    expect(acceleratorFromKeyStroke(stroke('BrowserFavorites', { ctrlKey: true })).kind).toBe('rejected');
    expect(acceleratorFromKeyStroke(stroke('F25', { ctrlKey: true })).kind).toBe('rejected');
    expect(acceleratorFromKeyStroke(stroke('Fn', { ctrlKey: true })).kind).toBe('rejected');
  });

  it('never emits a token that is not a documented modifier or key', () => {
    // The structural claim, checked over the whole surface rather than case by case: whatever is
    // pressed, every token in the result is one Electron documents. This is what makes the
    // misspelled-modifier trap unreachable rather than merely unlikely.
    const modifiers = ['Control', 'Alt', 'Shift', 'Super'];
    const codes = [
      'KeyZ', 'Digit0', 'F1', 'F12', 'ArrowDown', 'Home', 'End', 'Insert', 'Delete', 'Backspace',
      'Tab', 'Minus', 'Equal', 'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash',
      'Numpad9', 'NumpadAdd', 'NumpadDivide', 'PrintScreen', 'ScrollLock',
    ];
    const allowedKeys = new Set([
      'Z', '0', 'F1', 'F12', 'Down', 'Home', 'End', 'Insert', 'Delete', 'Backspace', 'Tab',
      '-', '=', ';', "'", '`', ',', '.', '/', 'num9', 'numadd', 'numdiv', 'PrintScreen', 'Scrolllock',
    ]);

    for (const code of codes) {
      const result = acceleratorFromKeyStroke(stroke(code, { ctrlKey: true, shiftKey: true }));
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') continue;
      const tokens = result.accelerator.split('+');
      const key = tokens.pop();
      expect(allowedKeys.has(key ?? '')).toBe(true);
      for (const token of tokens) expect(modifiers).toContain(token);
    }
  });
});

describe('acceleratorFromKeyStroke: capture flow', () => {
  it.each(['ControlLeft', 'ControlRight', 'AltLeft', 'ShiftRight', 'MetaLeft', 'OSLeft'])(
    'treats %s on its own as the user still reaching, not as a choice',
    (code) => {
      // Holding Control fires a keydown for Control itself. Ending capture there would bind
      // "Control" to an action.
      expect(acceleratorFromKeyStroke(stroke(code, { ctrlKey: true })).kind).toBe('pending');
    },
  );

  it('cancels on Escape, so the previous binding survives a change of mind', () => {
    expect(acceleratorFromKeyStroke(stroke('Escape')).kind).toBe('cancel');
    // Even with modifiers held - `Control+Escape` is the Start menu, not a binding to offer.
    expect(acceleratorFromKeyStroke(stroke('Escape', { ctrlKey: true })).kind).toBe('cancel');
  });

  it('reads the physical key, so the binding does not depend on the keyboard layout', () => {
    // `KeyboardEvent.key` on a Thai layout reports Thai characters and on any layout reports a
    // different symbol once Shift is held. `code` is what is printed on the key.
    const shifted = acceleratorFromKeyStroke(stroke('Digit2', { ctrlKey: true, shiftKey: true }));
    expect(shifted).toEqual({ kind: 'ok', accelerator: 'Control+Shift+2' });
  });
});

/**
 * `Shift`-only (or bare) accelerators that swallow a key someone types every day (issue #82).
 *
 * The real config this project ships with binds `snapshot` to `Shift+Space` - holding Shift while
 * tapping Space to type an actual space is an ordinary typing motion, and this is not a `rejected`
 * outcome: the binding must keep working. `caution` is purely informational.
 */
describe('classifyHotkeyCaution: the classification table', () => {
  it.each([
    ['Shift+Space', 'a space'],
    ['Shift+.', 'a period'],
    ['Space', 'a space'],
  ])('flags %s as a caution', (accelerator, typedAs) => {
    expect(classifyHotkeyCaution(accelerator)).toEqual({ reason: 'typing-key', typedAs });
  });

  it.each(['Control+Alt+S', 'F9', 'Shift+F9', 'Alt+A'])('does not flag %s', (accelerator) => {
    expect(classifyHotkeyCaution(accelerator)).toBeUndefined();
  });

  it('is case-insensitive about the modifier, like Electron itself', () => {
    expect(classifyHotkeyCaution('shift+space')).toEqual({ reason: 'typing-key', typedAs: 'a space' });
  });

  it('names a letter and a digit the way a sentence would say them', () => {
    expect(classifyHotkeyCaution('Shift+A')).toEqual({ reason: 'typing-key', typedAs: 'the letter A' });
    expect(classifyHotkeyCaution('Shift+5')).toEqual({ reason: 'typing-key', typedAs: 'the digit 5' });
  });

  it('flags a bare letter too - config can hold a string the capture flow would never produce', () => {
    // `acceleratorFromKeyStroke` refuses a bare non-function key before this is ever reached, but
    // `hotkey-service.ts` runs this over a raw config string that never went through capture at
    // all - and a bare typing key is the most dangerous shape there is, not an exception to flag.
    expect(classifyHotkeyCaution('A')).toEqual({ reason: 'typing-key', typedAs: 'the letter A' });
  });

  it('does not flag a key that produces no character even with no modifier at all', () => {
    expect(classifyHotkeyCaution('Up')).toBeUndefined();
    expect(classifyHotkeyCaution('Tab')).toBeUndefined();
  });
});

describe('acceleratorFromKeyStroke: carries the caution through to the capture flow', () => {
  it('attaches a caution to a captured Shift+Space, and still returns ok', () => {
    const result = acceleratorFromKeyStroke(stroke('Space', { shiftKey: true }));
    expect(result).toEqual({
      kind: 'ok',
      accelerator: 'Shift+Space',
      caution: { reason: 'typing-key', typedAs: 'a space' },
    });
  });

  it('attaches a caution to a captured Shift+period', () => {
    const result = acceleratorFromKeyStroke(stroke('Period', { shiftKey: true }));
    expect(result).toEqual({
      kind: 'ok',
      accelerator: 'Shift+.',
      caution: { reason: 'typing-key', typedAs: 'a period' },
    });
  });

  it('does not attach a caution when a stronger modifier is held', () => {
    const result = acceleratorFromKeyStroke(stroke('Space', { ctrlKey: true, shiftKey: true }));
    expect(result).toEqual({ kind: 'ok', accelerator: 'Control+Shift+Space' });
    expect('caution' in result).toBe(false);
  });
});
