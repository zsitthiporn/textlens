/**
 * The two modes a user chooses between, and how the four internal ones map onto them (#60).
 *
 * ## Why this is a module and not two string literals
 *
 * #60 was filed because the same thing had three different names: the tray said `Snapshot`, the
 * settings window said `Translate once`, and the config key is `hotkeys.snapshot`. A user who read
 * one surface and went looking on another did not find the same word. The config key must not move
 * - renaming it rejects the user's whole file, because the schema is a `strictObject` - so the only
 * remaining fix is that every surface a user reads takes its words from one place. This is that
 * place, and it is in `shared/` for the same reason `accelerator.ts` is: the tray runs in the main
 * process and the settings window runs in a renderer bundle with no Node, and a copy in each is a
 * copy that drifts.
 *
 * ## The model
 *
 * The user chooses between **Auto** and **Translate once**. That is the whole of it.
 *
 *   - `auto` and `paused` are *one* choice. Paused is Auto switched off, not a third mode: it is
 *     reached by clicking Auto again, it really stops the sidecar (#34's CPU criterion), and the
 *     way back is the same click. Presenting it as a peer of the other two is what made the tray
 *     read as a checkbox and an unrelated button.
 *   - `snapshot` is the other choice, and since #60 it holds: entering it stops the loop, so the
 *     frame stays until the user asks for Auto again.
 *   - `idle` is **not a choice**. It is where the app sits before `configure` lands and where a
 *     first run with no region rests (#51). Offering it would be offering the user a mode whose
 *     only meaning is "not set up yet".
 *
 * `active` is "this is the mode you are in", not "the loop is running". In `paused` the Auto choice
 * is active and its label says so, which is the only way the tray can tell paused apart from idle -
 * both have a stopped loop, and only one of them is a state the user asked for.
 */

/**
 * The internal modes, restated.
 *
 * Mirrored rather than imported: `AppMode` lives in `main/services/app-orchestrator.ts`, next to
 * `node:`-adjacent code that must never be pulled into a renderer bundle - the same arrangement
 * `renderer/settings/contract.ts` uses. The drift guard is real rather than a comment:
 * `APP_MODES` is declared `satisfies readonly PresentableMode[]`, so a fifth mode added there fails
 * to compile until it has been given a presentation here.
 */
export type PresentableMode = 'idle' | 'auto' | 'paused' | 'snapshot';

/** What the user actually picks between. Deliberately two. */
export type UserMode = 'auto' | 'once';

/** One of the two choices, as a surface needs to draw it. */
export interface ModeChoice {
  readonly mode: UserMode;
  /**
   * What the user reads. Carries Auto's on/off state, because the alternative - an unchecked box -
   * is indistinguishable from `idle`.
   */
  readonly label: string;
  /** Whether the app is resting in this choice right now. Exactly one is true, or neither. */
  readonly active: boolean;
  /** The `SettingsCommand` / tray action that selects it. Internal names; never shown. */
  readonly command: 'toggleAuto' | 'snapshot';
}

export interface ModePresentation {
  /** Which choice the app is in, or `null` in `idle` - nothing has been chosen yet. */
  readonly choice: UserMode | null;
  /** Whether the capture loop is running. `paused` is `choice: 'auto'` with this false. */
  readonly running: boolean;
  /** The whole state in the user's words: the tray tooltip and the settings window's pill. */
  readonly label: string;
  /** The two choices, in the order every surface shows them. */
  readonly choices: readonly [ModeChoice, ModeChoice];
}

/**
 * The one name for each choice.
 *
 * `Translate once` won over `Snapshot` because it is what the settings window and the hotkey list
 * already said, and because it describes what the user gets rather than what the sidecar does.
 */
export const MODE_NAMES = {
  auto: 'Auto',
  once: 'Translate once',
} as const satisfies Record<UserMode, string>;

/** What Auto is called while it is switched off. See {@link ModeChoice.label}. */
export const PAUSED_LABEL = `${MODE_NAMES.auto} (paused)`;

/** What the app is called before anything has been chosen. Not a mode the user can select. */
export const NOT_STARTED_LABEL = 'not started';

export function describeMode(mode: PresentableMode): ModePresentation {
  const running = mode === 'auto';
  const choice: UserMode | null = mode === 'snapshot' ? 'once' : mode === 'idle' ? null : 'auto';
  const autoLabel = mode === 'paused' ? PAUSED_LABEL : MODE_NAMES.auto;

  return {
    choice,
    running,
    label: choice === null ? NOT_STARTED_LABEL : choice === 'once' ? MODE_NAMES.once : autoLabel,
    choices: [
      { mode: 'auto', label: autoLabel, active: choice === 'auto', command: 'toggleAuto' },
      { mode: 'once', label: MODE_NAMES.once, active: choice === 'once', command: 'snapshot' },
    ],
  };
}
