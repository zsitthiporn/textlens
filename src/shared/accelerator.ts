/**
 * Turn a real keypress into an Electron accelerator (issue M9-02 / #39, feature ST4).
 *
 * ## Why a keypress and not a text field
 *
 * `hotkey-service.ts` documents the trap this module exists to keep away from the user, measured
 * against Electron 43's own `globalShortcut`: an unknown **key** throws, but an unknown
 * **modifier** is silently discarded and whatever is left is bound instead. `Contrl+Alt+A`
 * registers `Alt+A`. `Foo+Bar+A` registers the bare `A` key, process-wide, so every `A` the user
 * types anywhere in Windows is swallowed - and `register` reports success.
 *
 * A settings field that accepts a typed accelerator string is a field in which one dropped
 * character does that. So the rebind UI captures a keystroke and this function is the only thing
 * that ever produces the string, from `KeyboardEvent.code` plus the four modifier flags. Every
 * token it emits comes from a table below, so a token Electron does not recognise cannot be
 * constructed in the first place.
 *
 * ## Why `code` and not `key`
 *
 * `code` is the physical key and does not change with the keyboard layout or with which modifiers
 * are held. `key` on a Thai layout reports Thai characters, and on any layout `Shift+2` reports
 * `"` or `@` depending on the region - none of which Electron would accept as the key half of an
 * accelerator. `KeyR` is `KeyR` everywhere, which is also what the user sees printed on the key.
 *
 * ## Two rules that are not style
 *
 * **At least one modifier, unless it is a function key.** A bare letter registered globally is
 * the exact failure the modifier trap produces by accident, and it should not be reachable
 * deliberately either: it takes that letter away from every other program on the machine. F-keys
 * are exempt because binding a bare `F9` is a normal, deliberate thing to do.
 *
 * **A modifier on its own is not an answer.** Holding Control fires a `keydown` for Control
 * itself; treating that as the end of capture would bind "Control" to something. It returns
 * `pending` so the UI keeps listening while the user reaches for the second key.
 *
 * Pure, DOM-free and `electron`-free: it takes the five fields it needs as a plain object, so it
 * is testable in the Node test environment this project runs and importable from both processes.
 */

/** The part of `KeyboardEvent` this needs. A real event satisfies it structurally. */
export interface KeyStroke {
  /** `KeyboardEvent.code` - the physical key, layout-independent. */
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** The Windows key. */
  readonly metaKey: boolean;
}

export type AcceleratorCapture =
  /** A complete, registerable accelerator. */
  | { readonly kind: 'ok'; readonly accelerator: string }
  /** Only modifiers are down so far; keep listening. */
  | { readonly kind: 'pending' }
  /** The user pressed Escape. Abandon the capture and keep the previous binding. */
  | { readonly kind: 'cancel' }
  /** Nothing registerable can be made of this. `message` is for the field, not the log. */
  | { readonly kind: 'rejected'; readonly message: string };

/**
 * Physical keys that are modifiers. A `keydown` for one of these alone is the user still
 * reaching, not a choice.
 */
const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
]);

/**
 * `KeyboardEvent.code` to the token Electron documents, for every key that is not a plain letter,
 * digit or function key (those three are derived below, since their codes are regular).
 *
 * Written out rather than derived because Electron's key table is not `code` with the prefix
 * removed: `ArrowUp` is `Up`, `Enter` is `Return`, and the numpad is a lowercase `num*` family.
 * A key absent from here and from the three regular families is rejected, which is the point -
 * an accelerator this module cannot name is an accelerator Electron would throw on.
 */
const KEY_CODES: Readonly<Record<string, string>> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Space: 'Space',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  PrintScreen: 'PrintScreen',
  ScrollLock: 'Scrolllock',
  NumLock: 'Numlock',
  CapsLock: 'Capslock',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Numpad0: 'num0',
  Numpad1: 'num1',
  Numpad2: 'num2',
  Numpad3: 'num3',
  Numpad4: 'num4',
  Numpad5: 'num5',
  Numpad6: 'num6',
  Numpad7: 'num7',
  Numpad8: 'num8',
  Numpad9: 'num9',
  NumpadDecimal: 'numdec',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
};

/** `F1`..`F24`, and nothing that merely starts with F. */
function functionKey(code: string): string | undefined {
  const match = /^F([1-9]|1\d|2[0-4])$/.exec(code);
  return match === null ? undefined : code;
}

/** The Electron token for a physical key, or `undefined` when there is not one. */
function keyToken(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const fn = functionKey(code);
  if (fn !== undefined) return fn;
  return KEY_CODES[code];
}

/**
 * Build an accelerator from one keydown.
 *
 * The modifier order is fixed - Control, Alt, Shift, Super - so that the same combination always
 * produces the same string. Two spellings of one binding would compare unequal in config and in
 * the duplicate check `hotkey-service.ts` runs, which would report a key as bound twice when the
 * user pressed it once.
 *
 * `CommandOrControl` is deliberately not emitted. This is a Windows-only app by design (CLAUDE.md
 * invariant 5) and the portable alias would only make the string harder to read back in the file.
 */
export function acceleratorFromKeyStroke(stroke: KeyStroke): AcceleratorCapture {
  if (stroke.code === 'Escape') return { kind: 'cancel' };
  if (MODIFIER_CODES.has(stroke.code)) return { kind: 'pending' };

  const key = keyToken(stroke.code);
  if (key === undefined) {
    return { kind: 'rejected', message: 'that key cannot be used in a shortcut; try another' };
  }

  const modifiers: string[] = [];
  if (stroke.ctrlKey) modifiers.push('Control');
  if (stroke.altKey) modifiers.push('Alt');
  if (stroke.shiftKey) modifiers.push('Shift');
  if (stroke.metaKey) modifiers.push('Super');

  // A global shortcut is registered process-wide: a bare letter takes that letter away from every
  // program on the machine, which is the accident `hotkey-service.ts` documents and not something
  // to make reachable on purpose. A function key is the one shape where a bare binding is normal.
  if (modifiers.length === 0 && functionKey(stroke.code) === undefined) {
    return {
      kind: 'rejected',
      message: 'hold Control, Alt, Shift or Win as well — a shortcut with no modifier would be '
        + 'taken from every other program on this machine',
    };
  }

  return { kind: 'ok', accelerator: [...modifiers, key].join('+') };
}
